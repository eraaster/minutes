import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRegroup, parseRegroup, regroupDigest, type Section } from "./minutes.ts";

const sec = (title: string, content = `${title} 내용`): Section => ({ title, content });

test("재구성: 첫 등장 순으로 합치고 원래 제목을 소제목으로 남김", () => {
  const all = [sec("GPU 예약"), sec("휴가 공지"), sec("GPU 장애"), sec("GPU 예약", "예약 추가")];
  const map = parseRegroup('{"GPU 예약":"GPU 운영","GPU 장애":"GPU 운영","휴가 공지":"인사 공지"}', all.map((s) => s.title))!;
  const out = applyRegroup(all, map);
  assert.deepEqual(out.map((s) => s.title), ["GPU 운영", "인사 공지"]);
  assert.equal(out[0].content, "#### ○ GPU 예약\nGPU 예약 내용\n\n#### ○ GPU 장애\nGPU 장애 내용\n\n#### ○ GPU 예약\n예약 추가");
  assert.equal(out[1].content, "휴가 공지 내용"); // 하나만 옮겨 오면 소제목 없음
});

test("재구성: 코드 블록·설명이 섞인 응답도 파싱, 키의 공백·괄호 차이는 무시", () => {
  const map = parseRegroup('결과:\n```json\n{"GPU  예약":"GPU 운영"}\n```', ["GPU 예약"])!;
  assert.equal(map.get("gpu예약"), "GPU 운영");
});

test("재구성: 응답에서 빠진 제목도 내용을 잃지 않음", () => {
  const all = [sec("A"), sec("B"), sec("C")];
  const out = applyRegroup(all, parseRegroup('{"A":"묶음","B":"묶음"}', all.map((s) => s.title))!);
  assert.deepEqual(out.map((s) => s.title), ["묶음", "C"]);
  assert.ok(out[1].content.includes("C 내용"));
});

test("재구성: 파싱 실패·형식 오류·안건 초과면 null (폴백)", () => {
  const titles = ["A", "B"];
  for (const raw of ["응답 없음", '{"A":', "[1,2]", '{"A":1}', '{"모르는 제목":"새 안건"}']) assert.equal(parseRegroup(raw, titles), null, raw);
  const many = Array.from({ length: 8 }, (_, i) => `주제${i}`);
  const json = JSON.stringify(Object.fromEntries(many.map((t) => [t, `새 ${t}`])));
  assert.equal(parseRegroup(json, many), null);
});

test("재구성 요청문: 제목은 전부, 요지는 들어가는 만큼만", () => {
  assert.equal(regroupDigest([sec("A")], ["요지"]), ""); // 합칠 게 없음
  const d = regroupDigest([sec("A"), sec("B")], Array(1000).fill("긴 요지입니다"));
  assert.ok(d.startsWith("[안건 제목]\nA\nB\n\n[구간별 요지]"));
  assert.ok(d.length <= 6000);
  assert.equal(regroupDigest([sec("가".repeat(4000)), sec("나".repeat(4000))], []), ""); // 제목만으로 넘침
});
