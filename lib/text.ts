/** Whisper가 무음/잡음 구간에서 자주 만들어내는 한국어 환각 문구 */
const HALLUCINATIONS: RegExp[] = [
  /시청\s*해\s*주셔서\s*감사합니다[.!]?/g,
  /구독(과|,)?\s*좋아요[^.!?\n]*[.!?]?/g,
  /(MBC|KBS|SBS|YTN|JTBC)\s*뉴스\s*[가-힣]{2,4}?입니다[.]?/g,
  /자막\s*(제공|제작|by)[^.\n]*[.]?/gi,
  /다음\s*영상에서\s*(만나요|뵙겠습니다)[.!]?/g,
];

export function cleanTranscript(text: string): string {
  let t = text;
  for (const re of HALLUCINATIONS) t = t.replace(re, " ");
  // 같은 문장이 반복되는 루프 현상 제거
  const sentences = t.match(/[^.?!。\n]+[.?!。]?/g) || [];
  const out: string[] = [];
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (out.length && out[out.length - 1] === trimmed) continue;
    out.push(trimmed);
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
