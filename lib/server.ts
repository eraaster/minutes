import { NextResponse } from "next/server";

export const GROQ_BASE = "https://api.groq.com/openai/v1";

/** 사용자가 직접 넣은 Groq 키 (x-groq-key 헤더). 형식이 맞을 때만 사용 */
function userKey(req: Request): string | null {
  const k = (req.headers.get("x-groq-key") || "").trim();
  return /^gsk_[A-Za-z0-9]{20,}$/.test(k) ? k : null;
}

/**
 * 접근 확인
 *  - 자기 Groq 키를 넣은 사용자: 비밀번호 없이 통과 (본인 한도를 씀)
 *  - 아니면 서버 키를 쓰므로 APP_PASSWORD 검사
 */
export function checkAuth(req: Request): NextResponse | null {
  if (userKey(req)) return null;
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
  return NextResponse.json(
    { error: "설정에서 '내 Groq API 키'를 넣거나 접속 비밀번호를 입력해 주세요.", code: "auth" },
    { status: 401 }
  );
}

/** 사용자 키 우선, 없으면 서버 키 */
export function getKey(req: Request): string | null {
  return userKey(req) || process.env.GROQ_API_KEY || null;
}

export const NO_KEY_MSG = "설정에서 '내 Groq API 키'를 넣어 주세요.";

/** Groq 에러 응답을 클라이언트로 전달 (429면 retry-after 포함) */
export async function forwardGroqError(res: Response): Promise<NextResponse> {
  let message = `Groq API 오류 (${res.status})`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* ignore */
  }
  // Groq의 401 = 키가 틀림/삭제됨 → 앱 비밀번호 오류(401)와 구분
  if (res.status === 401) {
    return NextResponse.json(
      { error: "Groq API 키가 올바르지 않습니다. 키를 다시 확인하거나 새로 발급해 주세요.", code: "badkey" },
      { status: 400 }
    );
  }
  const headers: Record<string, string> = {};
  const ra = res.headers.get("retry-after");
  if (ra) headers["retry-after"] = ra;
  return NextResponse.json({ error: message }, { status: res.status, headers });
}
