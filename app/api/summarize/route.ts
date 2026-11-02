import { NextResponse } from "next/server";
import { GROQ_BASE, checkAuth, forwardGroqError, getKey } from "@/lib/server";
import { Stage, systemPrompt, userPrompt } from "@/lib/prompts";
import type { PromptCtx } from "@/lib/minutes";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { stage: Stage; text: string; ctx: PromptCtx };

// 요청당 (입력 + 출력) 토큰이 Groq 무료 TPM(8K) 안에 들어가도록
const MAX_OUT: Record<Stage, number> = { body: 3200, frame: 2500 };
const MAX_IN_CHARS = 7000;

export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const key = getKey();
  if (!key) {
    return NextResponse.json({ error: "서버에 GROQ_API_KEY가 설정되지 않았습니다." }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.text || !["body", "frame"].includes(body.stage) || !body.ctx) {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  if (body.text.length > MAX_IN_CHARS) {
    return NextResponse.json({ error: "요청 텍스트가 너무 깁니다." }, { status: 413 });
  }
  const ctx: PromptCtx = {
    ...body.ctx,
    participants: (body.ctx.participants || []).slice(0, 40),
    prevTitles: (body.ctx.prevTitles || []).slice(-15),
    knownTerms: (body.ctx.knownTerms || []).slice(-40),
  };

  const model = process.env.GROQ_LLM_MODEL || "openai/gpt-oss-120b";
  const payload: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_completion_tokens: MAX_OUT[body.stage],
    messages: [
      { role: "system", content: systemPrompt(body.stage, ctx) },
      { role: "user", content: userPrompt(body.stage, body.text, ctx) },
    ],
  };
  // gpt-oss는 reasoning 모델 → 추론 토큰도 한도를 먹으므로 낮게
  if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return forwardGroqError(res);

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content?.trim() || "";
  return NextResponse.json({ content, truncated: data?.choices?.[0]?.finish_reason === "length" });
}
