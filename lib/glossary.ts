/** 용어 사전: 데이터 정리 · 자동 치환 · 문맥 검색 · AI 요청 첨부문 */

export type GlossaryEntry = { term: string; variants: string[]; desc: string };
export type GlossaryHit = {
  entry: GlossaryEntry;
  kind: "exact" | "candidate";
  word?: string; // 후보일 때, 이 용어와 발음이 비슷한 녹취 속 단어
  score: number;
};

export const CANDIDATE_MIN = 0.75;
export const MAX_HITS = 15;
export const CONTEXT_MAX = 600; // 구간당 첨부 글자 수 (무료 한도)

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const keyOf = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 공백 정리, 같은 용어 병합(오인식 합집합, 설명은 뒤쪽 값 우선), 한 글자 오인식 제거(치환하면 단어가 망가짐) */
export function normalizeGlossary(list: GlossaryEntry[]): GlossaryEntry[] {
  const byKey = new Map<string, GlossaryEntry>();
  for (const e of list) {
    const term = clean(e.term);
    if (!term) continue;
    const k = keyOf(term);
    const cur = byKey.get(k) ?? { term, variants: [], desc: "" };
    byKey.set(k, cur);
    for (const v of (e.variants || []).map(clean)) {
      const vk = keyOf(v);
      if (vk.length >= 2 && vk !== k && !cur.variants.some((x) => keyOf(x) === vk)) cur.variants.push(v);
    }
    cur.desc = clean(e.desc) || cur.desc;
  }
  return [...byKey.values()];
}

/** 예전 쉼표 구분 용어 사전 → 항목 목록 */
export function migrateTerms(terms: string): GlossaryEntry[] {
  return normalizeGlossary(terms.split(/[,，、\n]+/).map((term) => ({ term, variants: [], desc: "" })));
}

/** JSON(내보낸 파일·localStorage) → 항목 목록. 배열이 아니면 throw */
export function parseGlossary(json: string): GlossaryEntry[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error("용어 사전 JSON은 배열이어야 합니다.");
  return normalizeGlossary(
    data
      .filter((x) => x && typeof x.term === "string")
      .map((x) => ({
        term: x.term,
        variants: Array.isArray(x.variants) ? x.variants.filter((v: unknown) => typeof v === "string") : [],
        desc: typeof x.desc === "string" ? x.desc : "",
      }))
  );
}

/**
 * 정규식 조각. 한글은 띄어쓰기가 없어 뒤쪽 경계를 둘 수 없음(조사가 붙음) → 앞쪽만 막아서 "장품"이 "화장품"에 걸리지 않게 함.
 * 영문·숫자는 양쪽 다 막아서 "AI"가 "MAIL"에 걸리지 않게 함
 */
function formPattern(form: string): string {
  const f = clean(form);
  const body = f
    .split(" ")
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const left = /^[A-Za-z0-9]/.test(f) ? "(?<![A-Za-z0-9])" : /^[가-힣]/.test(f) ? "(?<![가-힣])" : "";
  const right = /[A-Za-z0-9]$/.test(f) ? "(?![A-Za-z0-9])" : "";
  return left + body + right;
}

/**
 * 오인식 형태 → 용어 치환 (긴 것부터, 한 번의 패스).
 * 용어 자신도 패턴에 넣어서, 오인식 "아크"가 이미 맞게 쓰인 "아크릴"을 "아크릴릴"로 망가뜨리지 않게 함
 */
export function applyGlossary(text: string, glossary: GlossaryEntry[]): { text: string; count: number } {
  const target = new Map<string, string>();
  const forms: string[] = [];
  for (const e of glossary) {
    target.set(keyOf(e.term), e.term);
    forms.push(e.term);
  }
  for (const e of glossary)
    for (const v of e.variants)
      if (!target.has(keyOf(v))) {
        target.set(keyOf(v), e.term);
        forms.push(v);
      }
  if (forms.length === glossary.length) return { text, count: 0 }; // 오인식 형태 없음
  forms.sort((a, b) => keyOf(b).length - keyOf(a).length);
  const re = new RegExp(forms.map(formPattern).join("|"), "gi");
  let count = 0;
  const out = text.replace(re, (m) => {
    const key = keyOf(m);
    const to = target.get(key);
    if (!to || keyOf(to) === key) return m;
    count++;
    return to;
  });
  return { text: out, count };
}

const WHISPER_MAX = 200;
const MEMO_HEAD = 60; // 용어 자리를 남기기 위해 메모는 앞부분만

/** Whisper 힌트: "회의 제목. 메모 앞부분. 용어1, 용어2, …" 200자 이내 (용어가 중간에 잘리지 않게). 빈 값은 뺌 */
export function whisperPrompt(title: string, memo: string, terms: string[]): string {
  const m = clean(memo);
  const head = m.length <= MEMO_HEAD ? m : m.slice(0, MEMO_HEAD).replace(/\s+\S*$/, "");
  const s = [clean(title), head, terms.join(", ")].filter(Boolean).join(". ");
  if (s.length <= WHISPER_MAX) return s;
  const cut = s.slice(0, WHISPER_MAX);
  return cut.replace(/[,.]?\s*[^,.]*$/, "") || cut;
}

/* ---------- 문맥 검색 ---------- */

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = "ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";

/** 한글 음절을 초성·중성·종성으로 분해 (그 외 문자는 그대로). 받침은 잘 안 들려서 가중치 0.5 */
function decompose(s: string): { chars: string; weights: number[] } {
  let chars = "";
  const weights: number[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) {
      chars += ch;
      weights.push(1);
      continue;
    }
    const jong = c % 28;
    chars += CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)];
    weights.push(1, 1);
    if (jong) {
      chars += JONG[jong - 1];
      weights.push(0.5);
    }
  }
  return { chars, weights };
}
export const toJamo = (s: string) => decompose(s).chars;

/**
 * 자모 유사도 (0~1) = 1 - 삽입·삭제 편집거리 / 두 길이의 합 (받침은 0.5로 셈).
 * 일반 Levenshtein(치환 1, 긴 쪽 길이로 나눔)은 트러그/트러블 0.71, 아크네스/아크릴넥스트 0.57이라
 * 0.75 기준으로 못 잡음. 음절·받침이 빠지는 오인식에 맞춘 식 (= 2·가중 LCS / 가중 길이 합)
 */
export function jamoSimilarity(a: string, b: string): number {
  const x = decompose(a);
  const y = decompose(b);
  if (x.chars === y.chars) return 1;
  if (!x.chars || !y.chars) return 0;
  const m = y.chars.length;
  let prev = new Float32Array(m + 1);
  let cur = new Float32Array(m + 1);
  for (let i = 1; i <= x.chars.length; i++) {
    for (let j = 1; j <= m; j++)
      cur[j] =
        x.chars[i - 1] === y.chars[j - 1]
          ? prev[j - 1] + Math.min(x.weights[i - 1], y.weights[j - 1])
          : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  const sum = (w: number[]) => w.reduce((n, v) => n + v, 0);
  return (2 * prev[m]) / (sum(x.weights) + sum(y.weights));
}

const JOSA =
  /(에서는|에서도|으로는|으로도|에게는|이라고|에서|에게|으로|까지|부터|처럼|보다|이나|라고|하고|이랑|에는|에도|은|는|이|가|을|를|의|에|와|과|도|로|만|랑)$/;
const stripJosa = (w: string) => {
  const s = w.replace(JOSA, "");
  return s.length >= 2 ? s : w;
};

/** 텍스트에서 관련 사전 항목 찾기: 정확 일치 먼저, 그다음 자모 유사 후보 (높은 순), 최대 limit개 */
export function findGlossary(text: string, glossary: GlossaryEntry[], limit = MAX_HITS): GlossaryHit[] {
  const exact: GlossaryHit[] = [];
  const rest: { entry: GlossaryEntry; forms: string[] }[] = [];
  const known = new Set<string>();
  for (const entry of glossary) {
    const forms = [entry.term, ...entry.variants];
    forms.forEach((f) => known.add(keyOf(f)));
    if (forms.some((f) => new RegExp(formPattern(f), "i").test(text))) exact.push({ entry, kind: "exact", score: 1 });
    else rest.push({ entry, forms });
  }

  // 2~6글자 한글 단어 → 표시할 형태(조사 뗀 것). 원형·조사 뗀 형태 둘 다 비교. 사전에 이미 있는 말은 오인식 후보가 아님
  const words = new Map<string, string>();
  for (const w of text.match(/[가-힣]{2,}/g) || []) {
    const s = stripJosa(w);
    if (known.has(w) || known.has(s)) continue;
    if (w.length <= 6) words.set(w, s);
    if (s.length <= 6) words.set(s, s);
  }

  const cands: GlossaryHit[] = [];
  for (const { entry, forms } of rest) {
    let best: GlossaryHit | null = null;
    for (const form of forms) {
      if (!/^[가-힣 ]+$/.test(form)) continue;
      const f = keyOf(form);
      for (const [w, word] of words) {
        const score = jamoSimilarity(w, f);
        if (score >= CANDIDATE_MIN && (!best || score > best.score)) best = { entry, kind: "candidate", word, score };
      }
    }
    if (best) cands.push(best);
  }
  cands.sort((a, b) => b.score - a.score);
  return [...exact, ...cands].slice(0, limit);
}

/** AI 요청에 붙일 "[참고 용어 사전]" 내용. 우선순위대로 담고, max를 넘는 항목은 뺌 */
export function glossaryContext(hits: GlossaryHit[], max = CONTEXT_MAX): string {
  const lines: string[] = [];
  let n = 0;
  for (const { entry, kind, word } of hits) {
    const parts = [entry.term];
    if (entry.desc) parts.push(entry.desc.slice(0, 80));
    if (entry.variants.length) parts.push(`오인식: ${entry.variants.slice(0, 5).join(", ")}`);
    if (kind === "candidate") parts.push(`녹취의 "${word}"와 발음이 비슷해 이 용어일 수 있음`);
    const line = `- ${parts.join(" · ")}`;
    const size = line.length + (lines.length ? 1 : 0);
    if (n + size > max) continue;
    lines.push(line);
    n += size;
  }
  return lines.join("\n");
}
