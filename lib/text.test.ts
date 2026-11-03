import assert from "node:assert/strict";
import { test } from "node:test";
import { whisperPrompt } from "./glossary.ts";
import { cleanTranscript, stripPromptLeak, stripTermRuns } from "./text.ts";

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

const LIST = "모듈장, 모듈원, 트러블, R&R, 아크릴 넥스트";
const REAL_LEAKS: [string, string][] = [
  [
    `옛날에 CL 접속해서 바로 코딩 할 수 있었다고 한 얘기를 내가 안한 적이 없는데. ${LIST}`,
    "옛날에 CL 접속해서 바로 코딩 할 수 있었다고 한 얘기를 내가 안한 적이 없는데.",
  ],
  [`${LIST} 모든 것들이 다 가능합니다. ${LIST}`, "모든 것들이 다 가능합니다."],
  [`네. ${LIST} ${LIST} 감사합니다.`, "네. 감사합니다."],
];

test("실제 녹취의 유출 문장 3개: 나열만 지워지고 말은 남음", () => {
  const terms = LIST.split(", ");
  for (const [input, want] of REAL_LEAKS) {
    assert.equal(stripPromptLeak(input, LIST, terms), want); // 당시 prompt (쉼표 나열)
    assert.equal(stripPromptLeak(input, whisperPrompt("주간회의", terms), terms), want); // 지금 prompt (문장)
    assert.equal(stripPromptLeak(cleanTranscript(input), LIST, terms), want); // 실제 처리 순서
    assert.equal(stripTermRuns(input, TERMS).text, want); // 저장된 녹취록 정리 (사전 전체 기준)
  }
});

test("저장된 녹취록 정리: 줄바꿈 유지, 안 바뀐 줄은 그대로, 삭제 횟수 반환", () => {
  const input = `[00:00]  첫 줄   그대로.\n${LIST}\n[01:40] ${LIST}\n\n끝. ${LIST}`;
  assert.deepEqual(stripTermRuns(input, TERMS), { text: "[00:00]  첫 줄   그대로.\n\n끝.", count: 3 });
  // 전사 구간 형식: 타임스탬프만 남은 구간은 빈 줄까지 정리
  assert.equal(stripTermRuns(`[00:00] 앞.\n\n[01:40] ${LIST}\n\n[03:20] 뒤.`, TERMS).text, "[00:00] 앞.\n\n[03:20] 뒤.");
  assert.deepEqual(stripTermRuns("GPUBASE에서 SSH가 필요", TERMS), { text: "GPUBASE에서 SSH가 필요", count: 0 });
  assert.deepEqual(stripTermRuns(LIST, []), { text: LIST, count: 0 });
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
