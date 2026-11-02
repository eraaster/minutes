export type Stage = "partial" | "merge" | "final";

const COMMON = `규칙:
- 녹취록에 없는 내용은 절대 지어내지 마세요. 확실하지 않으면 "(불명확)"이라고 표시하세요.
- 음성 인식 오류로 보이는 단어는 문맥상 가장 자연스러운 표현으로 고쳐도 되지만, 고유명사·숫자·날짜는 들은 그대로 유지하세요.
- 기술 용어와 제품명은 영어 원문 표기를 유지하세요.
- 한국어로 작성하세요.`;

export function systemPrompt(stage: Stage): string {
  if (stage === "partial") {
    return `당신은 회의 기록 담당자입니다. 긴 회의 녹취록의 일부 구간을 받아, 나중에 전체 회의록으로 합칠 수 있도록 핵심만 메모합니다.

출력 형식(마크다운 불릿만, 다른 말 없이):
- 논의: ...
- 결정: ...
- 할 일: (담당자 / 기한 / 내용 — 언급된 경우만)
- 미결: ...
해당 항목이 없으면 그 줄은 생략하세요. 전체 600자 이내로 간결하게.

${COMMON}`;
  }
  if (stage === "merge") {
    return `당신은 회의 기록 담당자입니다. 같은 회의의 여러 구간 메모를 받아, 중복을 합치고 시간 순서를 유지한 하나의 메모로 압축합니다.

출력 형식(마크다운 불릿만, 다른 말 없이):
- 논의: ...
- 결정: ...
- 할 일: ...
- 미결: ...
전체 1200자 이내.

${COMMON}`;
  }
  return `당신은 회의록 작성 전문가입니다. 회의 녹취록 또는 구간별 메모를 바탕으로 깔끔한 회의록을 작성합니다.

반드시 아래 마크다운 구조로만 출력하세요 (표는 사용하지 마세요):

## 한 줄 요약
(회의 전체를 1~2문장으로)

## 주요 논의 내용
### (주제 1)
- ...
### (주제 2)
- ...

## 결정 사항
- ...

## Action Items
- [ ] 내용 — 담당: (이름 또는 "미정") / 기한: (날짜 또는 "미정")

## 미결 사항 · 후속 논의
- ...

해당 내용이 없는 섹션은 "- 없음"으로 적으세요.

${COMMON}`;
}

export function userPrompt(
  stage: Stage,
  text: string,
  meta: { title?: string; date?: string; part?: number; total?: number }
): string {
  const head = [
    meta.title ? `회의 제목: ${meta.title}` : null,
    meta.date ? `회의 일자: ${meta.date}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (stage === "partial") {
    return `${head}\n[녹취록 구간 ${meta.part}/${meta.total}]\n\n${text}`;
  }
  if (stage === "merge") {
    return `${head}\n[구간별 메모]\n\n${text}`;
  }
  return `${head}\n[자료]\n\n${text}`;
}
