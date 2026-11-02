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

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const indent = raw.length - raw.trimStart().length >= 2;
    let m: RegExpMatchArray | null;

    if (!line.trim()) {
      close();
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      close();
      const lvl = Math.min(4, m[1].length + 1); // # → h2
      html.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = line.trim().match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      if (list !== "ul") {
        close();
        html.push('<ul class="tasks">');
        list = "ul";
      }
      const done = m[1].toLowerCase() === "x";
      html.push(
        `<li class="task${indent ? " sub" : ""}"><span class="box${done ? " done" : ""}"></span><span>${inline(
          m[2]
        )}</span></li>`
      );
      continue;
    }
    if ((m = line.trim().match(/^[-*]\s+(.*)$/))) {
      if (list !== "ul") {
        close();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li${indent ? ' class="sub"' : ""}>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.trim().match(/^\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") {
        close();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    close();
    html.push(`<p>${inline(line)}</p>`);
  }
  close();
  return html.join("\n");
}
