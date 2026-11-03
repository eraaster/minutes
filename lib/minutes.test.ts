import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRegroup,
  assemble,
  emptyMeta,
  finalizeAgendas,
  groupMinorSections,
  mergeSections,
  parseRegroup,
  regroupDigest,
  regroupLost,
  regroupSections,
  type Section,
  stripUnfoundedGloss,
} from "./minutes.ts";

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

const INFO = { title: "회의", date: "2026-11-03", time: "", place: "", participants: [], author: "", type: "agenda" as const };

test("재구성: 매핑이 일부 제목을 빠뜨려도 운영비·회식·점심 믹싱·청소기가 회의록에 남음", () => {
  const dropped = ["운영비", "11월 회식", "점심 믹싱", "청소기"];
  const work = ["GPU 예약", "SSH 장애", "모듈 협의", "R&R 정리", "넥스트 행사", "채용"];
  const all = [...work.slice(0, 3), ...dropped, ...work.slice(3)].map((t) => sec(t, `- (참석자) ${t} 고유내용`));
  const raw = JSON.stringify(Object.fromEntries(work.map((t) => [t, "업무"])));
  const out = regroupSections(all, raw);
  assert.deepEqual(out.map((s) => s.title), ["업무", ...dropped]); // 빠진 제목은 원래 제목 그대로, 등장 순서대로
  const md = assemble(INFO, groupMinorSections(out), emptyMeta(), "", "11월 회식 얘기");
  for (const t of [...work, ...dropped]) assert.ok(md.includes(`${t} 고유내용`), t);
});

test("재구성: 불릿 수나 글자 수가 줄면 유실로 판단, 소제목 추가는 늘어난 걸로 안 침", () => {
  const before = [sec("A", "- 하나\n- 둘"), sec("B", "- 셋")];
  assert.equal(regroupLost(before, [sec("묶음", "- 하나\n- 둘\n- 셋")]), false);
  assert.equal(regroupLost(before, [sec("묶음", "#### ○ A\n- 하나\n- 둘")]), true); // 소제목으로 글자가 늘어도 불릿 유실
  assert.equal(regroupLost(before, [sec("묶음", "#### ○ 아주 긴 소제목입니다\n- 하나\n- 둘\n- ")]), true); // 불릿 수는 같아도 글자 유실
});

test("재구성: 파싱 실패면 원래 안건 그대로", () => {
  const all = [sec("A"), sec("B")];
  assert.equal(regroupSections(all, "모르겠습니다"), all);
});

const bullets = (...items: string[]) => items.map((x) => `- (참석자) ${x}`).join("\n");

test("안건 마무리: 실제 사례 — 기타에 몰린 주제를 꺼내고, 진행 순서로 놓고, 중복 불릿은 먼저 나온 것만", () => {
  const all = [
    sec("신규 참석자 안내", bullets("레비님 헝가리 출장 후 내일 출근", "신규 참석자 개인 질문 안내", "자리 배치 공유")),
    sec("아크릴 넥스트", bullets("넥스트 일정 공유", "넥스트 발표자 모집", "넥스트 주제 논의")),
    sec("GPUBASE 일정", bullets("릴리스 일정 확인", "테스트 범위 논의", "배포 담당 확인")),
    sec("월간 프로젝트 공유", "- (대표) 월간 공유 방식 변경\n  - 격주 발표로 변경\n  - 자료는 사전 공유"),
    sec("종합원 현황", bullets("종합원 인원 현황", "종합원 채용 진행", "종합원 자리 이동")),
    sec("상호 존중", bullets("회의 중 발언 존중", "호칭 사용 원칙", "피드백 방식 논의")),
    sec("전달 사항", bullets("레비님 헝가리 출장 후 내일 출근합니다", "신규 참석자 개인 질문 안내")),
    sec("청소기", bullets("청소기 교체 예정 공지")),
  ];
  const origin = mergeSections(all);
  const misc = "기타 공지 및 논의";
  const raw = JSON.stringify({
    "신규 참석자 안내": "온보딩",
    "GPUBASE 일정": "제품 일정",
    "아크릴 넥스트": misc,
    "월간 프로젝트 공유": misc,
    "종합원 현황": misc,
    "상호 존중": misc,
    "전달 사항": misc,
    "청소기": misc,
  });
  const out = finalizeAgendas(groupMinorSections(regroupSections(origin, raw)), origin);
  assert.deepEqual(out.map((s) => s.title), ["온보딩", "아크릴 넥스트", "제품 일정", "월간 프로젝트 공유", "종합원 현황", "상호 존중", misc]);
  const text = out.map((s) => s.content).join("\n");
  assert.equal(text.match(/레비님 헝가리/g)?.length, 1);
  assert.equal(text.match(/신규 참석자 개인 질문/g)?.length, 1);
  assert.ok(out[0].content.includes("레비님 헝가리 출장 후 내일 출근")); // 먼저 나온 1번 안건에 남음
  assert.equal(out[6].content, `#### ○ 청소기\n${bullets("청소기 교체 예정 공지")}`); // 불릿이 다 지워진 "전달 사항" 소제목도 사라짐
  assert.ok(out[3].content.includes("  - 격주 발표로 변경")); // 꺼낸 소주제의 하위 불릿 유지
});

test("안건 마무리: 기타를 뺀 안건이 3개 미만이면 짧은 소주제도 큰 것부터 꺼냄", () => {
  const misc = {
    title: "기타 공지 및 논의",
    content: `#### ○ 소1\n${bullets("운영비 정산 마감 안내")}\n\n#### ○ 소2\n${bullets("11월 회식 장소 투표", "점심 믹싱 조 편성")}\n\n#### ○ 소3\n${bullets("청소기 교체 예정 공지")}`,
  };
  const out = finalizeAgendas([{ ...sec("본안건", bullets("서버 증설 범위 논의")), at: 0 }, misc]);
  assert.deepEqual(out.map((s) => s.title), ["본안건", "소2", "소1", "기타 공지 및 논의"]);
  assert.ok(out[3].content.includes("청소기 교체"));
});

test("안건 마무리: 기타 자체의 긴 내용은 소제목이 없으면 그대로, 소주제가 짧으면 안 꺼냄", () => {
  const plain = sec("기타 공지", bullets("가", "나", "다", "라"));
  const three = [sec("A"), sec("B"), sec("C")].map((s, at) => ({ ...s, at }));
  assert.deepEqual(finalizeAgendas([...three, plain]), [...three, plain]);
  const shortSub = sec("기타 공지 및 논의", `#### ○ 소\n${bullets("가", "나")}`);
  assert.deepEqual(finalizeAgendas([...three, shortSub]), [...three, shortSub]);
});

test("안건 마무리: 중복 제거는 다른 안건 사이에서만, 숫자가 다르거나 짧으면 남기고 하위 불릿이 남으면 상위도 유지", () => {
  const out = finalizeAgendas([
    sec("A", bullets("예산 9억으로 사업을 확정함", "확인 필요", "서버 증설 일정 공유함", "서버 증설 일정 공유함")),
    sec("B", `${bullets("예산 8억으로 사업을 확정함", "확인 필요")}\n- (대표) 서버 증설 일정 공유함\n  - 새로 나온 세부 내용입니다`),
  ]);
  assert.equal(out[0].content.match(/서버 증설/g)?.length, 2); // 같은 안건 안은 건드리지 않음
  assert.ok(out[1].content.includes("예산 8억"));
  assert.ok(out[1].content.includes("확인 필요"));
  assert.ok(out[1].content.includes("서버 증설 일정 공유함\n  - 새로 나온 세부 내용입니다"));
});

test("재구성: 안건 수 제한에 기타는 세지 않음", () => {
  const titles = Array.from({ length: 8 }, (_, i) => `주제${i}`);
  const map = titles.map((t, i) => [t, i === 7 ? "기타 공지" : `새 ${t}`]);
  assert.ok(parseRegroup(JSON.stringify(Object.fromEntries(map)), titles));
});

const entry = (term: string, desc: string, variants: string[] = []) => ({ term, variants, desc });

test("괄호 풀이: 근거 없으면 괄호만 제거", () => {
  const f = (s: string) => stripUnfoundedGloss(s, "교수원이 왔어요. 팀주와 남편도요. SST 얘기를 했어요.");
  assert.equal(f("- 교수원(외부 협력자)과 논의함"), "- 교수원과 논의함");
  assert.equal(f("- 팀주·남편(팀주) 참석"), "- 팀주·남편 참석");
  assert.equal(f("- SST(보안 접속 터미널) 사용"), "- SST 사용");
  assert.equal(f("- **교수원**（외부 협력자） 참석"), "- **교수원** 참석");
});

test("괄호 풀이: 약어 풀네임은 사전·녹취에 있으면 유지, 다른 항목의 설명은 근거가 아님", () => {
  const dict = [entry("R&R", "역할과 책임"), entry("아크릴 넥스트", "사내 행사"), entry("SST", "음성 인식", ["에스에스티"])];
  const f = (s: string, t = "녹취") => stripUnfoundedGloss(s, t, dict);
  assert.equal(f("- R&R(역할과 책임) 정리"), "- R&R(역할과 책임) 정리");
  assert.equal(f("- r&r(역할과 책임) 정리"), "- r&r(역할과 책임) 정리");
  assert.equal(f("- 아크릴 넥스트(사내 행사) 준비"), "- 아크릴 넥스트(사내 행사) 준비");
  assert.equal(f("- 에스에스티(음성 인식) 도입"), "- 에스에스티(음성 인식) 도입");
  assert.equal(f("- R&R(사내 행사) 정리"), "- R&R 정리");
  assert.equal(f("- API(Application Programming Interface) 연동"), "- API 연동");
  assert.equal(f("- API(Application Programming Interface) 연동", "API는 application programming interface 약자"), "- API(Application Programming Interface) 연동");
  assert.equal(f("- P&ID(배관 도면, 계장 도면) 검토", "P&ID 배관 도면 얘기"), "- P&ID 검토"); // 조각 하나라도 근거 없으면 제거
});

test("괄호 풀이: 말을 다듬은 괄호는 낱말이 녹취에 있으면 유지, 발언자·수치·날짜 괄호는 건드리지 않음", () => {
  const f = (s: string) => stripUnfoundedGloss(s, "인력이 부족해서 연기합니다", [], ["홍길동"]);
  for (const s of [
    "- 일정 연기(인력 부족)",
    "- (참석자) 내용",
    "- (질문자) 질문? (답변) 답",
    "- 예산 9억(2026년 기준)",
    "- 마감(날짜 미정)",
    "- 작성(30p 이내)",
    "- 월요일(월)",
    "- 담당자(홍길동)",
  ])
    assert.equal(f(s), s);
});

test("assemble: 본문의 근거 없는 괄호 풀이만 제거, 사전을 근거로 사용", () => {
  const md = assemble(INFO, [sec("교수원(외부 협력자) 협의", "- 교수원(외부 협력자), R&R(역할과 책임) 논의")], emptyMeta(), "", "교수원 얘기", [entry("R&R", "역할과 책임")]);
  assert.ok(md.includes("### 1. 교수원 협의"));
  assert.ok(md.includes("- 교수원, R&R(역할과 책임) 논의"));
});

test("재구성 요청문: 제목은 전부, 요지는 들어가는 만큼만", () => {
  assert.equal(regroupDigest([sec("A")], ["요지"]), ""); // 합칠 게 없음
  const d = regroupDigest([sec("A", "- 하나\n  - 둘"), sec("B"), sec("A", "- 셋")], Array(1000).fill("긴 요지입니다"));
  assert.ok(d.startsWith("[안건 제목] 불릿 수 | 제목\n3 | A\n0 | B\n\n[구간별 요지]"), d);
  assert.ok(d.length <= 6000);
  assert.equal(regroupDigest([sec("가".repeat(4000)), sec("나".repeat(4000))], []), ""); // 제목만으로 넘침
});
