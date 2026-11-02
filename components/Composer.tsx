"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MicRecorder,
  TARGET_RATE,
  concatInt16,
  decodeFileTo16k,
  encodeWav,
  fmtTime,
  rmsInt16,
  splitToChunks,
} from "@/lib/audio";
import { applyGlossary, findGlossary, glossaryContext, normalizeGlossary } from "@/lib/glossary";
import {
  HistoryItem,
  LS,
  addHistory,
  flash,
  lsGet,
  lsSet,
  openAccount,
  requestOpen,
  saveGlossary,
  setActivity,
  useHydrated,
  useStore,
} from "@/lib/store";
import { FixPart, applyFix, cleanTranscript, mdToHtml, rejectFix, splitText, wordDiff } from "@/lib/text";
import {
  MEETING_TYPES,
  MeetingInfo,
  MeetingType,
  PromptCtx,
  Section,
  assemble,
  autoFill,
  dateLabel,
  emptyMeta,
  frameDigest,
  mergeSections,
  groupMinorSections,
  parseBody,
  parseMeta,
  parseParticipants,
  speakerCandidates,
} from "@/lib/minutes";

/* ---------- 타입 & 상수 ---------- */

type SegStatus = "queued" | "working" | "done" | "skipped" | "failed";
type Seg = { id: number; startSec: number; durSec: number; status: SegStatus; text: string; error?: string };

const GROQ_KEYS_URL = "https://console.groq.com/keys";
const SILENCE_RMS = 0.0015; // 이보다 조용한 청크(약 100초)는 전사 생략
const TEXT_CHUNK = 2800; // 회의록 작성 1회에 보낼 녹취록 글자 수 (Groq 무료: 요청당 약 8K 토큰)
const TEXT_CHUNK_BRIEF = 4000; // 간결 모드는 출력이 짧아서 더 크게 → 호출 수·지시문 반복 감소
/** Whisper 힌트: "회의 제목. 용어1, 용어2, …" 200자 이내 (용어가 중간에 잘리지 않게) */
function whisperPrompt(title: string, terms: string): string {
  const s = [title.trim(), terms.trim()].filter(Boolean).join(". ");
  return s.length <= 200 ? s : s.slice(0, 200).replace(/[,.]?\s*[^,.]*$/, "");
}
/** 교정 구간들을 합쳐 녹취록으로 (타임스탬프 앞은 빈 줄) */
const joinFix = (parts: FixPart[]) => parts.map(applyFix).join("\n").replace(/\n+(?=\[\d{1,2}:\d{2})/g, "\n\n");
const shortModel = (m: string) => m.replace(/^(openai|meta-llama|qwen)\//, "");

class AuthError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "회의록";

/* ---------- 작성 화면 (Shell이 항상 마운트해 둠) ---------- */

export default function Composer() {
  const [mode, setMode] = useState<"record" | "upload">("record");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [place, setPlace] = useState("");
  const [people, setPeople] = useState("");
  const [mtype, setMtype] = useState<MeetingType>("agenda");
  const [date, setDate] = useState(today());
  const { author, groqKey, pw, lang } = useStore((s) => s.account);
  const glossary = useStore((s) => s.glossary); // 자동 치환·Whisper prompt·AI 첨부
  const openReq = useStore((s) => s.openRequest);
  const [brief, setBrief] = useState(false);
  const sttFallbackShown = useRef(false);
  const loaded = useHydrated();

  const [segs, setSegs] = useState<Seg[]>([]);
  const segsRef = useRef<Seg[]>([]);
  const pcmRef = useRef<Map<number, Int16Array>>(new Map());
  const pumping = useRef(false);

  const [recState, setRecState] = useState<"idle" | "recording" | "paused">("idle");
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MicRecorder | null>(null);
  const recStartRef = useRef<Date | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);

  const [transcript, setTranscript] = useState("");
  const [preFix, setPreFix] = useState<string | null>(null); // 교정 전 녹취록 (되돌리기용)
  const [fixParts, setFixParts] = useState<FixPart[] | null>(null); // 교정 변경 내역 (항목별 되돌리기)
  const [sel, setSel] = useState(""); // 녹취록에서 드래그로 선택한 단어
  const [reg, setReg] = useState<{ variant: string; term: string; desc: string } | null>(null); // 사전 등록 입력창
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [replQ, setReplQ] = useState("");
  const editedRef = useRef(false);
  const [minutes, setMinutes] = useState("");
  const [fromHistory, setFromHistory] = useState(false);

  const [busy, setBusy] = useState("");
  const [waitMsg, setWaitMsg] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // useCallback 안에서 최신 값을 읽기 위한 ref
  const cfg = useRef({ pw, lang, title, groqKey, glossary });
  cfg.current = { pw, lang, title, groqKey, glossary };
  // "(미정)", "미정", "-" 같은 자리채움 값은 빈칸으로 취급 → AI 자동 입력 대상
  const blank = (v: string) => (/^[\s(（\[]*(미정|없음|미상|tbd|todo|-|\?)?[\s)）\]]*$/i.test(v) ? "" : v.trim());
  const info = (): MeetingInfo => ({
    title: blank(title),
    date,
    time: blank(time),
    place: blank(place),
    participants: parseParticipants(blank(people)),
    author: author.trim(),
    type: mtype,
  });

  /* ----- 초기 로드 ----- */
  useEffect(() => {
    setBrief(lsGet(LS.brief) === "1");
    const t = lsGet(LS.type);
    if (t === "agenda" || t === "external" || t === "weekly") setMtype(t);
  }, []);



  useEffect(() => lsSet(LS.type, mtype), [mtype]);

  /* ----- 세그먼트 상태 관리 ----- */
  const commit = (next: Seg[]) => {
    segsRef.current = next;
    setSegs(next);
  };
  const patch = (id: number, p: Partial<Seg>) =>
    commit(segsRef.current.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const addSeg = (pcm: Int16Array, startSec: number) => {
    const id = segsRef.current.length;
    pcmRef.current.set(id, pcm);
    commit([...segsRef.current, { id, startSec, durSec: pcm.length / TARGET_RATE, status: "queued", text: "" }]);
  };

  // 전사 결과 → 녹취록 (사용자가 직접 수정하기 전까지 자동 갱신)
  useEffect(() => {
    if (editedRef.current) return;
    const t = segs
      .filter((s) => s.status === "done" || s.status === "failed")
      .map((s) => `[${fmtTime(s.startSec)}] ${s.status === "failed" ? "(전사 실패 구간)" : s.text}`)
      .filter((l) => !/\]\s*$/.test(l))
      .join("\n\n");
    setTranscript(t);
  }, [segs]);

  /* ----- API 호출 (무료 한도 429 자동 대기·재시도) ----- */
  const callApi = useCallback(async (url: string, init: RequestInit) => {
    let lastErr = "";
    // 응답 본문에서 에러 메시지 추출 (JSON이 아니면 앞부분 텍스트)
    const errOf = async (res: Response) => {
      const t = await res.text().catch(() => "");
      try {
        const j = JSON.parse(t);
        return String(j.error?.message || j.error || t).slice(0, 300);
      } catch {
        return t.replace(/\s+/g, " ").slice(0, 200) || res.statusText;
      }
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = new Headers(init.headers);
      if (cfg.current.pw) headers.set("x-app-password", encodeURIComponent(cfg.current.pw));
      if (cfg.current.groqKey.trim()) headers.set("x-groq-key", cfg.current.groqKey.trim());
      // 90초 안에 응답이 없으면 끊고 재시도
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        lastErr = ctrl.signal.aborted ? "90초 동안 응답 없음" : `네트워크 오류 (${(e as Error).message})`;
        setWaitMsg(`${lastErr} · ${3 * (attempt + 1)}초 뒤 다시 시도합니다…`);
        await sleep(3000 * (attempt + 1));
        setWaitMsg("");
        continue;
      }
      clearTimeout(timer);
      if (res.ok) return res.json();
      if (res.status === 401) {
        const msg = await errOf(res);
        openAccount("key");
        throw new AuthError(msg || "설정에서 '내 Groq API 키'를 넣거나 접속 비밀번호를 입력해 주세요.");
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const sec = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : Math.min(30, 4 * 2 ** attempt);
        lastErr = `${res.status} ${await errOf(res)}`;
        if (res.status === 429 && sec > 180) {
          const mins = Math.ceil(sec / 60);
          throw new Error(
            `오늘 무료 사용 한도를 모두 썼습니다. 약 ${mins >= 60 ? `${Math.ceil(mins / 60)}시간` : `${mins}분`} 뒤에 다시 시도해 주세요. (녹취록은 그대로 남아 있습니다)`
          );
        }
        // 분당 한도 대기는 대부분 몇 초라 20초 미만이면 조용히 재시도
        if (res.status !== 429) setWaitMsg(`서버 오류(${res.status}) · ${sec}초 뒤 다시 시도합니다…`);
        else if (sec >= 20) setWaitMsg(`잠시 대기 중… ${sec}초`);
        await sleep((sec + 1) * 1000);
        setWaitMsg("");
        continue;
      }
      throw new Error(`${res.status} ${await errOf(res)}`);
    }
    setWaitMsg("");
    throw new Error(`여러 번 재시도했지만 실패했습니다. 마지막 오류: ${lastErr || "알 수 없음"}`);
  }, []);

  /* ----- 전사 큐: 청크를 순서대로 하나씩 처리 ----- */
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (;;) {
        const next = segsRef.current.find((s) => s.status === "queued");
        if (!next) break;
        const pcm = pcmRef.current.get(next.id);
        if (!pcm || rmsInt16(pcm) < SILENCE_RMS) {
          patch(next.id, { status: "skipped" });
          continue;
        }
        patch(next.id, { status: "working" });

        const fd = new FormData();
        fd.append("file", encodeWav(pcm), "chunk.wav");
        // 앞 구간 문장을 힌트로 넘기면 환각이 다음 구간으로 전염됨 → 회의 제목 + 용어 사전만 힌트로
        fd.append("prompt", whisperPrompt(cfg.current.title, cfg.current.glossary.map((e) => e.term).join(", ")));
        fd.append("language", cfg.current.lang);
        try {
          const data = await callApi("/api/transcribe", { method: "POST", body: fd });
          const cleaned = applyGlossary(cleanTranscript(data.text || ""), cfg.current.glossary).text;
          patch(next.id, {
            status: "done",
            text: data.suspect ? (cleaned ? `${cleaned} (※ 인식 불확실 구간)` : "(※ 인식 불확실 구간)") : cleaned,
          });
          if (data.fallbackFrom && !sttFallbackShown.current) {
            sttFallbackShown.current = true;
            setNotice(
              `받아쓰기 모델 한도가 차서 ${shortModel(data.fallbackFrom)} → ${shortModel(data.model)}로 바꿔서 진행 중이에요. (정확도가 조금 낮을 수 있어요)`
            );
          }
        } catch (e) {
          if (e instanceof AuthError) {
            patch(next.id, { status: "queued" });
            setError(e.message);
            break;
          }
          patch(next.id, { status: "failed", error: (e as Error).message });
        }
      }
    } finally {
      pumping.current = false;
    }
  }, [callApi]);

  const retryFailed = () => {
    setError("");
    commit(segsRef.current.map((s) => (s.status === "failed" ? { ...s, status: "queued", error: undefined } : s)));
    pump();
  };

  /* ----- 화면 꺼짐 방지 ----- */
  const requestWake = async () => {
    try {
      if ("wakeLock" in navigator) wakeRef.current = await navigator.wakeLock.request("screen");
    } catch {
      /* ignore */
    }
  };
  const releaseWake = () => {
    wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
  };

  useEffect(() => {
    const onVis = () => {
      if (recState === "idle") return;
      if (document.visibilityState === "visible") {
        requestWake();
        recRef.current?.resumeContext();
      } else {
        setNotice("녹음 중에 화면을 끄거나 다른 앱으로 전환하면 녹음이 끊길 수 있어요. 화면을 켜둔 채로 사용해 주세요.");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [recState]);

  const pending = segs.filter((s) => s.status === "queued" || s.status === "working").length;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (recState !== "idle" || pending > 0 || busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recState, pending, busy]);

  useEffect(() => {
    if (recState === "idle") return;
    const t = setInterval(() => setElapsed(recRef.current?.seconds || 0), 500);
    return () => clearInterval(t);
  }, [recState]);

  /* ----- 녹음 ----- */
  const startRec = async () => {
    setError("");
    setNotice("");
    const rec = new MicRecorder(
      (pcm, startSec) => {
        addSeg(pcm, startSec);
        pump();
      },
      (reason) => setNotice(reason)
    );
    try {
      await rec.start();
    } catch (e) {
      setError(`마이크를 사용할 수 없습니다. 브라우저의 마이크 권한을 허용해 주세요. (${(e as Error).message})`);
      return;
    }
    recRef.current = rec;
    recStartRef.current = new Date();
    setElapsed(0);
    setRecState("recording");
    requestWake();
  };
  const togglePause = () => {
    const rec = recRef.current;
    if (!rec) return;
    const p = recState === "recording";
    rec.setPaused(p);
    setRecState(p ? "paused" : "recording");
  };
  const stopRec = async () => {
    const rec = recRef.current;
    if (!rec) return;
    await rec.stop();
    recRef.current = null;
    setRecState("idle");
    // 날짜·시간 자동 입력 (비어 있을 때만)
    const st = recStartRef.current;
    if (st) {
      setDate(isoDate(st));
      setTime((t) => t || `${hm(st)}-${hm(new Date())}`);
    }
    releaseWake();
    pump();
  };

  /* ----- 파일 업로드 ----- */
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setBusy("오디오를 변환하는 중…");
    try {
      const pcm = await decodeFileTo16k(f);
      const chunks = splitToChunks(pcm);
      if (!chunks.length) throw new Error("오디오가 너무 짧습니다.");
      chunks.forEach((c) => addSeg(c.pcm, c.startSec));
      // 파일 수정 시각(≈녹음 종료) - 길이 = 시작 시각. 비어 있을 때만 채움
      if (f.lastModified) {
        const end = new Date(f.lastModified);
        const start = new Date(f.lastModified - (pcm.length / TARGET_RATE) * 1000);
        setDate(isoDate(start));
        setTime((t) => t || `${hm(start)}-${hm(end)}`);
      }
    } catch (e) {
      setError(`파일을 읽지 못했습니다. m4a·mp3·wav·webm·mp4 파일을 사용해 주세요. (${(e as Error).message})`);
    } finally {
      setBusy("");
    }
    pump();
  };

  /* ----- 회의록 생성 -----
   * 1) body : 녹취록 2,800자 구간마다 주요내용(상세) + META
   * 2) frame: META를 모아 회의목적·결정사항·Action Item(·역할분담)
   * 3) 같은 주제끼리 합쳐서 회사 양식으로 조립
   */
  const callLLM = async (stage: "body" | "frame", text: string, ctx: PromptCtx) => {
    const data = await callApi("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, text, ctx }),
    });
    const c = (data.content || "").trim();
    if (!c) throw new Error("AI 응답이 비어 있습니다. 다시 시도해 주세요.");
    if (data.model) usedModels.current.add(String(data.model));
    if (data.fallbackFrom && !llmFallback.current) {
      llmFallback.current = String(data.fallbackFrom);
      setNotice(
        `${shortModel(data.fallbackFrom)} 무료 한도가 차서 ${shortModel(data.model)} 모델로 넘어갔어요. 글 스타일이 조금 다를 수 있어요.`
      );
    }
    return c as string;
  };
  const usedModels = useRef<Set<string>>(new Set());
  const llmFallback = useRef("");

  /* ----- 녹취록 교정: 2,800자 구간마다 음성인식 오류만 고침 ----- */
  const fixTranscript = async () => {
    const orig = transcript;
    if (!orig.trim()) return;
    setError("");
    const ctxBase = { ...info(), dateLabel: dateLabel(date) } as PromptCtx;
    try {
      const parts = splitText(orig, TEXT_CHUNK);
      const out: FixPart[] = [];
      let rejected = 0;
      let asked = 0;
      for (let i = 0; i < parts.length; i++) {
        setBusy(`녹취록 교정 중… ${Math.round((i / parts.length) * 100)}%`);
        // 사전에 있는 용어로만 교정하므로, 관련 항목이 없는 구간은 AI를 부르지 않음 (한도 절약 + 추측 교정 방지)
        const ref = glossaryContext(findGlossary(parts[i], glossary));
        if (!ref) {
          out.push(wordDiff(parts[i], parts[i]));
          continue;
        }
        asked++;
        const data = await callApi("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: "fix", text: parts[i], ctx: { ...ctxBase, part: i + 1, total: parts.length, glossary: ref } }),
        });
        const fixed = String(data.content || "").trim();
        // 잘림·생략 표시·길이 ±10% 초과·유사도 85% 미만·타임스탬프 변경 → 그 구간은 원문 유지
        const bad = data.truncated ? "잘림" : rejectFix(parts[i], fixed);
        if (bad) rejected++;
        out.push(wordDiff(parts[i], bad ? parts[i] : fixed));
      }
      const n = out.reduce((k, p) => k + p.hunks.length, 0);
      const skip = rejected ? ` · ${rejected}개 구간은 변경이 커서 원문 유지` : "";
      if (!n) {
        setNotice(asked ? `바뀐 부분이 없어요${skip}.` : "녹취록과 관련된 용어가 사전에 없어서 교정할 부분이 없어요. 설정에서 용어 사전을 채워 주세요.");
        return;
      }
      editedRef.current = true;
      setPreFix(orig);
      setFixParts(out);
      setTranscript(joinFix(out));
      setNotice(`녹취록 교정: ${n}곳 수정${skip}. 녹취록 아래 목록에서 하나씩 되돌릴 수 있어요.`);
    } catch (e) {
      setError(`녹취록 교정 실패: ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };
  const undoFix = () => {
    if (preFix === null) return;
    setTranscript(preFix);
    setPreFix(null);
    setFixParts(null);
    setFixParts(null);
  };
  /** 교정 항목 하나만 원문으로 */
  const revertHunk = (pi: number, hi: number) => {
    if (!fixParts) return;
    const next = fixParts.map((p, i) =>
      i !== pi ? p : { ...p, hunks: p.hunks.map((h, j) => (j === hi ? { ...h, on: false } : h)) }
    );
    setFixParts(next);
    setTranscript(joinFix(next));
  };

  const makeMinutes = async () => {
    const text = transcript.trim();
    if (!text) return;
    setError("");
    setMinutes("");
    usedModels.current = new Set();
    llmFallback.current = "";
    const mi = info();
    const base = {
      brief,
      title: mi.title,
      dateLabel: dateLabel(mi.date),
      time: mi.time,
      place: mi.place,
      participants: mi.participants,
      type: mi.type,
    };
    try {
      const parts = splitText(text, brief ? TEXT_CHUNK_BRIEF : TEXT_CHUNK);
      const all: Section[] = [];
      const meta = emptyMeta();
      for (let i = 0; i < parts.length; i++) {
        setBusy(`회의록 작성 중… ${Math.round((i / (parts.length + 1)) * 100)}%`);
        const raw = await callLLM("body", parts[i], {
          ...base,
          part: i + 1,
          total: parts.length,
          // 바로 앞 주제만 이어쓰기 후보로 줌 (예전 주제를 재사용해 순서가 뒤섞이는 것 방지)
          prevTitles: all.length ? [all[all.length - 1].title] : [],
          knownTerms: meta.terms.map((t) => t[0]),
          glossary: glossaryContext(findGlossary(parts[i], glossary)),
        });
        const r = parseBody(raw);
        all.push(...r.sections);
        parseMeta(r.metaLines, meta);
      }
      const sections = groupMinorSections(mergeSections(all));

      setBusy(`회의록 작성 중… ${Math.round((parts.length / (parts.length + 1)) * 100)}% (마무리 정리)`);
      const needTitle = !mi.title;
      const needPeople = !mi.participants.length;
      // 참석자 후보: 녹취에서 "OO님"으로 불린 이름만, 용어 사전·주요 용어는 제외
      const cands = needPeople
        ? speakerCandidates(sections, text, [...glossary.map((e) => e.term), ...meta.terms.map((t) => t[0])])
        : undefined;
      let frame = "";
      try {
        frame = await callLLM("frame", frameDigest(mi, sections, meta, cands), { ...base, needTitle, needPeople });
      } catch (e) {
        if (e instanceof AuthError) throw e;
        // 실패해도 META로 기본 섹션을 채움
      }

      // 비어 있던 제목·참석자는 AI 추정값으로 채우고 입력칸에도 반영
      const fin = autoFill(mi, frame, cands);
      if (needTitle && fin.title) setTitle(fin.title);
      if (needPeople && fin.participants.length) setPeople(fin.participants.join(", "));

      fin.models = [...usedModels.current].map(shortModel);
      const full = assemble(fin, sections, meta, frame, text);
      if (llmFallback.current) {
        setNotice(
          `일부 구간은 ${shortModel(llmFallback.current)} 한도 초과로 다른 모델(${fin.models
            .filter((m) => m !== shortModel(llmFallback.current))
            .join(", ")})이 작성했어요. 회의록 맨 아래에 사용한 모델이 적혀 있어요.`
        );
      }
      setMinutes(full);

      const item: HistoryItem = {
        id: String(Date.now()),
        title: fin.title || "회의록",
        date,
        minutes: full,
        transcript: text,
        createdAt: Date.now(),
      };
      addHistory(item);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      setWaitMsg("");
    }
  };

  /** 녹취록 일괄 변경 (찾아 바꾸기·사전 등록). 전사 중이면 구간 텍스트에도 적용해야 덮어써지지 않음 */
  const rewrite = (fn: (t: string) => string) => {
    if (pending === 0) setPreFix((p) => p ?? transcript);
    commit(segsRef.current.map((s) => ({ ...s, text: fn(s.text) })));
    setFixParts(null);
    setTranscript(fn);
  };
  const findCount = findQ ? transcript.split(findQ).length - 1 : 0;
  const replaceAll = () => {
    if (!findCount) return;
    rewrite((t) => t.split(findQ).join(replQ));
    flash(`${findCount}곳을 바꿨어요.`);
  };
  /** 드래그 선택 → 사전 등록 + 지금 녹취록에 바로 적용 (이번에 등록한 형태만. 다른 용어는 보호) */
  const registerEntry = () => {
    const term = reg?.term.trim();
    if (!reg || !term) return;
    const entry = { term, variants: [reg.variant], desc: reg.desc };
    const next = normalizeGlossary([...glossary, entry]);
    saveGlossary(next);
    const key = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const scoped = next.map((e) => ({ ...e, variants: key(e.term) === key(term) ? [reg.variant.trim()] : [] }));
    const { count } = applyGlossary(transcript, scoped);
    if (count) rewrite((t) => applyGlossary(t, scoped).text);
    flash(`사전에 등록했어요${count ? ` · ${count}곳 적용` : ""}.`);
    setReg(null);
    setSel("");
  };

  // 팝오버: 바깥을 누르면 닫힘
  const regRef = useRef<HTMLFormElement>(null);
  const regOpen = !!reg;
  useEffect(() => {
    if (!regOpen) return;
    regRef.current?.scrollIntoView({ block: "nearest" }); // 모바일에서 등록 버튼이 화면 밖에 있지 않게
    const onDown = (e: MouseEvent) => {
      if (!regRef.current?.contains(e.target as Node)) setReg(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [regOpen]);

  const totalSec = segs.reduce((n, s) => n + s.durSec, 0);

  /* ----- 기타 액션 ----- */
  const newMeeting = async () => {
    if ((segs.length || transcript) && !minutes && !confirm("작성 중인 내용이 사라집니다. 새 회의를 시작할까요?")) return;
    if (recRef.current) await stopRec();
    pcmRef.current = new Map();
    commit([]);
    editedRef.current = false;
    setTranscript("");
    setPreFix(null);
    setFixParts(null);
    setMinutes("");
    sttFallbackShown.current = false;
    setTitle("");
    setTime("");
    setPlace("");
    setPeople("");
    setDate(today());
    setError("");
    setNotice("");
    setElapsed(0);
    setFromHistory(false);
  };

  // 지난 회의록 화면에서 "열기" → 여기로 불러옴 (진행 중 작업 확인은 그 화면에서 함)
  useEffect(() => {
    if (!openReq) return;
    openHistory(openReq);
    requestOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq]);
  const openHistory = (h: HistoryItem) => {
    if (recState !== "idle") return;
    setReg(null);
    setSel("");
    pcmRef.current = new Map();
    commit([]);
    editedRef.current = true;
    setTitle(h.title);
    setDate(h.date);
    setTranscript(h.transcript);
    setPreFix(null);
    setFixParts(null);
    setMinutes(h.minutes);
    setFromHistory(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const copyMinutes = async () => {
    try {
      await navigator.clipboard.writeText(minutes);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("복사에 실패했습니다. .md 다운로드를 이용해 주세요.");
    }
  };
  const baseName = `${date}_${safeName(title)}`;
  const saveAudio = () => {
    const parts = [...pcmRef.current.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    if (parts.length) download(`${baseName}.wav`, encodeWav(concatInt16(parts)));
  };

  /* ----- 화면 상태 ----- */
  useEffect(() => {
    setActivity({
      recording: recState !== "idle",
      working: pending > 0 || !!busy,
      dirty: (segs.length > 0 || !!transcript) && !minutes,
    });
  }, [recState, pending, busy, segs.length, transcript, minutes]);
  const started = segs.length > 0 || recState !== "idle" || !!busy || fromHistory;
  // 받아쓰기 진행률 (%) — 녹음 길이 기준
  const doneSec = segs.filter((s) => s.status !== "queued" && s.status !== "working").reduce((n, s) => n + s.durSec, 0);
  const sttPct = totalSec > 0 ? Math.min(100, Math.round((doneSec / totalSec) * 100)) : 0;
  const failed = segs.filter((s) => s.status === "failed").length;
  const genBusy = busy.startsWith("회의록") || busy.startsWith("녹취록 교정");
  const canSummarize = recState === "idle" && pending === 0 && !busy && transcript.trim().length > 0;

  return (
    <>
      {started && (
        <div className="composehead">
          <button className="btn ghost sm" onClick={newMeeting}>
            새 회의
          </button>
        </div>
      )}

      <section className="card">
        <div className="row">
          <label className="field grow">
            <span>회의 제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="비워두면 AI가 녹취 내용으로 지음" autoComplete="off" />
          </label>
          <label className="field">
            <span>날짜</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div className="row mt">
          <label className="field">
            <span>회의 유형</span>
            <select value={mtype} onChange={(e) => setMtype(e.target.value as MeetingType)}>
              {MEETING_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>시간</span>
            <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="녹음·업로드 시 자동" autoComplete="off" />
          </label>
          <label className="field grow">
            <span>장소</span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="7층 대회의실" autoComplete="off" />
          </label>
        </div>
        <label className="field mt">
          <span>참석자 (쉼표로 구분 · 직접 넣으면 발언자 표기가 더 정확함)</span>
          <input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="비워두면 AI가 녹취에서 추정 · 예: 대표님, Jonathan, Daniel"
            autoComplete="off"
            name="mm-participants" />
        </label>
      </section>

      {loaded && !groqKey.trim() && !pw && (
        <section className="card onboard">
          <strong>처음이신가요? 무료 키 하나만 있으면 돼요</strong>
          <ol>
            <li>
              <a href={GROQ_KEYS_URL} target="_blank" rel="noopener noreferrer">
                Groq 콘솔
              </a>
              에 구글 계정으로 가입 (카드 등록 없음)
            </li>
            <li>
              <b>Create API Key</b> → 이름 아무거나 → 생성된 <code>gsk_…</code> 키 복사
            </li>
            <li>
              오른쪽 위 <b>사용자 칩 → 내 Groq API 키</b>에 붙여넣기
            </li>
          </ol>
          <div className="actions">
            <button className="btn" onClick={() => openAccount("key")}>
              키 입력하기
            </button>
            <a className="btn primary" href={GROQ_KEYS_URL} target="_blank" rel="noopener noreferrer">
              무료 키 발급받기 ↗
            </a>
          </div>
        </section>
      )}

      {error && <div className="alert error">{error}</div>}
      {notice && (
        <div className="alert warn">
          {notice}
          <button className="x" onClick={() => setNotice("")} aria-label="닫기">
            ×
          </button>
        </div>
      )}
      {waitMsg && !genBusy && <div className="alert info">{waitMsg}</div>}

      {/* 1. 입력 방식 선택 */}
      {!started && (
        <section className="card">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={mode === "record"} onClick={() => setMode("record")}>
              바로 녹음
            </button>
            <button role="tab" aria-selected={mode === "upload"} onClick={() => setMode("upload")}>
              파일 업로드
            </button>
          </div>

          {mode === "record" ? (
            <div className="center">
              <button className="recbtn" onClick={startRec} aria-label="녹음 시작">
                <span className="mic" />
              </button>
              <p className="hint">
                누르면 녹음이 시작되고, 약 100초마다 자동으로 받아적습니다.
                <br />
                휴대폰은 <b>화면을 켜둔 채</b> 사용하세요.
              </p>
            </div>
          ) : (
            <label
              className={`drop${dragOver ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                onFile(e.dataTransfer.files?.[0]);
              }}
            >
              <input
                type="file"
                accept="audio/*,video/*,.m4a,.mp3,.wav,.webm,.mp4,.aac,.ogg"
                onChange={(e) => onFile(e.target.files?.[0])}
                hidden
              />
              <strong>음성 파일 선택</strong>
              <span>아이폰 음성 메모(.m4a), mp3, wav, 회의 녹화(mp4) 등</span>
            </label>
          )}
        </section>
      )}

      {/* 2. 녹음 중 */}
      {recState !== "idle" && (
        <section className="card recording">
          <div className="recstatus">
            <span className={`pulse${recState === "paused" ? " paused" : ""}`} />
            <span className="timer">{fmtTime(elapsed)}</span>
            <span className="muted">{recState === "paused" ? "일시정지" : "녹음 중"}</span>
          </div>
          <div className="actions">
            <button className="btn" onClick={togglePause}>
              {recState === "paused" ? "계속 녹음" : "일시정지"}
            </button>
            <button className="btn danger" onClick={stopRec}>
              녹음 종료
            </button>
          </div>
        </section>
      )}

      {busy && !genBusy && (
        <div className="alert info">
          <span className="spinner" /> {busy}
        </div>
      )}

      {/* 3. 전사 진행 상황 */}
      {segs.length > 0 && (
        <section className="card">
          <div className="sectionhead">
            <h2>받아쓰기</h2>
            <span className="muted">
              {recState !== "idle" ? "녹음 중 · " : ""}
              <b className="pct">{sttPct}%</b>
              {sttPct === 100 && recState === "idle" ? " 완료" : ""} · 녹음 {fmtTime(totalSec)}
            </span>
          </div>
          <div className="progress" role="progressbar" aria-valuenow={sttPct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${sttPct}%` }} />
          </div>
          {failed > 0 && pending === 0 && (
            <div className="row tight">
              <span className="muted">
                {failed}개 구간을 받아적지 못했습니다.
                {[...new Set(segs.filter((x) => x.status === "failed" && x.error).map((x) => x.error))]
                  .slice(0, 2)
                  .map((m) => (
                    <span key={m} className="errline">
                      원인: {m}
                    </span>
                  ))}
              </span>
              <button className="btn sm" onClick={retryFailed}>
                실패 구간 재시도
              </button>
            </div>
          )}
        </section>
      )}

      {/* 4. 녹취록 */}
      {(transcript || segs.length > 0) && (
        <section className="card">
          <div className="sectionhead">
            <h2>녹취록</h2>
            <span className="muted">{transcript.length.toLocaleString()}자 · 직접 수정 가능</span>
            <span className="headbtns">
              {preFix !== null && !busy && pending === 0 && (
                <button className="btn ghost sm" onClick={undoFix} title="변경 전 녹취록으로 되돌리기">
                  되돌리기
                </button>
              )}
              <button
                className="btn ghost sm"
                disabled={!sel}
                onClick={() => setReg({ variant: sel, term: sel, desc: "" })}
                title="녹취록에서 단어를 드래그해 선택하면 켜져요"
              >
                사전에 등록
              </button>
              <button className="btn ghost sm" disabled={pending > 0} onClick={() => setFindOpen((v) => !v)}>
                찾아 바꾸기
              </button>
              <button
                className="btn sm"
                disabled={!canSummarize}
                onClick={fixTranscript}
                title="AI가 용어 사전을 참고해 음성인식 오류만 고쳐요 (내용은 바꾸지 않음)"
              >
                녹취록 교정
              </button>
            </span>
            {reg && (
              <form
                ref={regRef}
                className="popover"
                aria-label="사전에 등록"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setReg(null);
                }}
                onSubmit={(e) => {
                  e.preventDefault();
                  registerEntry();
                }}
              >
                <label className="field">
                  <span>올바른 용어</span>
                  <input value={reg.term} onChange={(e) => setReg({ ...reg, term: e.target.value })} autoComplete="off" autoFocus onFocus={(e) => e.target.select()} />
                </label>
                <label className="field">
                  <span>잘못 받아쓴 형태</span>
                  <input value={reg.variant} onChange={(e) => setReg({ ...reg, variant: e.target.value })} autoComplete="off" />
                </label>
                <label className="field">
                  <span>설명 (선택)</span>
                  <input value={reg.desc} onChange={(e) => setReg({ ...reg, desc: e.target.value })} autoComplete="off" />
                </label>
                <div className="actions">
                  <button type="button" className="btn ghost sm" onClick={() => setReg(null)}>
                    취소
                  </button>
                  <button type="submit" className="btn primary sm" disabled={!reg.term.trim()}>
                    등록
                  </button>
                </div>
              </form>
            )}
          </div>
          {findOpen && (
            <form
              className="tools"
              onSubmit={(e) => {
                e.preventDefault();
                replaceAll();
              }}
            >
              <input aria-label="찾을 말" value={findQ} onChange={(e) => setFindQ(e.target.value)} placeholder="찾을 말" autoComplete="off" />
              <input aria-label="바꿀 말" value={replQ} onChange={(e) => setReplQ(e.target.value)} placeholder="바꿀 말" autoComplete="off" />
              <span className="muted">{findCount}곳</span>
              <button type="submit" className="btn sm" disabled={!findCount || pending > 0}>
                모두 바꾸기
              </button>
            </form>
          )}
          <textarea
            className="transcript"
            value={transcript}
            readOnly={pending > 0 || recState !== "idle"}
            onSelect={(e) => {
              const el = e.currentTarget;
              const s = el.value.slice(el.selectionStart, el.selectionEnd).trim();
              setSel(s.length <= 40 && !s.includes("\n") ? s : "");
            }}
            onChange={(e) => {
              editedRef.current = true;
              setFixParts(null); // 직접 고치면 항목별 되돌리기 목록은 닫음 (전체 되돌리기는 유지)
              setTranscript(e.target.value);
            }}
            placeholder={pending > 0 || recState !== "idle" ? "받아적는 중입니다…" : ""}
          />
          {fixParts && fixParts.some((p) => p.hunks.some((h) => h.on)) && (
            <details className="fixlist" open>
              <summary>바뀐 부분 {fixParts.reduce((k, p) => k + p.hunks.filter((h) => h.on).length, 0)}곳</summary>
              <ul>
                {fixParts.flatMap((p, pi) =>
                  p.hunks.map((h, hi) =>
                    h.on ? (
                      <li key={`${pi}-${hi}`}>
                        <span className="muted">…{h.ctx}</span>
                        <del>{h.before.trim() || "(없음)"}</del> → <ins>{h.after.trim() || "(삭제)"}</ins>
                        <button className="btn ghost sm" disabled={!!busy} onClick={() => revertHunk(pi, hi)}>
                          되돌리기
                        </button>
                      </li>
                    ) : null
                  )
                )}
              </ul>
            </details>
          )}
          <div className="actions">
            {transcript && (
              <button className="btn ghost" onClick={() => download(`${baseName}_녹취록.txt`, new Blob([transcript]))}>
                녹취록 .txt
              </button>
            )}
            {pcmRef.current.size > 0 && recState === "idle" && (
              <button className="btn ghost" onClick={saveAudio}>
                녹음 파일 .wav
              </button>
            )}
            <label className="toggle" title="지시문과 출력을 짧게 해서 무료 한도를 아껴요">
              <input
                type="checkbox"
                checked={brief}
                onChange={(e) => {
                  setBrief(e.target.checked);
                  lsSet(LS.brief, e.target.checked ? "1" : "0");
                }}
              />
              <span>간결 모드 (토큰 절약)</span>
            </label>
            <button className="btn primary" disabled={!canSummarize} onClick={makeMinutes}>
              {minutes ? "회의록 다시 만들기" : "회의록 만들기"}
            </button>
          </div>
          {genBusy && (
            <div className="genstatus">
              <div className="alert info">
                <span className="spinner" /> {busy}
              </div>
              {waitMsg && <div className="alert info soft">{waitMsg}</div>}
            </div>
          )}
        </section>
      )}

      {/* 5. 회의록 */}
      {minutes && (
        <section className="card minutes">
          <div className="sectionhead">
            <h2>회의록</h2>
            <div className="actions inline">
              <button className="btn sm" onClick={copyMinutes}>
                {copied ? "복사됨" : "복사"}
              </button>
              <button className="btn sm" onClick={() => download(`${baseName}_회의록.md`, new Blob([minutes]))}>
                .md
              </button>
            </div>
          </div>
          <article className="doc" dangerouslySetInnerHTML={{ __html: mdToHtml(minutes) }} />
        </section>
      )}

    </>
  );
}
