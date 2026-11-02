import { NextResponse } from "next/server";

export const GROQ_BASE = "https://api.groq.com/openai/v1";

/** APP_PASSWORD가 설정돼 있으면 x-app-password 헤더를 검사 */
export function checkAuth(req: Request): NextResponse | null {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  // 한글 비밀번호도 쓸 수 있게 클라이언트에서 encodeURIComponent 해서 보냄
  let sent = "";
  try {
    sent = decodeURIComponent(req.headers.get("x-app-password") || "");
  } catch {
    /* ignore */
  }
  if (sent === pw) return null;
  return NextResponse.json({ error: "비밀번호가 올바르지 않습니다." }, { status: 401 });
}

export function getKey(): string | null {
  return process.env.GROQ_API_KEY || null;
}

/** Groq 에러 응답을 클라이언트로 그대로 전달 (429면 retry-after 포함) */
export async function forwardGroqError(res: Response): Promise<NextResponse> {
  let message = `Groq API 오류 (${res.status})`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* ignore */
  }
  const headers: Record<string, string> = {};
  const ra = res.headers.get("retry-after");
  if (ra) headers["retry-after"] = ra;
  return NextResponse.json({ error: message }, { status: res.status, headers });
}
