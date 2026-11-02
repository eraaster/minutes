import { NextResponse } from "next/server";
import { GROQ_BASE, NO_KEY_MSG, checkAuth, forwardGroqError, getKey } from "@/lib/server";
import { repetitionScore } from "@/lib/text";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST multipart/form-data
 *  - file: audio/wav 청크 (클라이언트에서 16kHz mono, 90~110초 단위로 잘라서 보냄 → 4.5MB 제한 회피)
 *  - prompt: 회의 제목 + 사전의 용어 이름들 (200자 이내, 선택). 앞 구간 전사문은 넣지 않음
 *  - language: "ko" | "auto"
 */
export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const key = getKey(req);
  if (!key) {
    return NextResponse.json({ error: NO_KEY_MSG, code: "auth" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file이 없습니다." }, { status: 400 });
  }
  const prompt = String(form.get("prompt") || "").slice(0, 200);
  const language = String(form.get("language") || "ko");

  // whisper-large-v3 한도가 차면 turbo로 (모델별 한도가 따로 있음)
  const primary = process.env.GROQ_STT_MODEL || "whisper-large-v3";
  const models = [...new Set([primary, "whisper-large-v3", "whisper-large-v3-turbo"])];

  const call = (model: string, temperature: number, withPrompt: boolean) => {
    const out = new FormData();
    out.append("file", file, "chunk.wav");
    out.append("model", model);
    out.append("response_format", "json");
    out.append("temperature", String(temperature));
    if (language !== "auto") out.append("language", language);
    if (withPrompt && prompt) out.append("prompt", prompt);
    return fetch(`${GROQ_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: out,
    });
  };

  let last: Response | null = null;
  for (const model of models) {
    const res = await call(model, 0, true);
    if (res.ok) {
      let text = String(((await res.json()) as { text?: string }).text || "").trim();
      let suspect = false;
      // 같은 문장이 반복되는 환각이면 설정을 바꿔 한 번 더 (temperature↑, 힌트 없이)
      if (repetitionScore(text) > 0.5) {
        const retry = await call(model, 0.4, false).catch(() => null);
        if (retry?.ok) {
          const t2 = String(((await retry.json()) as { text?: string }).text || "").trim();
          if (repetitionScore(t2) < repetitionScore(text)) text = t2;
        }
        suspect = repetitionScore(text) > 0.5;
      }
      return NextResponse.json({
        text,
        model,
        suspect,
        fallbackFrom: model !== models[0] ? models[0] : undefined,
      });
    }
    const msg = await res
      .clone()
      .json()
      .then((b) => String(b?.error?.message || ""))
      .catch(() => "");
    // 분당 한도면 같은 모델로 기다렸다 재시도, 시간당·일일 오디오 한도면 다음 모델로
    const longLimit = /per (hour|day)|\((ASH|ASD|RPD)\)/i.test(msg);
    if (res.status === 429 && !longLimit) return forwardGroqError(res);
    if (res.status !== 429 && res.status !== 404 && res.status < 500) return forwardGroqError(res);
    last = res;
  }
  return forwardGroqError(last!);
}
