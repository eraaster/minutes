import type { PromptCtx } from "./minutes";

export type Stage = "body" | "frame";

/**
 * 회의록 작성 요령(사내 공지) 기준
 *  - 불참자가 읽어도 회의 전체를 이해할 수 있게: 상세하게 / 명료하게 / 구조적으로
 *  - 발언자 명시, 용어·약어 첫 등장 시 설명, 배경·맥락, 수치 정확히, Q&A 형식
 *  - Action Item = 할 일·담당자·기한·완료
 * ※ Groq 무료 한도(요청당 약 8K 토큰) 때문에 프롬프트를 짧게 유지
 */

const TYPE_LABEL: Record<PromptCtx["type"], string> = {
  agenda: "내부 안건 회의",
  external: "외부 미팅",
  weekly: "주간회의",
};

export function systemPrompt(stage: Stage, ctx: PromptCtx): string {
  if (stage === "body") {
    const extra: string[] = [];
    if (ctx.type === "external") extra.push("역할: 소속(회사/기관) | 담당 | 상세 내용 | 기한");
    if (ctx.type === "weekly") {
      extra.push("현황: 이름 | 업무/프로젝트 | 금주 수행 내용(구체적으로) | 진행률 | 상태(정상/지연/위험) | 차주 계획");
      extra.push("피드백: (발언자) 피드백·지시 내용 [승인/반려/보류 중 해당 시]");
    }

    return `당신은 회의록 작성자입니다. 회의 녹취록의 한 구간을 받아 "회의에 참석하지 않은 사람도 이것만 읽고 회의 내용을 완전히 이해할 수 있도록" 주요내용을 상세히 작성합니다.

[규칙]
1. 상세하게: 논의 내용을 빠짐없이. 결론만 쓰지 말고 왜 그렇게 됐는지 근거·맥락·논의 과정까지.
2. 발언자: 문장 앞에 (이름). 참석자 명단과 녹취록의 호칭("대표님", "Daniel 님" 등)으로 확실할 때만 이름을 쓰고, 모르면 (참석자). 추측 금지.
3. 용어·약어: 처음 나올 때 괄호로 풀네임과 짧은 설명. 예) P&ID(Piping and Instrumentation Diagram, 배관·계장 도면). [이미 설명한 용어]는 다시 설명하지 않음.
4. 수치·금액·일정·수량은 들은 그대로 정확히. 예) (사업예산) 9억 / (제출기한) ~2025.03.14(금)
5. 질의응답은 Q&A로:
- (질문자) 질문?
  - (답변자) 답변
6. 녹취록에 없는 내용은 절대 만들지 않음. 음성인식 오류는 문맥상 자연스럽게 고치되 고유명사·숫자는 그대로. 인사·잡담은 생략.
7. 개조식 문체: "~함", "~임", "~예정", "~필요".

[출력] 마크다운만, 다른 말 없이:
### 주제 제목
#### ○ 소주제 (필요할 때만)
- (발언자) 내용
  - 세부 내용

- 주제 제목은 구체적으로. 나쁜 예) "기술 관련" / 좋은 예) "제안서 작성방향 (필수 목차, 기술 아키텍처)". 번호 붙이지 않음.
- [앞 구간 주제]와 같은 주제가 이어지면 그 제목을 글자 그대로 다시 씀.

본문 뒤에 ===META=== 한 줄을 쓰고, 해당하는 것만 한 줄에 하나씩:
요지: 이 구간 핵심 한 문장
용어: 약어 | 풀네임 | 한 줄 설명
결정: (결정한 사람) 결정 내용
할일: 구체적인 할 일 | 담당자 | 기한
${extra.join("\n")}
담당자·기한을 모르면 "미정". "다음 주 금요일" 같은 상대 날짜는 회의 일자 기준 MM/DD로 바꾸고 원래 표현을 괄호에.`.replace(/\n{3,}/g, "\n\n");
  }

  const sections: string[] = [];
  if (ctx.needTitle)
    sections.push(`## □ 회의 제목
회의 성격이 드러나는 제목 한 줄. 예) "삼성 E&A_P&ID 자동인식 시스템 Kick-off", "주간회의 (26.03.09)"`);
  if (ctx.needPeople)
    sections.push(`## □ 참석자
[발언자 후보] 중 실제 사람 이름·호칭만 쉼표로 나열. (사업예산) 같은 항목명은 제외. 알 수 없으면 "미상".`);
  sections.push(
    `## □ 회의목적
회의가 왜 소집됐는지 배경과 목적을 1~2문장으로 쓰고, 이어서 목적을 불릿으로 나열.
나쁜 예) "프로젝트 관련 논의" / 좋은 예) "OO 개발 건 Kick-off 회의. 사업개요 공유, 제안서 작성방향 확정을 목적으로 진행."`
  );
  if (ctx.type === "weekly")
    sections.push(`## □ 점검 및 피드백
- (발언자) 피드백·지시 내용 [승인/반려/보류]`);
  sections.push(`## □ 결정사항
- (결정한 사람) 결정 내용`);
  sections.push(`## □ Action Item
| No. | 할 일 | 담당자 | 기한 | 완료 |
|---|---|---|---|---|
| 1 | 구체적인 할 일 | 이름 | MM/DD | |
할 일은 구체적으로. 나쁜 예) "제안서 작성" / 좋은 예) "OO 제안서 PPT 초안 작성 (30p 이내)"`);
  if (ctx.type === "external")
    sections.push(`## □ 역할 분담
### (소속명)
| 담당 | 상세 내용 | 기한 |
|---|---|---|
소속(회사·기관)별로 표를 나눔.`);

  return `당신은 회의록 작성자입니다. 회의 정보와 구간별 메모(안건, 요지, 결정·할일 후보)를 받아 회의록의 요약 섹션을 작성합니다.

[규칙]
- 자료에 없는 내용은 만들지 않음. 중복은 하나로 합침. 개조식 문체.
- 담당자·기한을 모르면 "미정" (지어내지 말 것). 해당 내용이 없으면 "- 없음".

[출력] 마크다운만, 다른 말 없이, 아래 제목을 그대로 사용:

${sections.join("\n\n")}`;
}

export function userPrompt(stage: Stage, text: string, ctx: PromptCtx): string {
  const info = [
    `회의 제목: ${ctx.title || "(미정)"}`,
    `회의 유형: ${TYPE_LABEL[ctx.type]}`,
    `회의 일자: ${ctx.dateLabel}${ctx.time ? ` ${ctx.time}` : ""}`,
    ctx.place ? `장소: ${ctx.place}` : null,
    `참석자 명단: ${ctx.participants.length ? ctx.participants.join(", ") : "(미입력)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (stage === "body") {
    return `[회의 정보]
${info}
[앞 구간 주제] ${ctx.prevTitles?.length ? ctx.prevTitles.join(" / ") : "없음"}
[이미 설명한 용어] ${ctx.knownTerms?.length ? ctx.knownTerms.join(", ") : "없음"}

[녹취록 구간 ${ctx.part}/${ctx.total}]
${text}`;
  }
  return `[회의 정보]
${info}

${text}`;
}
