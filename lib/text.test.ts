import assert from "node:assert/strict";
import { test } from "node:test";
import { whisperPrompt } from "./glossary.ts";
import { stripPromptLeak } from "./text.ts";

const TERMS = ["모듈장", "모듈원", "트러블", "R&R", "아크릴 넥스트", "GPUBASE", "SSH"];
const PROMPT = whisperPrompt("주간회의", TERMS);
const strip = (s: string) => stripPromptLeak(s, PROMPT, TERMS);

test("유출: 증상 문장은 지워짐", () => {
  assert.equal(strip("모듈장, 모듈원, 트러블, R&R, 아크릴 넥스트"), "");
  assert.equal(strip("모듈장, 모듈원, 트러블, R&R, 아크릴 넥스트 모듈장, 모듈원, 트러블, R&R, 아크릴 넥스트."), "");
  assert.equal(strip("모듈장 모듈원 트러블"), "");
});

test("유출: 앞뒤 정상 문장은 남음", () => {
  assert.equal(strip("일정을 봅시다. 모듈장, 모듈원, 트러블, R&R. 다음 안건입니다."), "일정을 봅시다. 다음 안건입니다.");
  assert.equal(strip("r&r, 아크릴넥스트, 트러블. 네 알겠습니다."), "네 알겠습니다.");
});

test("유출: prompt 문장과 80% 이상 일치하면 지움", () => {
  assert.equal(strip(PROMPT), "");
  assert.equal(strip(PROMPT.split(". ")[1]), "");
  assert.equal(strip(`${PROMPT.split(". ")[1].replace("나온다", "나옵니다")} 네 시작합니다.`), "네 시작합니다.");
});

test("정상 문장은 남음", () => {
  for (const s of [
    "GPUBASE에서 SSH가 필요",
    "모듈장, 모듈원 둘 다 참석합니다.",
    "모듈장, 모듈원, 트러블이 문제예요.",
    "새모듈장, 모듈원, 트러블이 있어요.",
    "주간회의.", // 제목만 말한 짧은 발화
  ])
    assert.equal(strip(s), s);
});

test("prompt에 안 넣은 용어와 빈 prompt는 건드리지 않음", () => {
  assert.equal(stripPromptLeak("모듈장, 모듈원, 트러블", "주간회의.", TERMS), "모듈장, 모듈원, 트러블");
  assert.equal(stripPromptLeak("모듈장, 모듈원, 트러블", "", TERMS), "모듈장, 모듈원, 트러블");
});
