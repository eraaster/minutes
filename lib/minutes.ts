/**
 * 회의록 조립 로직 (클라이언트 전용, 순수 함수)
 *
 * 파이프라인
 *  1) body  : 녹취록을 ~2,800자 구간으로 나눠, 구간마다 "주요내용(상세)" + META(요지·용어·결정·할일…)를 받음
 *  2) frame : META만 모아 회의목적·결정사항·Action Item·역할분담을 받음
 *  3) assemble : 같은 주제 제목끼리 합치고, 회사 회의록 양식(Meeting Result)으로 조립
 */

export type MeetingType = "agenda" | "external" | "weekly";

export const MEETING_TYPES: { value: MeetingType; label: string }[] = [
  { value: "agenda", label: "안건 회의 (내부)" },
  { value: "external", label: "외부 미팅 (고객사·기관)" },
  { value: "weekly", label: "주간회의" },
];

export type MeetingInfo = {
  title: string;
  date: string; // yyyy-mm-dd
  time: string; // "15:25-16:40"
  place: string;
  participants: string[];
  author: string;
  type: MeetingType;
  participantsGuessed?: boolean;
  models?: string[]; // 실제로 쓴 모델 (각주용)
};

/** 서버(프롬프트)로 넘기는 문맥 */
export type PromptCtx = {
  title: string;
  dateLabel: string;
  time: string;
  place: string;
  participants: string[];
  type: MeetingType;
  part?: number;
  total?: number;
  prevTitles?: string[];
  knownTerms?: string[];
  needTitle?: boolean;
  needPeople?: boolean;
  brief?: boolean; // 간결 모드 (토큰 절약)
  glossary?: string; // 이 구간 관련 용어 사전 첨부문 (body·fix)
  background?: string; // 회사·팀 배경 (계정 설정, 선택)
  memo?: string; // 이 회의 메모 (선택)
};

export type Section = { title: string; content: string };

export type Meta = {
  gist: string[];
  terms: [string, string, string][];
  decisions: string[];
  actions: string[][];
  roles: string[][];
  status: string[][];
  feedback: string[];
};

export const emptyMeta = (): Meta => ({
  gist: [],
  terms: [],
  decisions: [],
  actions: [],
  roles: [],
  status: [],
  feedback: [],
});

/* ---------- 유틸 ---------- */

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export function dateLabel(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${m[1]}.${m[2]}.${m[3]}(${DOW[d.getDay()]})`;
}

export function parseParticipants(s: string): string[] {
  return s
    .split(/[,，、\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function normTitle(t: string): string {
  return t
    .replace(/^\s*(\d+[.)]\s*|[○□■●▶·-]\s*)+/, "")
    .replace(/\*\*/g, "")
    // "(계속)", "- 이어서", "(cont.)" 같은 이어쓰기 표시는 같은 주제로 합치기 위해 제거
    .replace(/\s*[-–—:]?\s*[(（\[]?\s*(계속|이어서|continued|cont\.?)\s*[)）\]]?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const key = (t: string) => normTitle(t).replace(/[\s()（）\[\]·,/]/g, "").toLowerCase();

const cells = (s: string) => s.split("|").map((c) => c.trim());

/* ---------- body 결과 파싱 ---------- */

export function parseBody(raw: string): { sections: Section[]; metaLines: string[] } {
  const text = raw.replace(/\r/g, "").replace(/^```[a-z]*\n?|```\s*$/gm, "");
  const idx = text.search(/^\s*=+\s*META\s*=+\s*$/im);
  const body = idx >= 0 ? text.slice(0, idx) : text;
  const metaLines =
    idx >= 0
      ? text
          .slice(idx)
          .split("\n")
          .slice(1)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^#{2,3}\s+(.+)$/); // ## 또는 ### = 주제
    if (h) {
      cur = { title: normTitle(h[1]), content: "" };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      if (!line.trim()) continue;
      cur = { title: "기타 논의", content: "" };
      sections.push(cur);
    }
    cur.content += line + "\n";
  }
  for (const s of sections) s.content = s.content.replace(/^\n+|\s+$/g, "");
  return { sections: sections.filter((s) => s.content), metaLines };
}

export function parseMeta(lines: string[], into: Meta = emptyMeta()): Meta {
  for (const raw of lines) {
    const line = raw.replace(/^[-*]\s*/, "");
    const m = line.match(/^(요지|용어|결정|할일|할 일|역할|현황|피드백)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (/^(없음|해당 ?없음|-)$/.test(v.trim())) continue;
    switch (k) {
      case "요지":
        into.gist.push(v);
        break;
      case "용어": {
        const c = cells(v);
        // 약어·영문 전문용어만 (한글 단어는 음성인식 오류를 용어로 착각하는 경우가 많음)
        const isTerm = /[A-Z]/.test(c[0] || "") && !/[가-힣]/.test(c[0] || "") && (c[0] || "").length <= 30;
        if (isTerm && !into.terms.some((t) => t[0].toLowerCase() === c[0].toLowerCase()))
          into.terms.push([c[0], c[1] || "", c[2] || ""]);
        break;
      }
      case "결정":
        into.decisions.push(v);
        break;
      case "할일":
      case "할 일":
        into.actions.push(cells(v));
        break;
      case "역할":
        into.roles.push(cells(v));
        break;
      case "현황":
        into.status.push(cells(v));
        break;
      case "피드백":
        into.feedback.push(v);
        break;
    }
  }
  return into;
}

/** 같은 주제(제목)는 처음 나온 위치에 이어 붙임 */
export function mergeSections(all: Section[]): Section[] {
  // 바로 앞과 같은 주제일 때만 합침 → 회의 진행 순서 유지
  const out: Section[] = [];
  for (const s of all) {
    const prev = out[out.length - 1];
    if (prev && key(prev.title) === key(s.title)) prev.content += "\n" + s.content;
    else out.push({ ...s });
  }
  return out;
}

/**
 * 안건 과분할 방지: 안건이 6개를 넘으면 짧은 안건(불릿 2개 이하 & 300자 미만)을
 * 맨 끝 "기타 공지 및 논의"로 모음. 제목이 "기타"로 시작하는 안건은 항상 모음.
 * 원래 제목은 "#### ○ 제목"으로 남김.
 */
export const MISC_TITLE = "기타 공지 및 논의";

export function groupMinorSections(sections: Section[]): Section[] {
  const many = sections.length > 6;
  const isMinor = (s: Section) => {
    if (/^기타/.test(s.title)) return true;
    if (!many) return false;
    const bullets = (s.content.match(/^[-*]\s/gm) || []).length;
    return bullets <= 2 && s.content.length < 300;
  };
  const keep = sections.filter((s) => !isMinor(s));
  const minor = sections.filter(isMinor);
  if (!minor.length) return sections;
  const content = minor.map((s) => `#### ○ ${s.title}\n${s.content}`).join("\n\n");
  return [...keep, { title: MISC_TITLE, content }];
}

/* ---------- 기한 검증 (날조 방지) ---------- */

const squash = (s: string) => s.replace(/\s+/g, "");

/** 녹취록에 "11월 30일", "11/30", "11.30" 같은 표현이 있는지 */
function dateInTranscript(m: number, d: number, transcript: string): boolean {
  const M = `0?${m}`;
  const D = `0?${d}`;
  return (
    new RegExp(`(?<!\\d)${M}\\s*월\\s*${D}\\s*일`).test(transcript) ||
    new RegExp(`(?<!\\d)${M}\\s*[/.]\\s*${D}(?!\\d)`).test(transcript)
  );
}

// (2026.)11/30, 11.30, 11월 30일 + 선택적 (요일)
const DATE_RE = /(?:(\d{4})\s*[./-]\s*)?(\d{1,2})\s*(?:[/.]|월)\s*(\d{1,2})(?!\d)\s*일?(\s*[(（]\s*[일월화수목금토]\s*[)）])?/g;

/**
 * 요일 계산. 연도가 없으면 회의 연도 기준이되,
 * 회의일보다 2개월 넘게 이전이면 다음 해로 봄 (12/15 회의의 1/10 → 다음 해 1/10)
 */
function weekday(y: number, m: number, d: number, meeting: Date): string {
  if (y) return DOW[new Date(y, m - 1, d).getDay()];
  const limit = new Date(meeting.getFullYear(), meeting.getMonth() - 2, meeting.getDate());
  let date = new Date(meeting.getFullYear(), m - 1, d);
  if (date < limit) date = new Date(meeting.getFullYear() + 1, m - 1, d);
  return DOW[date.getDay()];
}

/** 녹취록에 "2026년", "26년", "2026"(4자리) 같은 연도 표현이 있는지 */
function yearInTranscript(y: string, transcript: string): boolean {
  const yy = y.length === 4 ? y.slice(2) : y;
  const full = y.length === 4 ? y : `20${y}`;
  return (
    new RegExp(`(?<!\\d)(${full}|${yy})\\s*년`).test(transcript) ||
    new RegExp(`(?<!\\d)${full}(?!\\d)`).test(transcript)
  );
}

// 본문 날짜 표현: A) 2026.11.30 / 2026-11-30 / 2026/11/30  C) (2026년) 11월 (30일)  Y) 2026년  B) 11/30
// + 선택적 (요일). 뒤따르는 "까지/부터/…"는 B가 분수(1/3)가 아니라 날짜인지 판단용 (lookahead)
const BODY_DATE_RE = new RegExp(
  String.raw`(?<![\d/.])(?:` +
    String.raw`(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})(?![\d/.])` +
    String.raw`|(?:(\d{4}|\d{2})\s*년\s*)?(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?` +
    String.raw`|(\d{4}|\d{2})\s*년` +
    String.raw`|(\d{1,2})/(\d{1,2})(?![\d/])` +
    String.raw`)(\s*[(（]\s*[일월화수목금토]\s*[)）])?(?=(\s*(?:까지|부터|경|마감|예정|중|에))?)`,
  "g"
);

/**
 * 본문 속 날짜·연도·월을 녹취록과 대조.
 *  - 월·일 근거 없음 → "(날짜 미정)"
 *  - 연도만 근거 없음 → 연도 부분만 지움
 *  - 근거 있음 + (요일) → 요일을 달력 기준으로 교정
 * 회의 일자 자체는 입력 정보이므로 근거로 인정
 */
export function verifyBodyDates(text: string, transcript: string, meeting: Date): string {
  const ev = `${transcript}\n${meeting.getFullYear()}년 ${meeting.getMonth() + 1}월 ${meeting.getDate()}일`;
  const monthIn = (m: number) => new RegExp(`(?<!\\d)0?${m}\\s*월`).test(ev);
  const MISSING = "(날짜 미정)";

  const out = text.replace(BODY_DATE_RE, (all, ay, am, ad, cy, cm, cd, yo, bm, bd, dow = "", ctx, off: number, src: string) => {
      const base = dow ? all.slice(0, all.length - dow.length) : all;
      const fixDow = (b: string, y: string | undefined, m: number, d: number) =>
        b + (dow ? dow.replace(/[일월화수목금토]/, weekday(y ? Number(y) : 0, m, d, meeting)) : "");

      if (yo) return yearInTranscript(yo, ev) ? all : ""; // 연도만: 근거 없으면 지움

      const y: string | undefined = ay || cy;
      const m = Number(am || cm || bm);
      const d = Number(ad || cd || bd || 0);
      if (m < 1 || m > 12 || d > 31) return all; // 날짜가 아님

      if (bm) {
        // "1/3" 같은 분수와 구분: 요일·"~"·"까지" 등이 붙었거나 0 채움(03/14)일 때만 날짜로 봄
        const dateish = !!dow || !!ctx || src[off - 1] === "~" || /^0/.test(bm) || /^0\d/.test(bd);
        if (dateInTranscript(m, d, ev)) return fixDow(base, undefined, m, d);
        return dateish ? MISSING : all;
      }

      const mdOk = d ? dateInTranscript(m, d, ev) : monthIn(m);
      if (!mdOk) return MISSING;
      const yOk = !y || yearInTranscript(y, ev);
      const b = yOk ? base : base.replace(/^\d+\s*(?:년|[./-])\s*/, "");
      return d ? fixDow(b, yOk ? y : undefined, m, d) : b + dow;
  });
  // 지운 자리에 남은 이중 공백 정리 (줄 앞 들여쓰기는 유지)
  return out === text ? text : out.replace(/(\S) {2,}/g, "$1 ");
}

/** 표의 '기한' 칸 하나를 녹취록과 대조해 고침 */
export function checkDeadline(cell: string, transcript: string, meeting: Date): string {
  const v = cell.trim();
  if (!v || /^[(（]?\s*(미정|-|없음)\s*[)）]?$/.test(v)) return v;
  const flat = squash(transcript);

  const dates = [...v.matchAll(DATE_RE)].filter((m) => {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  });

  if (dates.length && dates.every((m) => dateInTranscript(Number(m[2]), Number(m[3]), transcript))) {
    // 날짜 근거 있음 → 적힌 요일만 회의 연도 달력 기준으로 바로잡음
    return v.replace(DATE_RE, (all, y, mo, d, dow) => {
      if (!dow) return all;
      return all.replace(/[일월화수목금토](?=\s*[)）]\s*$)/, weekday(Number(y), Number(mo), Number(d), meeting));
    });
  }

  // 숫자 날짜가 근거 없음 → 숫자를 걷어낸 나머지 표현(예: "다음 주 금요일")이 녹취에 있으면 그것만 남김
  const rest = (dates.length ? v.replace(DATE_RE, " ") : v)
    .replace(/[()（）\[\]~～]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const core = squash(rest).replace(/까지$/, "");
  return core && flat.includes(core) ? rest : "미정";
}

/** 마크다운 표 중 '기한' 열이 있는 표의 값을 검증 */
export function verifyDeadlines(md: string, transcript: string, meeting: Date): string {
  if (!transcript.trim()) return md;
  let col = -1;
  return md
    .split("\n")
    .map((line) => {
      if (!/^\s*\|/.test(line)) {
        col = -1;
        return line;
      }
      const c = line.trim().replace(/^\||\|$/g, "").split("|");
      if (col < 0) {
        col = c.findIndex((x) => x.trim() === "기한");
        return line;
      }
      if (/^\s*:?-+:?\s*$/.test(c[0] ?? "")) return line; // 구분선
      if (c[col] === undefined) return line;
      c[col] = ` ${checkDeadline(c[col], transcript, meeting)} `;
      return `|${c.join("|")}|`;
    })
    .join("\n");
}

/* ---------- frame 입력 ---------- */

const ROLE_WORD = /^(참석자|발언자|진행자|발표자|사회자|질문자|답변자|청중|전원|모두|미상|불명확|발언자 미상)$/;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 본문의 "- (이름) ..." 패턴에서 발언자 후보 추출 (많이 나온 순)
 *  - 역할 단어(참석자·발표자…), 용어 사전·주요 용어(행사·제품명 등)는 제외
 *  - 녹취록에 "OO님" 형태로 나온 이름만 인정
 */
export function speakerCandidates(sections: Section[], transcript: string, exclude: string[] = []): string[] {
  const ex = new Set(exclude.map((x) => squash(x).toLowerCase()).filter(Boolean));
  const cnt = new Map<string, number>();
  for (const s of sections)
    for (const m of s.content.matchAll(/^\s*[-*]\s*\(([^()\n]{1,20})\)/gm)) {
      const n = m[1].trim().replace(/\s*님$/, "");
      if (!n || ROLE_WORD.test(n) || ex.has(squash(n).toLowerCase())) continue;
      if (!new RegExp(`${escRe(n)}\\s*님`).test(transcript)) continue;
      cnt.set(n, (cnt.get(n) || 0) + 1);
    }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map((e) => e[0]);
}

/** candidates: 참석자를 추정할 때만 넘김 (speakerCandidates 결과) */
export function frameDigest(info: MeetingInfo, sections: Section[], meta: Meta, candidates?: string[]): string {
  const L: string[] = [];
  if (candidates) {
    L.push("[발언자 후보 (녹취에서 \"OO님\"으로 불린 이름)]", candidates.length ? candidates.join(", ") : "없음", "");
  }
  L.push("[안건 (주요내용 제목)]");
  sections.forEach((s, i) => L.push(`${i + 1}. ${s.title}`));
  if (meta.gist.length) L.push("", "[구간별 요지]", ...meta.gist.map((g) => `- ${g}`));
  if (meta.decisions.length) L.push("", "[결정 후보]", ...meta.decisions.map((d) => `- ${d}`));
  if (meta.actions.length) L.push("", "[할일 후보] 할 일 | 담당자 | 기한", ...meta.actions.map((a) => `- ${a.join(" | ")}`));
  if (info.type === "external" && meta.roles.length)
    L.push("", "[역할 후보] 소속 | 담당 | 상세 내용 | 기한", ...meta.roles.map((r) => `- ${r.join(" | ")}`));
  if (info.type === "weekly" && meta.feedback.length)
    L.push("", "[피드백 후보]", ...meta.feedback.map((f) => `- ${f}`));
  const s = L.join("\n");
  return s.length > 6000 ? s.slice(0, 6000) + "\n…(이하 생략)" : s;
}

/* ---------- 최종 조립 ---------- */

export function parseFrame(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const text = raw.replace(/\r/g, "").replace(/^```[a-z]*\n?|```\s*$/gm, "");
  const parts = text.split(/^#{1,2}(?!#)\s*□?\s*/m);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    if (nl < 0) continue;
    const head = p.slice(0, nl).trim();
    const body = p.slice(nl + 1).trim();
    if (!head || !body) continue;
    if (/제목/.test(head)) map.set("title", body.split("\n")[0].replace(/^[-*\s\["'“]+|[\]"'”\s]+$/g, "").trim());
    else if (/참석/.test(head)) map.set("people", body);
    else if (/목적/.test(head)) map.set("purpose", body);
    else if (/결정/.test(head)) map.set("decisions", body);
    else if (/action|할\s*일/i.test(head)) map.set("actions", body);
    else if (/역할/.test(head)) map.set("roles", body);
    else if (/피드백|점검/.test(head)) map.set("feedback", body);
  }
  return map;
}

const esc = (s: string) => (s || "").replace(/\|/g, "/").replace(/\n/g, " ").trim();

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${head.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`),
  ].join("\n");
}

export function assemble(info: MeetingInfo, sections0: Section[], meta: Meta, frameRaw: string, transcript = ""): string {
  const f = parseFrame(frameRaw);
  const md = info.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const meeting = md ? new Date(Number(md[1]), Number(md[2]) - 1, Number(md[3])) : new Date();
  // 본문(안건 제목·주요내용)의 날짜·연도·월을 녹취록과 대조
  const sections = transcript.trim()
    ? sections0.map((s) => ({
        title: verifyBodyDates(s.title, transcript, meeting),
        content: verifyBodyDates(s.content, transcript, meeting),
      }))
    : sections0;
  const out: string[] = [];

  out.push("# Meeting Result", `## [${info.title || "회의"}]`);
  if (info.author) out.push(`작성자: ${info.author}`);

  // 회의 개요
  const ov: string[] = [];
  ov.push(`**일시**: ${dateLabel(info.date)}${info.time ? `, ${info.time}` : ""}`);
  if (info.place) ov.push(`**장소**: ${info.place}`);
  if (info.participants.length)
    ov.push(
      info.participantsGuessed
        ? `**참석자**: 미입력 (녹취에서 이름이 언급된 사람: ${info.participants.join(", ")})`
        : `**참석자**: 총 ${info.participants.length}명\n   - ${info.participants.join(", ")}`
    );
  out.push("", "## □ 회의 개요", ...ov.map((x, i) => `${i + 1}. ${x}`));

  // 회의목적
  out.push("", "## □ 회의목적", f.get("purpose") || meta.gist.map((g) => `- ${g}`).join("\n") || "- (불명확)");

  // 안건
  if (sections.length) out.push("", "## □ 안건", ...sections.map((s, i) => `${i + 1}. ${s.title}`));

  // 주요 용어
  if (meta.terms.length)
    out.push(
      "",
      "## □ 주요 용어",
      table(
        ["No.", "용어", "풀네임", "개념"],
        meta.terms.map((t, i) => [String(i + 1), t[0], t[1], t[2]])
      )
    );

  // 주요내용
  out.push("", "## □ 주요내용");
  sections.forEach((s, i) => out.push("", `### ${i + 1}. ${s.title}`, s.content));

  // 주간회의: 업무 현황 + 피드백
  if (info.type === "weekly") {
    if (meta.status.length)
      out.push(
        "",
        "## □ 업무 현황",
        table(["이름", "업무", "금주 수행 내용", "진행률", "상태", "차주 계획"], meta.status)
      );
    const fb = f.get("feedback") || meta.feedback.map((x) => `- ${x}`).join("\n");
    if (fb) out.push("", "## □ 점검 및 피드백", fb);
  }

  // 결정사항
  const decisions = (f.get("decisions") || meta.decisions.map((d) => `- ${d}`).join("\n") || "- 없음")
    // AI가 붙이는 "미정", "(참석자)", "(발언자)" 접두어 제거
    .replace(/^(\s*[-*]\s*)(\(?(미정|참석자|발언자|미상)\)?\s*)+/gm, "$1");
  out.push("", "## □ 결정사항", decisions);

  // Action Item
  const ai =
    f.get("actions") ||
    (meta.actions.length
      ? table(
          ["No.", "할 일", "담당자", "기한", "완료"],
          meta.actions.map((a, i) => [String(i + 1), a[0], a[1] || "미정", a[2] || "미정", ""])
        )
      : "- 없음");
  out.push("", "## □ Action Item", ai);

  // 외부 미팅: 역할 분담
  if (info.type === "external") {
    let roles = f.get("roles");
    if (!roles && meta.roles.length) {
      const by = new Map<string, string[][]>();
      for (const r of meta.roles) {
        const org = r[0] || "미정";
        if (!by.has(org)) by.set(org, []);
        by.get(org)!.push([r[1] || "미정", r[2] || "", r[3] || "미정"]);
      }
      roles = [...by.entries()].map(([org, rows]) => `### (${org})\n${table(["담당", "상세 내용", "기한"], rows)}`).join("\n\n");
    }
    if (roles) out.push("", "## □ 역할 분담", roles);
  }

  out.push(
    "",
    "---",
    "※ 음성 녹음을 바탕으로 AI가 작성한 초안입니다. 발언자·수치·기한은 참석자 검토 후 확정하세요." +
      (info.models?.length ? ` (작성 모델: ${info.models.join(", ")})` : "")
  );
  return verifyDeadlines(out.join("\n"), transcript, meeting) + "\n";
}

/** 비어 있는 제목·참석자를 frame 결과로 채움. candidates가 있으면 그 안의 이름만 참석자로 인정 */
export function autoFill(info: MeetingInfo, frameRaw: string, candidates?: string[]): MeetingInfo {
  const f = parseFrame(frameRaw);
  const out = { ...info };
  const t = f.get("title");
  const placeholder = /^[\s(（\[]*(미정|미상|없음|불명확|입력되지 않음[^)]*|-)?[\s)）\]]*$/;
  if (!out.title && t && !placeholder.test(t)) out.title = t.slice(0, 80);
  const p = f.get("people");
  if (!out.participants.length && p) {
    const names = p
      .split(/[,，、\n]+/)
      .map((x) => x.replace(/^[-*\s]+/, "").replace(/[()]/g, "").replace(/\s*님$/, "").trim())
      .filter((x) => x && x.length <= 20 && !ROLE_WORD.test(x) && !/^없음$/.test(x))
      .filter((x) => !candidates || candidates.includes(x));
    if (names.length) {
      out.participants = [...new Set(names)];
      out.participantsGuessed = true;
    }
  }
  return out;
}
