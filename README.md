# 회의록 메이커

녹음하거나 음성 파일을 올리면 받아쓰기 → 회의록(요약·결정사항·Action Items)까지 자동으로 만들어 주는 웹앱. PC·모바일 둘 다 지원, **전부 무료**로 운영 가능.

| 역할 | 모델 (Hugging Face 공개 모델) | 실행 위치 |
|---|---|---|
| 음성 → 텍스트 | `openai/whisper-large-v3` (MIT) | Groq API 무료 티어 |
| 회의록 작성 | `openai/gpt-oss-120b` (Apache 2.0) | Groq API 무료 티어 |
| 호스팅 | Next.js | Vercel Hobby (무료) |

---

## 1. Groq API 키 발급 (무료, 카드 불필요)

1. https://console.groq.com 가입
2. **API Keys → Create API Key** → `gsk_...` 복사

## 2. 로컬 실행

```bash
npm install
cp .env.example .env.local   # GROQ_API_KEY 채우기
npm run dev                  # http://localhost:3000
```

> 마이크 녹음은 HTTPS 또는 localhost에서만 동작함. 폰에서 테스트하려면 3번처럼 배포해서 쓰기.

## 3. Vercel 배포

1. 이 폴더를 GitHub 레포로 push
2. https://vercel.com → **Add New → Project** → 레포 Import
3. **Environment Variables**에 추가
   - `GROQ_API_KEY` = 발급받은 키
   - `APP_PASSWORD` = 아무 비밀번호 (**꼭 설정** — 안 하면 URL 아는 사람 누구나 내 무료 한도를 씀)
4. Deploy → `https://xxx.vercel.app` 발급
5. 사이트 접속 → **설정 → 접속 비밀번호** 입력 (브라우저에 저장됨)

CLI로 하려면: `npx vercel` → `npx vercel env add GROQ_API_KEY` → `npx vercel --prod`

## 4. 아이폰에서 앱처럼 쓰기

Safari로 접속 → 공유 버튼 → **홈 화면에 추가**

- 녹음 중엔 **화면을 켜둘 것**. 화면 꺼짐/앱 전환 시 iOS가 브라우저 녹음을 끊음 (앱이 화면 꺼짐 방지를 요청하긴 함)
- 긴 회의는 **아이폰 기본 음성 메모로 녹음 → "파일 업로드"** 가 가장 안전

---

## 동작 구조

```
[브라우저]
 마이크 녹음 (AudioWorklet)  ─┐
 파일 업로드 (decodeAudioData) ─┴→ 16kHz mono로 변환 → 100초 단위 WAV(약 3.2MB)로 자름
                                   │  ※ Vercel 함수 요청 한도 4.5MB 회피
                                   │  ※ 무음 구간은 건너뜀 (Whisper 환각 방지)
                                   ▼
 POST /api/transcribe  ── 청크 1개씩 순서대로, 직전 문장을 prompt로 넘겨 문맥 연결
                                   │  녹음 중에도 100초마다 실시간 처리
                                   ▼
 녹취록 (직접 수정 가능)
                                   ▼
 POST /api/summarize  (사내 회의록 작성 요령 양식)
   body : 녹취록 2,800자 구간마다 → 주요내용 상세(발언자·용어설명·Q&A·수치) + META(요지/용어/결정/할일/역할/현황)
   frame: META만 모아서 → 회의목적 · 결정사항 · Action Item 표 · (외부 미팅) 역할 분담
   조립 : 같은 주제끼리 합치고 Meeting Result 양식으로 (회의 개요 · 회의목적 · 안건 · 주요 용어 · 주요내용 · 결정사항 · Action Item)
          ※ 요청 1회 = 약 8K 토큰 이하 (Groq 무료 한도)
                                   ▼
 회의록 (마크다운) → 복사(Notion에 붙여넣기 OK) / .md 다운로드 / 브라우저에 기록 저장

[서버: Next.js API Route]  API 키 보관 + 비밀번호 검사 + Groq 호출만 담당 (DB 없음)
```

429(무료 한도 초과)가 오면 `retry-after` 만큼 자동으로 기다렸다가 재시도함.

### 파일 구성

```
app/page.tsx                 UI + 전사 큐 + 요약 파이프라인
app/api/transcribe/route.ts  Groq Whisper 프록시
app/api/summarize/route.ts   Groq LLM 프록시
lib/audio.ts                 녹음, 리샘플링(→16kHz), WAV 인코딩, 파일 디코딩
lib/text.ts                  환각 문구 제거, 텍스트 분할, 마크다운 렌더
lib/prompts.ts               회의록 프롬프트 (작성 규칙 바꾸려면 여기)
lib/minutes.ts               구간 결과 파싱 · 주제 병합 · 최종 양식 조립 (섹션 순서 바꾸려면 여기)
```

## 무료 한도 (Groq Free plan, 계정 단위)

| 모델 | 한도 |
|---|---|
| whisper-large-v3 | 분당 20회, 하루 2,000회, 시간당 오디오 2시간 / 하루 8시간 |
| gpt-oss-120b | 분당 30회, 분당 8K 토큰, 하루 200K 토큰 |

하루 1시간짜리 회의 서너 개 정도는 충분. 한도는 바뀔 수 있으니 https://console.groq.com/settings/limits 에서 확인.

## 모델 바꾸기

`.env` / Vercel 환경변수에서:

- `GROQ_STT_MODEL=whisper-large-v3-turbo` → 더 빠름, 정확도 약간 ↓
- `GROQ_LLM_MODEL=<Groq 콘솔의 다른 모델 ID>` → 예: Qwen, Llama 계열. 한국어 품질은 모델마다 다르니 비교해 보기

## 주의

- 음성은 Groq(미국 서버)로 전송됨. 회사 회의는 보안 정책 먼저 확인
- 화자 분리 기능은 없음. 발언자는 녹취 속 호칭·이름 + 입력한 참석자 명단으로 AI가 추정 → 모르면 (참석자)로 표기
- 지난 회의록은 해당 브라우저 localStorage에만 저장됨 (기기 간 동기화 X)
- Vercel Hobby는 개인·비상업 용도 전용
