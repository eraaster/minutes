import { NextResponse } from "next/server";
import { GROQ_BASE, checkAuth, forwardGroqError, getKey } from "@/lib/server";
import { Stage, systemPrompt, userPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  stage: Stage;
  text: string;
  title?: string;
  date?: string;
  part?: number;
  total?: number;
};

const MAX_OUT: Record<Stage, number> = { partial: 1500, merge: 2500, final: 3500 };

export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const key = getKey();
  if (!key) {
    return NextResponse.json({ error: "서버에 GROQ_API_KEY가 설정되지 않았습니다." }, { status: 500 });
  }

  const body = (await req.json()) as Body;
  if (!body?.text || !["partial", "merge", "final"].includes(body.stage)) {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const model = process.env.GROQ_LLM_MODEL || "openai/gpt-oss-120b";
  const payload: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_completion_tokens: MAX_OUT[body.stage],
    messages: [
      { role: "system", content: systemPrompt(body.stage) },
      { role: "user", content: userPrompt(body.stage, body.text, body) },
    ],
  };
  // gpt-oss는 reasoning 모델 → 추론 토큰도 무료 한도(TPM)를 먹으므로 낮게
  if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return forwardGroqError(res);

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content?.trim() || "";
  return NextResponse.json({ content });
}
