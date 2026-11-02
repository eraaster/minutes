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
- `app/page.tsx` — 화면 전체 + 녹음/업로드 → 전사 큐 → 회의록 생성 파이프라인 (클라이언트)
- `app/api/transcribe/route.ts` — Whisper 프록시. 반복 환각 감지 시 temperature 올려 1회 재시도, `suspect` 플래그
- `app/api/summarize/route.ts` — LLM 프록시. stage `body` / `frame` / `fix`(녹취록 교정), 모델 폴백, `fallbackFrom` 반환
- `lib/audio.ts` — 마이크 녹음(AudioWorklet), 16kHz mono 리샘플, 90~110초 사이 가장 조용한 지점(50ms 창 RMS 최소)에서 WAV 청크 분할(Vercel 4.5MB 요청 한도 회피). 녹음(`MicRecorder`)·업로드(`splitToChunks`) 공통
- `lib/minutes.ts`의 `groupMinorSections`(안건 6개 초과 시 짧은 안건을 "기타 공지 및 논의"로), `verifyDeadlines`(기한 열을 녹취록과 대조), `verifyBodyDates`(본문 날짜·연도·월을 녹취록과 대조, 근거 없으면 "(날짜 미정)"/연도 삭제), `speakerCandidates`(녹취에서 "OO님"으로 불린 이름만, 용어 사전·역할 단어 제외)
- `lib/text.ts` — 환각 문구·반복 제거(`cleanTranscript`, `repetitionScore`), 텍스트 분할, 마크다운 렌더러(`mdToHtml`)
- `lib/prompts.ts` — AI 지시문 (상세 모드 / 간결 모드)
- `lib/minutes.ts` — AI 응답 파싱, 주제 병합, 최종 양식 조립(`assemble`)
- `lib/server.ts` — 인증(사용자 키 `x-groq-key` 또는 `APP_PASSWORD`), Groq 에러 전달

## 받아쓰기·교정
- Whisper prompt = 회의 제목 + 용어 사전(설정, localStorage `mm-terms`), 200자 이내
- "녹취록 교정" 버튼: 2,800자 구간마다 `fix` 호출, 음성인식 오류만 수정. 잘렸거나 80% 미만으로 줄었거나 타임스탬프가 달라진 구간은 원문 유지. "되돌리기"로 교정 전 복구
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
- 수정 후 `npm run build`로 타입/빌드 확인 (Node가 PATH에 없으면 `C:\Program Files\nodejs` 사용)
- 커밋 작성자 이메일은 이 폴더 git config(`eraaster@naver.com`) 사용 — 회사 메일로 커밋하면 Vercel이 배포를 Blocked 처리함
- `git push` → Vercel 자동 배포 → Deployments에서 Ready 확인
- 비밀 값(`.env.local`, Groq 키)은 절대 커밋하지 말 것
