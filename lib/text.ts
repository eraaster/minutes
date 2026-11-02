/** Whisper가 무음/잡음 구간에서 자주 만들어내는 한국어 환각 문구 */
const HALLUCINATIONS: RegExp[] = [
  /시청\s*해\s*주셔서\s*감사합니다[.!]?/g,
  /구독(과|,)?\s*좋아요[^.!?\n]*[.!?]?/g,
  /(MBC|KBS|SBS|YTN|JTBC)\s*뉴스\s*[가-힣]{2,4}?입니다[.]?/g,
  /자막\s*(제공|제작|by)[^.\n]*[.]?/gi,
  /다음\s*영상에서\s*(만나요|뵙겠습니다)[.!]?/g,
];

function sentencesOf(t: string): string[] {
  return (t.match(/[^.?!。\n]+[.?!。]?/g) || []).map((x) => x.trim()).filter(Boolean);
}

/** 반복 환각 정도 (0~1). 같은 문장이 많이 반복될수록 높음 */
export function repetitionScore(text: string): number {
  const ss = sentencesOf(text).map((x) => x.replace(/\s+/g, ""));
  if (ss.length < 6) {
    // 짧아도 같은 구절이 3번 넘게 이어지면 루프
    return /(.{4,40}?)(\s*\1){3,}/.test(text) ? 1 : 0;
  }
  const uniq = new Set(ss).size;
  return 1 - uniq / ss.length;
}

export function cleanTranscript(text: string): string {
  let t = text;
  for (const re of HALLUCINATIONS) t = t.replace(re, " ");
  // 같은 구절이 붙어서 반복되는 루프 ("수준의 수준의 수준의…") 하나로 줄이기
  // (숫자 "1,000,000,000" 같은 건 건드리지 않도록 글자로 시작하고 공백으로 끝나는 단위만)
  t = t.replace(/([가-힣A-Za-z][^.?!\n]{0,38}?\s+)\1{2,}/g, "$1");
  const count = new Map<string, number>();
  const out: string[] = [];
  for (const s of sentencesOf(t)) {
    const k = s.replace(/\s+/g, "");
    // 의미 없는 짧은 조각 ("Q.", "O. N.") 제거
    if (!/[가-힣]/.test(k) && k.replace(/[^A-Za-z0-9]/g, "").length <= 2) continue;
    const n = (count.get(k) || 0) + 1;
    count.set(k, n);
    if (n > 1) continue; // 같은 문장은 구간 안에서 한 번만
    out.push(s);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** 문단/문장 경계 기준으로 limit 글자 이하 조각으로 나눔 */
export function splitText(text: string, limit: number): string[] {
  const units = text
    .split(/\n+/)
    .flatMap((line) => (line.length <= limit ? [line] : line.match(/[^.?!]+[.?!]?\s*/g) || [line]));
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > limit) {
      out.push(cur.trim());
      cur = "";
    }
    if (u.length > limit) {
      for (let i = 0; i < u.length; i += limit) out.push(u.slice(i, i + limit));
      continue;
    }
    cur += (cur ? "\n" : "") + u;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ---------- 아주 작은 마크다운 렌더러 (회의록 포맷 전용) ---------- */

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** 회의록 전용 마크다운 렌더러: 제목, 불릿(들여쓰기 단계), 번호 목록, 표, 체크박스 */
export function mdToHtml(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const html: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const lead = raw.length - raw.trimStart().length;
    const lvl = Math.min(3, Math.floor(lead / 2));
    const t = line.trim();
    let m: RegExpMatchArray | null;

    // 표
    if (t.startsWith("|")) {
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        const r = splitRow(lines[j]);
        if (!r.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) rows.push(r);
        j++;
      }
      i = j - 1;
      if (!rows.length) continue;
      const [head, ...body] = rows;
      html.push(
        `<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`
      );
      continue;
    }
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      const n = m[1].length;
      html.push(`<h${n}>${inline(m[2])}</h${n}>`);
      continue;
    }
    if (/^-{3,}$/.test(t)) {
      html.push("<hr>");
      continue;
    }
    if ((m = t.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      const done = m[1].toLowerCase() === "x";
      html.push(`<div class="li l${lvl}"><span class="box${done ? " done" : ""}"></span><span>${inline(m[2])}</span></div>`);
      continue;
    }
    if ((m = t.match(/^[-*•]\s+(.*)$/))) {
      html.push(`<div class="li l${lvl}"><span class="mk">${lvl ? "–" : "•"}</span><span>${inline(m[1])}</span></div>`);
      continue;
    }
    if ((m = t.match(/^(\d+[.)]|[①-⑳])\s*(.*)$/))) {
      html.push(`<div class="li l${lvl}"><span class="mk num">${esc(m[1])}</span><span>${inline(m[2])}</span></div>`);
      continue;
    }
    html.push(`<p class="l${lvl}">${inline(t)}</p>`);
  }
  return html.join("\n");
}

/* ---------- 녹취록 교정 검증 · 단어 단위 diff ---------- */

/** 문자 단위 편집거리 기반 유사도 (0~1). 2,800자 구간 기준 O(n·m), 메모리는 두 줄만 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m] / Math.max(n, m);
}

const OMIT_RE = /생략|중략|…|\.\.\./g;
const TS_RE = /\[\d{1,2}:\d{2}(?::\d{2})?\]/g;

/** 교정본을 받아들여도 되는지. 문제가 있으면 이유, 없으면 null */
export function rejectFix(orig: string, fixed: string): string | null {
  if (!fixed.trim()) return "빈 응답";
  if ((fixed.match(OMIT_RE) || []).length > (orig.match(OMIT_RE) || []).length) return "생략 표시 추가";
  const ratio = fixed.length / Math.max(1, orig.length);
  if (ratio < 0.9 || ratio > 1.1) return `길이 변화 ${Math.round(ratio * 100)}%`;
  if ((fixed.match(TS_RE) || []).join() !== (orig.match(TS_RE) || []).join()) return "타임스탬프 변경";
  const sim = similarity(orig, fixed);
  if (sim < 0.85) return `유사도 ${Math.round(sim * 100)}%`;
  return null;
}

export type Hunk = { a0: number; a1: number; before: string; after: string; ctx: string; on: boolean };
export type FixPart = { tokens: string[]; hunks: Hunk[] };

const tokenize = (s: string) => s.match(/\s+|[^\s]+/g) || [];

/** 단어 단위 diff (LCS). 공백 하나로만 떨어진 변경은 한 항목으로 묶음 */
export function wordDiff(orig: string, fixed: string): FixPart {
  const a = tokenize(orig);
  const b = tokenize(fixed);
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W); // L[i][j] = a[i..], b[j..]의 LCS 길이
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);

  type Raw = { a0: number; a1: number; b0: number; b1: number };
  const raw: Raw[] = [];
  let i = 0;
  let j = 0;
  let open: Raw | null = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) raw.push((open = { a0: i, a1: i, b0: j, b1: j }));
    if (j < m && (i >= n || L[i * W + j + 1] >= L[(i + 1) * W + j])) open.b1 = ++j;
    else open.a1 = ++i;
  }
  // 사이에 공백 토큰 하나만 있는 변경은 합침 ("모디건 이" → "모듈원 이" 같은 경우 읽기 쉽게)
  const merged: Raw[] = [];
  for (const r of raw) {
    const p = merged[merged.length - 1];
    if (p && r.a0 - p.a1 === 1 && r.b0 - p.b1 === 1 && /^\s+$/.test(a[p.a1])) {
      p.a1 = r.a1;
      p.b1 = r.b1;
    } else merged.push({ ...r });
  }
  const hunks = merged
    .map((r) => ({
      a0: r.a0,
      a1: r.a1,
      before: a.slice(r.a0, r.a1).join(""),
      after: b.slice(r.b0, r.b1).join(""),
      ctx: a.slice(Math.max(0, r.a0 - 4), r.a0).join("").slice(-16),
      on: true,
    }))
    .filter((h) => h.before.trim() !== h.after.trim()); // 공백만 바뀐 건 무시
  return { tokens: a, hunks };
}

/** 원문 토큰에 켜져 있는(on) 변경만 적용 */
export function applyFix(p: FixPart): string {
  const out: string[] = [];
  let k = 0;
  for (const h of p.hunks) {
    if (!h.on) continue;
    out.push(...p.tokens.slice(k, h.a0), h.after);
    k = h.a1;
  }
  out.push(...p.tokens.slice(k));
  return out.join("");
}
