import { NextResponse } from "next/server";
import { GROQ_BASE, checkAuth, forwardGroqError, getKey } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST multipart/form-data
 *  - file: audio/wav 청크 (클라이언트에서 16kHz mono, ~100초 단위로 잘라서 보냄 → 4.5MB 제한 회피)
 *  - prompt: 직전 청크 끝부분 (문맥 이어붙이기용, 선택)
 *  - language: "ko" | "auto"
 */
export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const key = getKey();
  if (!key) {
    return NextResponse.json({ error: "서버에 GROQ_API_KEY가 설정되지 않았습니다." }, { status: 500 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file이 없습니다." }, { status: 400 });
  }
  const prompt = String(form.get("prompt") || "").slice(-200);
  const language = String(form.get("language") || "ko");

  // whisper-large-v3 한도가 차면 turbo로 (모델별 한도가 따로 있음)
  const primary = process.env.GROQ_STT_MODEL || "whisper-large-v3";
  const models = [...new Set([primary, "whisper-large-v3", "whisper-large-v3-turbo"])];

  let last: Response | null = null;
  for (const model of models) {
    const out = new FormData();
    out.append("file", file, "chunk.wav");
    out.append("model", model);
    out.append("response_format", "json");
    out.append("temperature", "0");
    if (language !== "auto") out.append("language", language);
    if (prompt) out.append("prompt", prompt);

    const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: out,
    });
    if (res.ok) {
      const data = (await res.json()) as { text?: string };
      return NextResponse.json({ text: (data.text || "").trim(), model });
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
