import { NextResponse } from "next/server";
import { z } from "zod";
import { extractLegalElements } from "@/lib/extractor";
import { resolveModel } from "@/lib/models";
import { runManusAgent } from "@/lib/manus";
import type { LegalElements } from "@/lib/types";

export const runtime = "nodejs";
// Most models finish in <60s, but Manus tasks can take 5-25 minutes —
// we poll inside the function until the task completes. 800s is the Pro-
// plan Fluid-Compute ceiling at the time of writing.
export const maxDuration = 800;

const BodySchema = z.object({
  narrative: z.string().min(10, "narrative must be at least 10 characters"),
  locale: z.enum(["ko", "en"]),
  /** Optional gateway model ID (e.g. "anthropic/claude-opus-4.7"). */
  model: z.string().optional(),
});

/**
 * Manus returns free-form prose + optional artifacts, NOT our strict
 * LegalElementsSchema. To keep the UI consistent, we wrap Manus output
 * into the same ExtractResponse shape but only populate `summary` —
 * `elements` and `matches` are intentionally empty placeholders. The
 * conversation thread renders the summary card and skips the structured
 * sections gracefully.
 */
const EMPTY_ELEMENTS: LegalElements = {
  caseNature: "unknown",
  parties: { plaintiff: "", defendant: "" },
  claimCause: "",
  legalRelationship: "",
  partyStatus: "",
  coreIssue: "",
  damageType: "",
  applicableStatutes: [],
  keyFacts: [],
  missingInfo: [],
};

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
      { status: 400 }
    );
  }

  const requestedModel = parsed.data.model;
  const family = requestedModel
    ? resolveModel(requestedModel).family
    : undefined;

  // ── Manus branch: run as autonomous agent task instead of a single LLM call.
  if (family === "manus") {
    try {
      const manusPrompt = buildManusPrompt(
        parsed.data.narrative,
        parsed.data.locale,
      );
      const { text } = await runManusAgent(manusPrompt, req.signal);
      // Manus's prose IS the summary — no structured elements to extract.
      return NextResponse.json({
        elements: EMPTY_ELEMENTS,
        summary: text,
        clarifyingQuestions: [],
      });
    } catch (err: unknown) {
      console.error("[api/extract manus] failed:", {
        message: err instanceof Error ? err.message : String(err),
        narrativeLen: parsed.data.narrative.length,
        locale: parsed.data.locale,
      });
      const message =
        err instanceof Error ? err.message : "Manus task failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // ── Single-LLM branch (Claude / ChatGPT / Gemini).
  try {
    const { elements, summary, clarifyingQuestions } = await extractLegalElements(
      parsed.data.narrative,
      parsed.data.locale,
      parsed.data.model,
      req.signal,
    );
    return NextResponse.json({ elements, summary, clarifyingQuestions });
  } catch (err: unknown) {
    console.error("[api/extract] failed:", {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
      modelRequested: parsed.data.model ?? "(default)",
      narrativeLen: parsed.data.narrative.length,
      locale: parsed.data.locale,
      cause:
        err && typeof err === "object" && "cause" in err
          ? String((err as { cause: unknown }).cause).slice(0, 500)
          : undefined,
    });
    const rawMessage =
      err instanceof Error ? err.message : "Extraction failed";
    const lower = rawMessage.toLowerCase();
    const family = parsed.data.model
      ? resolveModel(parsed.data.model).family
      : undefined;
    const envVar = directKeyEnvVar(family);

    // OpenAI quota / org-verification errors. These are NOT code bugs —
    // they're billing/account issues at OpenAI's end. Rewrite the raw
    // OpenAI message into something actionable.
    const isOpenAiQuota =
      family === "openai" &&
      (lower.includes("exceeded your current quota") ||
        lower.includes("insufficient_quota"));
    const isOpenAiOrgVerification =
      family === "openai" &&
      lower.includes("organization must be verified");

    const message = isOpenAiQuota
      ? `${parsed.data.model}: Your OpenAI account has no remaining credit. Add credit at https://platform.openai.com/settings/organization/billing/overview, then retry. (Other models in this comparison may still work — Claude / Gemini / Manus use separate billing.)`
      : isOpenAiOrgVerification
        ? `${parsed.data.model}: OpenAI requires "Verified Organization" status for this model. Go to https://platform.openai.com/settings/organization/general and click "Verify Organization" (may need a government ID; takes ~15 min to propagate after approval). For now, use GPT-4o, GPT-5.5, or any Claude/Gemini model instead.`
        : lower.includes("insufficient funds") || lower.includes("insufficient_funds")
          ? envVar
            ? `${parsed.data.model} routed through the Vercel AI Gateway, which is out of credit. Fix: either (1) add ${envVar} to your Vercel project environment variables to route this model directly, OR (2) top up the AI Gateway at vercel.com → AI Gateway → Top up.`
            : `${parsed.data.model} routed through the Vercel AI Gateway, which is out of credit. Top up the gateway, or pick a different model.`
          : rawMessage.includes("did not match schema")
            ? "분석할 수 없는 형식입니다. 학술 자료가 아닌, 실제 사건의 사실관계(당사자, 청구원인, 일시 등)를 포함하여 입력해 주세요. / The input doesn't look like a case — please include real party facts, claims, and dates."
            : rawMessage.includes("could not parse")
              ? "모델이 유효한 JSON을 반환하지 못했습니다. 다른 모델로 다시 시도해 주세요. / Model returned unparseable output — try a different model."
              : rawMessage;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Map a model family to the env var name that would route it direct
 * (bypassing the gateway). Used in error messages so the user knows
 * exactly which Vercel env var to set when the gateway is empty.
 */
function directKeyEnvVar(family: string | undefined): string | undefined {
  switch (family) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    case "manus":
      return "MANUS_API_KEY";
    default:
      return undefined;
  }
}

/**
 * Compose the prompt we hand to Manus. The narrative already contains
 * the user's question + any attached files (assembled by chat-input's
 * buildNarrative). We pass it through with only a minimal Korean-legal
 * context hint — NO 5-step research instructions, NO "find precedents
 * with case numbers" directive.
 *
 * Why so minimal: Manus's lite profile is fast (~15-60s) for plain
 * chat-style answers, but the moment you ask for "supreme court
 * precedents with case numbers + citability assessment" the model
 * re-engages its autonomous-agent skills and the call balloons to
 * 5+ minutes. The user's intent (e.g. "find precedents on X") is
 * already inside the narrative — let Manus respond at chat speed.
 */
function buildManusPrompt(narrative: string, locale: "ko" | "en"): string {
  const isKo = locale === "ko";
  // Same default-detailed rule as the other LLMs (extractor.ts SYSTEM_PROMPT).
  // Manus's lite profile follows natural-language instructions, so a short
  // hint up front sets the response depth.
  const hint = isKo
    ? `한국 법률 자문 맥락에서의 질문입니다. 답변 규칙:
- 기본: 변호사가 사용할 수 있는 상세하고 구조화된 법률 분석을 작성합니다 (3–6 단락, 15–30 문장). 짧은 요약으로 줄이지 마세요.
- 예외: 사용자가 명시적으로 "요약" / "summarize" / "TL;DR" 등을 요청한 경우에만 4–8 문장의 짧은 요약으로 답합니다.
- 한국 법률 용어(쟁점, 청구원인, 판시사항, 법률관계, 인용 가능성 등)는 영어 답변에서도 그대로 유지합니다.
- 가독성을 위해 단락 구분을 사용하되, markdown bullet 목록은 피하고 산문 형식으로 작성합니다.`
    : `This is a Korean legal advice context. Response rules:
- DEFAULT: write a detailed, structured legal analysis a lawyer can actually use (3–6 paragraphs, 15–30 sentences). Do NOT compress to a summary unless asked.
- EXCEPTION: only when the user explicitly asks for a summary ('summarize', '요약', 'TL;DR'), give a 4–8 sentence short summary instead.
- Preserve Korean legal terms (쟁점, 청구원인, 판시사항, 법률관계, 인용 가능성 etc.) inline even in English.
- Use clear paragraph breaks; avoid markdown bullets — write in prose form.`;
  return `${hint}\n\n---\n\n${narrative.trim()}`;
}
