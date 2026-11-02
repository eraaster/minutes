# 회의록 메이커 (minutes)

녹음/음성 파일 → 받아쓰기 → 사내 양식(Meeting Result) 회의록을 만드는 Next.js 웹앱.
배포: Vercel (`main`에 push하면 자동 배포) · https://minutes-gray.vercel.app

## 스택
- Next.js 16 (App Router) + TypeScript, 외부 UI 라이브러리 없음 (CSS는 `app/globals.css`)
- AI: Groq API (OpenAI 호환) — 모두 Hugging Face 공개 모델
  - 받아쓰기: `whisper-large-v3` → 한도 차면 `whisper-large-v3-turbo`
  - 회의록: `openai/gpt-oss-120b` → `llama-3.3-70b-versatile` → `qwen/qwen3-32b` → `openai/gpt-oss-20b` (일일 한도 찼을 때만 다음 모델)
- 무료 티어 전제: 요청 1회당 약 8K 토큰 이하가 되도록 쪼개서 보냄

## 파일 구조
- `app/layout.tsx` → `components/Shell.tsx` — 공통 헤더(탭·사용자 칩), 토스트, 계정 패널, 푸터. **작성 화면(`Composer`)을 항상 마운트해 두고 `/`가 아닐 때 숨김만 함** (언마운트하면 진행 중인 녹음·받아쓰기가 끊김). 그래서 `app/page.tsx`는 비어 있음
- `components/Composer.tsx` — 작성 화면: 녹음/업로드 → 전사 큐 → 회의록 생성 파이프라인, 드래그 선택 → 사전 등록 팝오버, 찾아 바꾸기
- `components/AccountPanel.tsx` — 계정 설정 (PC 오른쪽 슬라이드, 모바일 아래 시트). 이름·Groq 키·비밀번호·인식 언어
- `components/TagInput.tsx` — 태그 입력 (Enter·쉼표로 추가, 한글 조합 중 Enter 무시)
- `app/glossary/page.tsx` — 용어 사전 (추가·검색·수정·삭제, PC 표/모바일 카드, JSON 가져오기·내보내기, 예시로 시작하기)
- `app/history/page.tsx` — 지난 회의록 (제목 검색, 열기 → 작성 화면에 불러오기, 삭제)
- `lib/store.ts` — 화면 간 공유 상태 훅 `useStore` (계정·사전·기록·토스트·작성 화면 진행 상황), localStorage 읽기/쓰기. 키 이름은 예전 그대로
- `app/api/transcribe/route.ts` — Whisper 프록시. 반복 환각 감지 시 temperature 올려 1회 재시도, `suspect` 플래그
- `app/api/summarize/route.ts` — LLM 프록시. stage `body` / `frame` / `fix`(녹취록 교정), 모델 폴백, `fallbackFrom` 반환
- `lib/audio.ts` — 마이크 녹음(AudioWorklet), 16kHz mono 리샘플, 90~110초 사이 가장 조용한 지점(50ms 창 RMS 최소)에서 WAV 청크 분할(Vercel 4.5MB 요청 한도 회피). 녹음(`MicRecorder`)·업로드(`splitToChunks`) 공통
- `lib/minutes.ts`의 `groupMinorSections`(안건 6개 초과 시 짧은 안건을 "기타 공지 및 논의"로), `verifyDeadlines`(기한 열을 녹취록과 대조), `verifyBodyDates`(본문 날짜·연도·월을 녹취록과 대조, 근거 없으면 "(날짜 미정)"/연도 삭제), `speakerCandidates`(녹취에서 "OO님"으로 불린 이름만, 용어 사전·역할 단어 제외)
- `lib/text.ts` — 환각 문구·반복 제거(`cleanTranscript`, `repetitionScore`), 텍스트 분할, 마크다운 렌더러(`mdToHtml`)
- `lib/glossary.ts` — 용어 사전: 정리·마이그레이션(`normalizeGlossary`, `migrateTerms`, `parseGlossary`), 자동 치환(`applyGlossary`), 문맥 검색(`findGlossary`), AI 첨부문(`glossaryContext`). 테스트 `lib/glossary.test.ts`
- `lib/prompts.ts` — AI 지시문 (상세 모드 / 간결 모드)
- `lib/minutes.ts` — AI 응답 파싱, 주제 병합, 최종 양식 조립(`assemble`)
- `lib/server.ts` — 인증(사용자 키 `x-groq-key` 또는 `APP_PASSWORD`), Groq 에러 전달

## 용어 사전
- 항목 = `{ term, variants, desc }`, localStorage `mm-glossary`. 예전 쉼표 사전 `mm-terms`는 첫 로드 때 옮겨 옴(원본은 남겨 둠). `/glossary`에서 편집, JSON 내보내기/가져오기(가져오기는 바로 병합, 같은 용어의 설명은 파일 값 우선)
- 자동 치환: 전사 구간마다 `cleanTranscript` 다음 `applyGlossary`. 긴 것부터 한 번의 패스. 용어 자신도 패턴에 넣어 이미 맞게 쓴 용어를 다시 치환하지 않음. 앞쪽 경계를 막아 "장품"이 "화장품"에 걸리지 않음, 영문·숫자는 양쪽 경계. 한 글자 오인식 형태는 저장 안 함
- 녹취록 드래그 선택 → "사전에 등록"(그 형태만 현재 녹취록에 즉시 적용), "찾아 바꾸기". 둘 다 "되돌리기" 가능
- 문맥 검색 `findGlossary`: 정확 일치 > 후보, 최대 15개. 후보 = 2~6글자 한글 단어(조사 뗀 형태 포함)와 자모 유사도 0.75 이상. 유사도 = 2·가중 LCS / 가중 길이 합(받침 가중치 0.5). 일반 Levenshtein은 트러그→트러블(0.71)·아크네스→아크릴 넥스트(0.57)를 못 잡음
- 첨부: `fix`·`body` 요청의 `ctx.glossary`에 "[참고 용어 사전]"으로 찾은 항목만, 구간당 600자 이내(`CONTEXT_MAX`, 서버에서도 자름). 후보는 "발음이 비슷해 이 용어일 수 있음" 표시

## 받아쓰기·교정
- Whisper prompt = 회의 제목 + 사전의 용어 이름들, 200자 이내
- "녹취록 교정" 버튼: 2,800자 구간마다 `fix` 호출, 사전에 있는 용어의 오인식만 수정(temperature 0). 사전에 없는 단어는 추측 교정 금지(부들량→부드러움, 장품→장비 등). 관련 사전 항목이 없는 구간은 AI를 호출하지 않음. 구간별 안전장치(`rejectFix`, lib/text.ts): 잘림·생략 표시 추가·길이 0.9~1.1 밖·문자 유사도 0.85 미만·타임스탬프 변경 시 원문 유지. 단어 단위 diff(`wordDiff`)로 "바뀐 부분 N곳" 목록 + 항목별 되돌리기, "되돌리기"로 전체 복구
- 429 대기가 20초 미만이면 조용히 재시도, 20초 이상만 "잠시 대기 중… N초" 표시

## 회의록 생성 흐름
1. 녹취록을 2,800자(간결 모드 4,000자) 구간으로 나눔
2. 구간마다 `body` 호출 → `### 주제` 본문 + `===META===` (요지/용어/결정/할일/역할/현황/피드백)
3. META만 모아 `frame` 1회 호출 → 회의 제목·참석자(비었을 때), 회의목적, 결정사항, Action Item 표
4. `assemble()`이 양식으로 조립: 회의 개요 → 회의목적 → 안건 → 주요 용어 → 주요내용 → 결정사항 → Action Item (→ 역할 분담/업무 현황)

## 지켜야 할 원칙
- AI가 지어낸 정보 금지: 기한은 녹취에 근거가 있을 때만, 용어표는 영문 약어만, 발언자는 확실할 때만 이름
- "(미정)" 같은 자리채움 값은 빈칸으로 취급 → AI 자동 입력
- 앞 구간 전사문을 Whisper prompt로 넘기지 말 것 (환각이 전염됨) — 제목 + 용어 사전만
- 무료 한도 고려: 요청 크기·출력 토큰 상한(`MAX_OUT`, `BRIEF_OUT`) 유지
- 사용자는 한국어, 기술 용어는 영어 유지

## 작업 방법
- 수정 후 `npm test`(Node 내장 test runner, 외부 의존성 없음)와 `npm run build`로 확인 (Node가 PATH에 없으면 `C:\Program Files\nodejs` 사용)
- 커밋 작성자 이메일은 이 폴더 git config(`eraaster@naver.com`) 사용 — 회사 메일로 커밋하면 Vercel이 배포를 Blocked 처리함
- `git push` → Vercel 자동 배포 → Deployments에서 Ready 확인
- 비밀 값(`.env.local`, Groq 키)은 절대 커밋하지 말 것
