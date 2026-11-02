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
