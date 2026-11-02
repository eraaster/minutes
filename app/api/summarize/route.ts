import { NextResponse } from "next/server";
import { GROQ_BASE, NO_KEY_MSG, checkAuth, forwardGroqError, getKey } from "@/lib/server";
import { Stage, systemPrompt, userPrompt } from "@/lib/prompts";
import type { PromptCtx } from "@/lib/minutes";
import { CONTEXT_MAX } from "@/lib/glossary";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { stage: Stage; text: string; ctx: PromptCtx };

// 요청당 (입력 + 출력) 토큰이 Groq 무료 TPM(8K) 안에 들어가도록
// fix(녹취록 교정)는 입력 길이만큼 출력이 나오므로 간결 모드와 무관하게 같은 상한
const MAX_OUT: Record<Stage, number> = { body: 3200, frame: 2500, fix: 3500 };
const BRIEF_OUT: Record<Stage, number> = { body: 1500, frame: 1500, fix: 3500 };
const MAX_IN_CHARS = 7000;

export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;

  const key = getKey(req);
  if (!key) {
    return NextResponse.json({ error: NO_KEY_MSG, code: "auth" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.text || !["body", "frame", "fix"].includes(body.stage) || !body.ctx) {
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
    glossary: String(body.ctx.glossary || "").slice(0, CONTEXT_MAX),
  };

  const messages = [
    { role: "system", content: systemPrompt(body.stage, ctx) },
    { role: "user", content: userPrompt(body.stage, body.text, ctx) },
  ];

  // 모델별로 무료 한도가 따로 있음 → 한도 초과·모델 없음이면 다음 모델로
  let last: Response | null = null;
  let lastMsg = "";
  const models = modelList();
  for (const model of models) {
    const payload: Record<string, unknown> = {
      model,
      temperature: body.stage === "fix" ? 0 : 0.2,
      max_completion_tokens: ctx.brief ? BRIEF_OUT[body.stage] : MAX_OUT[body.stage],
      messages,
    };
    // gpt-oss는 reasoning 모델 → 추론 토큰도 한도를 먹으므로 낮게
    if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";

    let res: Response;
    try {
      res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const raw: string = data?.choices?.[0]?.message?.content || "";
      // Qwen 등 일부 모델은 <think>…</think> 추론을 본문에 섞어 보냄 → 제거
      const content = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
      if (!content) continue;
      return NextResponse.json({
        content,
        model,
        fallbackFrom: model !== models[0] ? models[0] : undefined,
        truncated: data?.choices?.[0]?.finish_reason === "length",
      });
    }

    const msg = await res
      .clone()
      .json()
      .then((b) => String(b?.error?.message || ""))
      .catch(() => "");
    // 분당 한도(TPM/RPM)면 같은 모델로 잠깐 기다리는 게 나음 → 클라이언트가 retry-after 만큼 대기 후 재시도
    // 일일 한도(TPD/RPD)만 다음 모델로 넘김
    const daily = /per day|\((TPD|RPD)\)/i.test(msg);
    if (res.status === 429 && !daily) return forwardGroqError(res);
    const skippable =
      res.status === 429 || // 일일 한도 초과
      res.status === 413 || // 이 모델 한도로는 요청이 너무 큼
      res.status === 404 ||
      res.status >= 500 ||
      /model|decommission|not found|does not exist|not supported/i.test(msg);
    if (!skippable) return forwardGroqError(res);
    // 다음 모델 시도. 모두 실패하면 마지막 429를 돌려줘서 클라이언트가 기다렸다 재시도
    if (!last || res.status === 429) {
      last = res;
      lastMsg = msg;
    }
  }

  if (last) return forwardGroqError(last);
  return NextResponse.json({ error: lastMsg || "사용 가능한 모델이 없습니다." }, { status: 503 });
}

/** GROQ_LLM_MODELS(쉼표 구분) 순서대로 시도. 예전 GROQ_LLM_MODEL도 맨 앞에 반영 */
function modelList(): string[] {
  const list = (process.env.GROQ_LLM_MODELS || DEFAULT_MODELS.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const first = process.env.GROQ_LLM_MODEL?.trim();
  return [...new Set(first ? [first, ...list] : list)];
}

// 전부 Hugging Face에 공개된 오픈 웨이트 모델. Groq에 없는 모델은 자동으로 건너뜀
const DEFAULT_MODELS = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b",
  "openai/gpt-oss-20b",
];
