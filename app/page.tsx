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
import { cleanTranscript, mdToHtml, splitText } from "@/lib/text";

/* ---------- 타입 & 상수 ---------- */

type SegStatus = "queued" | "working" | "done" | "skipped" | "failed";
type Seg = { id: number; startSec: number; durSec: number; status: SegStatus; text: string; error?: string };
type HistoryItem = { id: string; title: string; date: string; minutes: string; transcript: string; createdAt: number };
type Stage = "partial" | "merge" | "final";

const LS = { pw: "mm-pw", lang: "mm-lang", hist: "mm-history" };
const SILENCE_RMS = 0.0015; // 이보다 조용한 100초 구간은 전사 생략
const TEXT_CHUNK = 3500; // 요약 1회에 보낼 녹취록 글자 수 (Groq 무료 TPM 8K 기준)
const MERGE_LIMIT = 4500;

class AuthError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
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
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "회의록";

/* ---------- 페이지 ---------- */

export default function Home() {
  const [mode, setMode] = useState<"record" | "upload">("record");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today());
  const [lang, setLang] = useState("ko");
  const [pw, setPw] = useState("");

  const [segs, setSegs] = useState<Seg[]>([]);
  const segsRef = useRef<Seg[]>([]);
  const pcmRef = useRef<Map<number, Int16Array>>(new Map());
  const pumping = useRef(false);

  const [recState, setRecState] = useState<"idle" | "recording" | "paused">("idle");
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MicRecorder | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);

  const [transcript, setTranscript] = useState("");
  const editedRef = useRef(false);
  const [minutes, setMinutes] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [fromHistory, setFromHistory] = useState(false);

  const [busy, setBusy] = useState("");
  const [waitMsg, setWaitMsg] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // useCallback 안에서 최신 값을 읽기 위한 ref
  const cfg = useRef({ pw, lang, title });
  cfg.current = { pw, lang, title };

  /* ----- 초기 로드 ----- */
  useEffect(() => {
    setPw(lsGet(LS.pw) || "");
    setLang(lsGet(LS.lang) || "ko");
    try {
      setHistory(JSON.parse(lsGet(LS.hist) || "[]"));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => lsSet(LS.pw, pw), [pw]);
  useEffect(() => lsSet(LS.lang, lang), [lang]);

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
    for (let attempt = 0; attempt < 8; attempt++) {
      const headers = new Headers(init.headers);
      if (cfg.current.pw) headers.set("x-app-password", encodeURIComponent(cfg.current.pw));
      let res: Response;
      try {
        res = await fetch(url, { ...init, headers });
      } catch {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 401) throw new AuthError("비밀번호가 틀렸습니다. 설정에서 접속 비밀번호를 확인해 주세요.");
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const sec = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : Math.min(60, 4 * 2 ** attempt);
        setWaitMsg(`무료 사용 한도에 걸려 ${sec}초 기다린 뒤 다시 시도합니다…`);
        await sleep((sec + 1) * 1000);
        setWaitMsg("");
        continue;
      }
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `요청 실패 (${res.status})`);
    }
    setWaitMsg("");
    throw new Error("여러 번 재시도했지만 실패했습니다. 잠시 후 다시 시도해 주세요.");
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
        const prev = [...segsRef.current].reverse().find((s) => s.id < next.id && s.status === "done" && s.text);
        const fd = new FormData();
        fd.append("file", encodeWav(pcm), "chunk.wav");
        fd.append("prompt", prev ? prev.text.slice(-150) : cfg.current.title);
        fd.append("language", cfg.current.lang);
        try {
          const data = await callApi("/api/transcribe", { method: "POST", body: fd });
          patch(next.id, { status: "done", text: cleanTranscript(data.text || "") });
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
      if (!cfg.current.title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setError(`파일을 읽지 못했습니다. m4a·mp3·wav·webm·mp4 파일을 사용해 주세요. (${(e as Error).message})`);
    } finally {
      setBusy("");
    }
    pump();
  };

  /* ----- 회의록 생성 (긴 회의는 구간 요약 → 병합 → 최종) ----- */
  const summarize = async (stage: Stage, text: string, extra: { part?: number; total?: number } = {}) => {
    const data = await callApi("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, text, title: cfg.current.title || undefined, date, ...extra }),
    });
    const c = (data.content || "").trim();
    if (!c) throw new Error("요약 결과가 비어 있습니다. 다시 시도해 주세요.");
    return c as string;
  };

  const totalSec = segs.reduce((n, s) => n + s.durSec, 0);

  const makeMinutes = async () => {
    const text = transcript.trim();
    if (!text) return;
    setError("");
    setMinutes("");
    try {
      let body: string;
      if (text.length <= TEXT_CHUNK * 1.3) {
        setBusy("회의록을 작성하는 중…");
        body = await summarize("final", text);
      } else {
        const parts = splitText(text, TEXT_CHUNK);
        let notes: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          setBusy(`구간별 요약 중… (${i + 1}/${parts.length})`);
          notes.push(await summarize("partial", parts[i], { part: i + 1, total: parts.length }));
        }
        while (notes.length > 1 && notes.join("\n\n").length > MERGE_LIMIT) {
          const groups: string[][] = [];
          let cur: string[] = [];
          let len = 0;
          for (const n of notes) {
            if (cur.length && len + n.length > MERGE_LIMIT) {
              groups.push(cur);
              cur = [];
              len = 0;
            }
            cur.push(n);
            len += n.length + 2;
          }
          if (cur.length) groups.push(cur);
          if (groups.length >= notes.length) break; // 더 줄일 수 없음
          const merged: string[] = [];
          for (let g = 0; g < groups.length; g++) {
            setBusy(`메모 병합 중… (${g + 1}/${groups.length})`);
            merged.push(groups[g].length === 1 ? groups[g][0] : await summarize("merge", groups[g].join("\n\n")));
          }
          notes = merged;
        }
        setBusy("회의록을 작성하는 중…");
        body = await summarize("final", notes.join("\n\n"));
      }

      const head = [`# ${cfg.current.title || "회의록"}`, "", `- 일시: ${date}`];
      if (totalSec > 0) head.push(`- 녹음 길이: ${fmtTime(totalSec)}`);
      const full = `${head.join("\n")}\n\n${body}\n`;
      setMinutes(full);

      const item: HistoryItem = {
        id: String(Date.now()),
        title: cfg.current.title || "회의록",
        date,
        minutes: full,
        transcript: text,
        createdAt: Date.now(),
      };
      const next = [item, ...history].slice(0, 30);
      setHistory(next);
      lsSet(LS.hist, JSON.stringify(next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      setWaitMsg("");
    }
  };

  /* ----- 기타 액션 ----- */
  const newMeeting = async () => {
    if ((segs.length || transcript) && !minutes && !confirm("작성 중인 내용이 사라집니다. 새 회의를 시작할까요?")) return;
    if (recRef.current) await stopRec();
    pcmRef.current = new Map();
    commit([]);
    editedRef.current = false;
    setTranscript("");
    setMinutes("");
    setTitle("");
    setDate(today());
    setError("");
    setNotice("");
    setElapsed(0);
    setFromHistory(false);
  };

  const openHistory = (h: HistoryItem) => {
    if (recState !== "idle") return;
    pcmRef.current = new Map();
    commit([]);
    editedRef.current = true;
    setTitle(h.title);
    setDate(h.date);
    setTranscript(h.transcript);
    setMinutes(h.minutes);
    setFromHistory(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const deleteHistory = (id: string) => {
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    lsSet(LS.hist, JSON.stringify(next));
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
  const started = segs.length > 0 || recState !== "idle" || !!busy || fromHistory;
  const finished = segs.filter((s) => s.status !== "queued" && s.status !== "working").length;
  const failed = segs.filter((s) => s.status === "failed").length;
  const canSummarize = recState === "idle" && pending === 0 && !busy && transcript.trim().length > 0;

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden />
          <span>회의록 메이커</span>
        </div>
        {started && (
          <button className="btn ghost sm" onClick={newMeeting}>
            새 회의
          </button>
        )}
      </header>

      <section className="card">
        <div className="row">
          <label className="field grow">
            <span>회의 제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 주간 스프린트 회의" />
          </label>
          <label className="field">
            <span>날짜</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <details className="settings">
          <summary>설정</summary>
          <div className="row">
            <label className="field">
              <span>인식 언어</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="ko">한국어</option>
                <option value="auto">자동 감지</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="field grow">
              <span>접속 비밀번호</span>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="서버에 APP_PASSWORD를 설정한 경우"
                autoComplete="current-password"
              />
            </label>
          </div>
        </details>
      </section>

      {error && <div className="alert error">{error}</div>}
      {notice && (
        <div className="alert warn">
          {notice}
          <button className="x" onClick={() => setNotice("")} aria-label="닫기">
            ×
          </button>
        </div>
      )}
      {waitMsg && <div className="alert info">{waitMsg}</div>}

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
                누르면 녹음이 시작되고, 100초마다 자동으로 받아적습니다.
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

      {busy && (
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
              {finished}/{segs.length} 구간 · {fmtTime(totalSec)}
            </span>
          </div>
          <div className="segbar" aria-hidden>
            {segs.map((s) => (
              <span key={s.id} className={`seg ${s.status}`} title={`${fmtTime(s.startSec)} · ${s.status}`} />
            ))}
          </div>
          {failed > 0 && pending === 0 && (
            <div className="row tight">
              <span className="muted">{failed}개 구간을 받아적지 못했습니다.</span>
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
          </div>
          <textarea
            className="transcript"
            value={transcript}
            readOnly={pending > 0 || recState !== "idle"}
            onChange={(e) => {
              editedRef.current = true;
              setTranscript(e.target.value);
            }}
            placeholder={pending > 0 || recState !== "idle" ? "받아적는 중입니다…" : ""}
          />
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
            <button className="btn primary" disabled={!canSummarize} onClick={makeMinutes}>
              {minutes ? "회의록 다시 만들기" : "회의록 만들기"}
            </button>
          </div>
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

      {history.length > 0 && (
        <details className="card history">
          <summary>지난 회의록 ({history.length})</summary>
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <button className="link" onClick={() => openHistory(h)}>
                  <strong>{h.title}</strong>
                  <span className="muted">{h.date}</span>
                </button>
                <button className="x" onClick={() => deleteHistory(h.id)} aria-label="삭제">
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">이 브라우저에만 저장됩니다.</p>
        </details>
      )}

      <footer className="foot">
        음성은 Groq 서버(Whisper large-v3)로 전송되어 텍스트로 변환되고, 요약은 오픈소스 LLM(gpt-oss)이 작성합니다. 사내
        기밀 회의는 회사 보안 정책을 먼저 확인하세요.
      </footer>
    </main>
  );
}
