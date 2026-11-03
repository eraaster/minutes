import assert from "node:assert/strict";
import { test } from "node:test";
import { type Stage, systemPrompt, userPrompt } from "./prompts.ts";
import type { PromptCtx } from "./minutes";

const base: PromptCtx = {
  title: "주간회의",
  dateLabel: "2026-11-02",
  time: "",
  place: "",
  participants: [],
  type: "agenda",
  part: 1,
  total: 1,
};
const STAGES: Stage[] = ["body", "frame", "fix", "regroup"];
const RULE = "녹취에 없는 내용을 배경에서 가져와 회의록에 쓰지 말 것";

for (const stage of STAGES) {
  for (const brief of [false, true]) {
    const label = `${stage}${brief ? " 간결" : ""}`;

    test(`${label}: 메모가 비면 [배경] 섹션도 규칙도 없음`, () => {
      for (const empty of [{}, { background: "", memo: "" }, { background: "  \n ", memo: " " }]) {
        const ctx = { ...base, brief, ...empty };
        const all = systemPrompt(stage, ctx) + userPrompt(stage, "녹취", ctx);
        assert.ok(!all.includes("[배경"), all);
        assert.ok(!all.includes(RULE));
        assert.ok(!all.includes("회사·팀:"));
        assert.ok(!all.includes("이 회의:"));
      }
    });

    test(`${label}: 메모가 있으면 [배경] 첨부 + 규칙`, () => {
      const ctx = { ...base, brief, background: "AI 회사 연구소", memo: "연구소장 진행" };
      const user = userPrompt(stage, "녹취", ctx);
      assert.ok(user.includes("[배경]\n회사·팀: AI 회사 연구소\n이 회의: 연구소장 진행\n"), user);
      assert.ok(systemPrompt(stage, ctx).includes(RULE));
      assert.ok(user.indexOf("[배경]") < user.indexOf("녹취"));
    });
  }
}

test("한쪽만 있으면 그 줄만", () => {
  const u1 = userPrompt("body", "녹취", { ...base, memo: "연구소장 진행" });
  assert.ok(u1.includes("[배경]\n이 회의: 연구소장 진행\n"));
  assert.ok(!u1.includes("회사·팀:"));
  const u2 = userPrompt("frame", "녹취", { ...base, background: "AI 회사" });
  assert.ok(u2.includes("[배경]\n회사·팀: AI 회사\n"));
  assert.ok(!u2.includes("이 회의:"));
});

test("body: 뜻이 안 통하는 말은 생략, 근거 없는 약어 풀이 금지 (상세·간결 모두)", () => {
  for (const brief of [false, true]) {
    const s = systemPrompt("body", { ...base, brief });
    assert.ok(s.includes("의미가 통하지 않는 문장이나 단어는 해석하거나 뜻을 붙이지 말고 생략"));
    assert.ok(s.includes("SST=보안 접속 터미널"));
  }
});

test("body: 공지·전달 사항은 잡담으로 버리지 않음 (상세·간결 모두)", () => {
  for (const brief of [false, true]) assert.ok(systemPrompt("body", { ...base, brief }).includes("운영비·회식·점심·비품"));
});

test("frame: 결정사항은 합의·지시된 것만", () => {
  const s = systemPrompt("frame", base);
  assert.ok(s.includes("실제로 합의·지시된 것만 3~6개"));
  assert.ok(s.includes("논의만 된 것은 결정사항에 넣지 말 것"));
});

test("[회의 정보] 바로 아래에 붙음", () => {
  const u = userPrompt("body", "녹취", { ...base, memo: "메모" });
  assert.ok(u.indexOf("[회의 정보]") < u.indexOf("[배경]"));
  assert.ok(u.indexOf("[배경]") < u.indexOf("[앞 구간 주제]"));
});
