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
    const family = parsed.data.model
      ? resolveModel(parsed.data.model).family
      : undefined;
    const message = friendlyExtractError(
      rawMessage,
      family,
      parsed.data.model,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Convert raw provider error messages into bilingual (Korean + English)
 * user-facing guidance. Every "no money" case follows the same template:
 *   [한국어] 잔액을 충전한 후 다시 시도해 주세요. <provider-specific link>
 *   [English] Please recharge your balance and retry. <link>
 *
 * Other recoverable errors (schema, JSON parse) get bilingual hints too.
 * Unknown errors pass through the raw message untouched so we don't hide
 * useful debugging info.
 */
function friendlyExtractError(
  rawMessage: string,
  family: string | undefined,
  modelLabel: string | undefined,
): string {
  const lower = rawMessage.toLowerCase();
  const tag = modelLabel ? `[${modelLabel}] ` : "";

  // ── Provider "no funds" / quota patterns ──────────────────────────
  const isOpenAiQuota =
    family === "openai" &&
    (lower.includes("exceeded your current quota") ||
      lower.includes("insufficient_quota"));
  if (isOpenAiQuota) {
    return (
      `${tag}❗ OpenAI 잔액이 부족합니다. 결제 페이지에서 충전 후 다시 시도해 주세요: ` +
      `https://platform.openai.com/settings/organization/billing/overview\n` +
      `(다른 모델은 별도 결제 — Claude / Gemini / Manus 는 계속 사용 가능합니다.)\n\n` +
      `❗ Your OpenAI account has no remaining credit. Please recharge at ` +
      `https://platform.openai.com/settings/organization/billing/overview and retry. ` +
      `(Other models use separate billing — Claude / Gemini / Manus still work.)`
    );
  }

  const isOpenAiOrgVerification =
    family === "openai" && lower.includes("organization must be verified");
  if (isOpenAiOrgVerification) {
    return (
      `${tag}❗ 이 OpenAI 모델은 조직 인증(Verified Organization)이 필요합니다. ` +
      `https://platform.openai.com/settings/organization/general 에서 "Verify Organization"을 완료해 주세요 (신분증 필요, 승인 후 약 15분 소요). ` +
      `현재는 ChatGPT 5.5 / Claude / Gemini 를 대신 사용해 주세요.\n\n` +
      `❗ This OpenAI model requires Verified Organization status. ` +
      `Complete verification at https://platform.openai.com/settings/organization/general ` +
      `(ID required, ~15 min to propagate after approval). For now, use ChatGPT 5.5 / Claude / Gemini instead.`
    );
  }

  const isAnthropicLowBalance =
    family === "anthropic" &&
    (lower.includes("credit_balance_too_low") ||
      lower.includes("credit balance is too low") ||
      lower.includes("billing.anthropic"));
  if (isAnthropicLowBalance) {
    return (
      `${tag}❗ Anthropic 잔액이 부족합니다. 결제 페이지에서 충전 후 다시 시도해 주세요: ` +
      `https://console.anthropic.com/settings/billing\n\n` +
      `❗ Your Anthropic account credit is too low. Please recharge at ` +
      `https://console.anthropic.com/settings/billing and retry.`
    );
  }

  const isGoogleQuota =
    family === "google" &&
    (lower.includes("resource_exhausted") ||
      lower.includes("quota exceeded") ||
      lower.includes("rate limit"));
  if (isGoogleQuota) {
    return (
      `${tag}❗ Google AI Studio 무료 한도(1,500 req/day)를 초과했거나 일시적 속도 제한입니다. 몇 분 후 다시 시도하거나 결제를 설정해 주세요: ` +
      `https://aistudio.google.com/apikey\n\n` +
      `❗ Google AI Studio quota exceeded (free tier is 1,500 req/day) or rate-limited. ` +
      `Wait a few minutes and retry, or set up billing at https://aistudio.google.com/apikey.`
    );
  }

  const isManusCredit =
    family === "manus" &&
    (lower.includes("insufficient credit") ||
      lower.includes("credit balance") ||
      lower.includes("not enough credit"));
  if (isManusCredit) {
    return (
      `${tag}❗ Manus 크레딧이 부족합니다. 충전 후 다시 시도해 주세요: ` +
      `https://manus.im/settings/billing\n\n` +
      `❗ Your Manus account is out of credits. Please recharge at ` +
      `https://manus.im/settings/billing and retry.`
    );
  }

  // ── Vercel AI Gateway insufficient funds (generic) ────────────────
  const envVar = directKeyEnvVar(family);
  if (
    lower.includes("insufficient funds") ||
    lower.includes("insufficient_funds")
  ) {
    return envVar
      ? `${tag}❗ Vercel AI Gateway 잔액이 부족합니다. 직접 라우팅을 위해 Vercel 프로젝트 환경 변수에 ${envVar}를 설정하거나, ` +
        `vercel.com → AI Gateway → Top up 에서 충전해 주세요.\n\n` +
        `❗ The Vercel AI Gateway is out of credit. Either (1) add ${envVar} to your Vercel project environment variables to route this model directly, OR (2) top up the gateway at vercel.com → AI Gateway → Top up.`
      : `${tag}❗ Vercel AI Gateway 잔액이 부족합니다. 충전 후 다시 시도하거나 다른 모델을 선택해 주세요.\n\n` +
        `❗ The Vercel AI Gateway is out of credit. Top up, or pick a different model.`;
  }

  // ── Recoverable LLM output issues ─────────────────────────────────
  if (rawMessage.includes("did not match schema")) {
    return (
      `❗ 분석할 수 없는 형식입니다. 학술 자료가 아닌, 실제 사건의 사실관계(당사자, 청구원인, 일시 등)를 포함하여 입력해 주세요.\n\n` +
      `❗ The input doesn't look like a case — please include real party facts, claims, and dates.`
    );
  }
  if (
    rawMessage.includes("could not parse") ||
    lower.includes("failed to generate json") ||
    lower.includes("failed_generation")
  ) {
    return (
      `${tag}❗ 모델이 유효한 JSON 형식으로 답변을 생성하지 못했습니다. 다른 모델로 다시 시도해 주세요.\n\n` +
      `❗ Model couldn't produce valid JSON. Try a different model, or shorten the prompt.`
    );
  }

  // ── Unknown / unmapped — pass through but tag with the model ──────
  return `${tag}${rawMessage}`;
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
  // Same hard-minimum detailed rule as the other LLMs.
  const hint = isKo
    ? `한국 법률 자문 맥락에서의 질문입니다. 답변 규칙(엄격):

[필수 최소 길이]
- 최소 8단락, 50문장, 한국어 2,500자 이상. 짧으면 실패한 답변입니다.

[필수 구조 — 모든 섹션을 빠짐없이 포함]
① 사건 개요  ② 핵심 쟁점  ③ 적용 법령(조문 번호 포함)
④ 판례 적용  ⑤ 당사자별 논거(원·피고 양측)
⑥ 전략적 고려사항(입증책임/시효 포함)  ⑦ 권고 사항

[예외 — 짧은 요약은 사용자가 명시적으로 "요약", "summarize", "TL;DR", "사례 요약", "case summary" 키워드를 쓴 경우에만]
- 그때만 4–8문장으로 답합니다.

[기타]
- 한국 법률 용어(쟁점, 청구원인, 판시사항, 법률관계, 인용 가능성, 입증책임, 소멸시효 등)는 영어 답변에서도 그대로 유지.
- 단락 구분 사용, markdown bullet 목록 피하고 산문 형식.`
    : `Korean legal advice context. Response rules (strict):

[MANDATORY MINIMUM LENGTH]
- At least 8 paragraphs, 50 sentences, 3,500 English characters. Shorter = failed response.

[REQUIRED STRUCTURE — include ALL sections]
① Case Overview  ② Core Issues  ③ Applicable Statutes (with article numbers)
④ Precedent Analysis  ⑤ Per-party Arguments (both sides)
⑥ Strategic Considerations (incl. burden of proof / statute of limitations)  ⑦ Recommendations

[EXCEPTION — short summary ONLY when the user explicitly used a summary keyword ('summarize', '요약', 'TL;DR', 'brief', 'case summary')]
- Then 4–8 sentences only.

[Other]
- Preserve Korean legal terms (쟁점, 청구원인, 판시사항, 법률관계, 인용 가능성, 입증책임, 소멸시효 등) inline even in English.
- Use paragraph breaks; avoid markdown bullets — write in prose.`;
  return `${hint}\n\n---\n\n${narrative.trim()}`;
}
