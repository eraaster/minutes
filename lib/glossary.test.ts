import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_MAX,
  type GlossaryEntry,
  applyGlossary,
  findGlossary,
  glossaryContext,
  jamoSimilarity,
  migrateTerms,
  normalizeGlossary,
  parseGlossary,
  toJamo,
  whisperPrompt,
} from "./glossary.ts";

const e = (term: string, variants: string[] = [], desc = ""): GlossaryEntry => ({ term, variants, desc });

test("Whisper prompt: 제목 + 메모 앞부분 + 용어, 빈 값은 뺌", () => {
  assert.equal(whisperPrompt("주간회의", "연구소장 진행", ["트러블", "R&R"]), "주간회의. 연구소장 진행. 트러블, R&R");
  assert.equal(whisperPrompt("주간회의", "", ["트러블"]), "주간회의. 트러블");
  assert.equal(whisperPrompt("주간회의", "  \n ", ["트러블"]), "주간회의. 트러블");
  assert.equal(whisperPrompt("", "", []), "");
});

test("Whisper prompt: 200자 이내, 메모는 앞부분만, 용어는 중간에 안 잘림", () => {
  const terms = Array.from({ length: 60 }, (_, i) => `용어${i}`);
  const p = whisperPrompt("제목", "메모 ".repeat(100), terms);
  assert.ok(p.length <= 200);
  assert.ok(p.startsWith("제목. 메모 메모"));
  assert.ok(p.includes("용어0, 용어1"));
  assert.match(p, /용어\d+$/);
  assert.equal(whisperPrompt("가".repeat(300), "", []).length, 200); // 구분자 없는 긴 제목도 비지 않음
});

test("한글을 자모로 분해", () => {
  assert.equal(toJamo("트러블"), "ㅌㅡㄹㅓㅂㅡㄹ");
  assert.equal(toJamo("값A"), "ㄱㅏㅄA");
});

test("트러그 → 트러블 후보", () => {
  const [hit] = findGlossary("어제 트러그가 있었어요", [e("트러블")]);
  assert.equal(hit.kind, "candidate");
  assert.equal(hit.entry.term, "트러블");
  assert.equal(hit.word, "트러그");
  assert.ok(hit.score >= 0.75);
});

test("아크네스 → 아크릴 넥스트 후보", () => {
  const [hit] = findGlossary("아크네스는 다음 달에 나옵니다", [e("아크릴 넥스트")]);
  assert.equal(hit.kind, "candidate");
  assert.equal(hit.entry.term, "아크릴 넥스트");
  assert.equal(hit.word, "아크네스");
});

test("관련 없는 단어는 후보가 아님", () => {
  assert.deepEqual(findGlossary("오늘 회의는 일정 공유입니다", [e("트러블"), e("아크릴 넥스트")]), []);
  assert.ok(jamoSimilarity("회의", "트러블") < 0.75);
});

test("용어·오인식 형태 정확 일치 (대소문자·띄어쓰기 무시, 조사 허용)", () => {
  const g = [e("GPUBASE"), e("아크릴 넥스트"), e("모듈원", ["모디건"])];
  assert.equal(findGlossary("gpubase를 씁니다", g)[0].kind, "exact");
  assert.equal(findGlossary("아크릴넥스트는", g)[0].entry.term, "아크릴 넥스트");
  assert.equal(findGlossary("모디건이", g)[0].entry.term, "모듈원");
});

test("정확 일치는 다른 단어 속을 잡지 않음", () => {
  assert.ok(findGlossary("화장품 이야기", [e("장비", ["장품"])]).every((h) => h.kind !== "exact"));
  assert.deepEqual(findGlossary("send MAIL now", [e("AI")]), []);
});

test("이미 사전에 있는 말은 다른 항목의 후보가 되지 않음", () => {
  const hits = findGlossary("모델을 바꿉니다", [e("모델"), e("모듈")]);
  assert.deepEqual(hits.map((h) => h.entry.term), ["모델"]);
});

test("일치 > 후보 순, 최대 15개", () => {
  const many = Array.from({ length: 20 }, (_, i) => e(`용어${i}`));
  assert.equal(findGlossary(many.map((x) => x.term).join(" "), many).length, 15);
  const hits = findGlossary("트러그 아크릴", [e("트러블"), e("아크릴")]);
  assert.deepEqual(hits.map((h) => h.kind), ["exact", "candidate"]);
  assert.equal(hits[0].entry.term, "아크릴");
});

test("치환: 긴 것부터, 조사 유지", () => {
  const g = [e("아크릴", ["아크"]), e("아크릴 넥스트", ["아크 넥스"])];
  assert.equal(applyGlossary("아크 넥스는 아크로", g).text, "아크릴 넥스트는 아크릴로");
});

test("치환: 이미 맞는 용어를 다시 망가뜨리지 않고 횟수를 셈", () => {
  const r = applyGlossary("아크릴과 아크가", [e("아크릴", ["아크"])]);
  assert.equal(r.text, "아크릴과 아크릴가");
  assert.equal(r.count, 1);
});

test("치환: 단어 중간은 건드리지 않음", () => {
  assert.equal(applyGlossary("화장품, 장품", [e("장비", ["장품"])]).text, "화장품, 장비");
  assert.equal(applyGlossary("MAIL ai", [e("AI", ["ai"])]).text, "MAIL ai");
  assert.equal(applyGlossary("MAIL 에이아이", [e("AI", ["에이아이"])]).text, "MAIL AI");
});

test("첨부문: 후보 표시, 600자 제한, 우선순위", () => {
  const ctx = glossaryContext(findGlossary("트러그 발생", [e("트러블", ["튜러블"], "장애")]));
  assert.equal(ctx, '- 트러블 · 장애 · 오인식: 튜러블 · 녹취의 "트러그"와 발음이 비슷해 이 용어일 수 있음');
  const many = Array.from({ length: 15 }, (_, i) => e(`용어${i}`, [], "설명".repeat(40)));
  const big = glossaryContext(findGlossary(many.map((x) => x.term).join(" "), many));
  assert.ok(big.length <= CONTEXT_MAX);
  assert.ok(big.startsWith("- 용어0 "));
});

test("마이그레이션·정리: 쉼표 사전, 중복 병합, 한 글자 오인식 제거", () => {
  assert.deepEqual(migrateTerms("아크릴, GPUBASE,,아크릴"), [e("아크릴"), e("GPUBASE")]);
  assert.deepEqual(
    normalizeGlossary([e(" 아크릴 ", ["아크", "장", "아크릴"], "옛 설명"), e("아크릴", ["아크", "아크리"], "새 설명")]),
    [e("아크릴", ["아크", "아크리"], "새 설명")]
  );
});

test("JSON 내보내기 → 가져오기, 잘못된 파일은 거부", () => {
  const g = [e("트러블", ["트러그"], "장애")];
  assert.deepEqual(parseGlossary(JSON.stringify(g)), g);
  assert.deepEqual(parseGlossary('[{"term":"A"},{"x":1},null]'), [e("A")]);
  assert.throws(() => parseGlossary('{"term":"A"}'));
  assert.throws(() => parseGlossary("not json"));
});
