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
  //
  // Format convention for ALL exhausted-credit messages below:
  //   Line 1 (Korean):  💳 "Law Agent에서 ChatGPT를 사용하시려면 OpenAI 잔액을 먼저 충전해주세요."
  //   Line 2 (Korean):  Provider direct link
  //   Line 3 (Korean):  "다른 모델은 계속 사용 가능합니다: …" (when applicable)
  //   Blank line
  //   Line 5 (English): "Your OpenAI credit has run out — please recharge first to keep using ChatGPT in Law Agent."
  //   Line 6 (English): Provider direct link
  //   Line 7 (English): Available-alternatives hint

  const isOpenAiQuota =
    family === "openai" &&
    (lower.includes("exceeded your current quota") ||
      lower.includes("insufficient_quota"));
  if (isOpenAiQuota) {
    return (
      `${tag}💳 Law Agent에서 ChatGPT를 사용하시려면 OpenAI 잔액을 먼저 충전해 주세요.\n` +
      `결제: https://platform.openai.com/settings/organization/billing/overview\n` +
      `다른 모델은 별도 결제이므로 Claude / Gemini / Manus / 무료 모델은 계속 사용하실 수 있습니다.\n\n` +
      `💳 Your OpenAI credit has run out — please recharge first to keep using ChatGPT in Law Agent.\n` +
      `Billing: https://platform.openai.com/settings/organization/billing/overview\n` +
      `Other models use separate billing — Claude / Gemini / Manus / free models still work.`
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
      `${tag}💳 Law Agent에서 Claude를 사용하시려면 Anthropic 잔액을 먼저 충전해 주세요.\n` +
      `결제: https://console.anthropic.com/settings/billing\n` +
      `다른 모델(ChatGPT / Gemini / Manus / 무료 모델)은 계속 사용 가능합니다.\n\n` +
      `💳 Your Anthropic credit has run out — please recharge first to keep using Claude in Law Agent.\n` +
      `Billing: https://console.anthropic.com/settings/billing\n` +
      `Other models (ChatGPT / Gemini / Manus / free) still work.`
    );
  }

  const isGoogleQuota =
    family === "google" &&
    (lower.includes("resource_exhausted") ||
      lower.includes("quota exceeded") ||
      lower.includes("rate limit"));
  if (isGoogleQuota) {
    return (
      `${tag}💳 Law Agent에서 Gemini를 사용하시려면 Google AI Studio 무료 한도를 다시 받거나 결제를 설정해 주세요.\n` +
      `(무료 한도: 1,500회/일 — 몇 분 후 자동 복구되거나, 결제 설정 시 즉시 사용 가능)\n` +
      `결제·키 관리: https://aistudio.google.com/apikey\n\n` +
      `💳 Your Gemini free quota is exhausted (1,500 req/day). It auto-resets in a few minutes, or you can set up billing for instant uplift.\n` +
      `Billing / keys: https://aistudio.google.com/apikey\n` +
      `Other models (Claude / ChatGPT / Manus / free Groq models) still work in the meantime.`
    );
  }

  // Groq free tier — Open GPT 120B and Open GPT 20B. Both hit the same
  // 14,400 req/day shared quota.
  const isGroqQuota =
    family === "groq" &&
    (lower.includes("rate_limit_exceeded") ||
      lower.includes("rate limit") ||
      lower.includes("quota") ||
      lower.includes("429"));
  if (isGroqQuota) {
    return (
      `${tag}💳 Law Agent에서 무료 모델(Open GPT 120B / Open GPT 20B)의 일일 사용량을 초과했습니다.\n` +
      `Groq 무료 한도: 14,400회/일 — UTC 자정에 자동 초기화됩니다.\n` +
      `즉시 사용하시려면 Claude / Gemini / ChatGPT 중 하나를 선택해 주세요.\n` +
      `Groq 결제: https://console.groq.com/settings/billing\n\n` +
      `💳 You've exhausted today's free quota on Groq (Open GPT 120B / Open GPT 20B).\n` +
      `Free limit is 14,400 req/day — auto-resets at UTC midnight.\n` +
      `For immediate use, pick Claude / Gemini / ChatGPT instead.\n` +
      `Groq billing: https://console.groq.com/settings/billing`
    );
  }

  const isManusCredit =
    family === "manus" &&
    (lower.includes("insufficient credit") ||
      lower.includes("credit balance") ||
      lower.includes("not enough credit"));
  if (isManusCredit) {
    return (
      `${tag}💳 Law Agent에서 Manus 에이전트를 사용하시려면 Manus 크레딧을 먼저 충전해 주세요.\n` +
      `결제: https://manus.im/settings/billing\n` +
      `다른 모델(Claude / ChatGPT / Gemini / 무료 모델)은 계속 사용 가능합니다.\n\n` +
      `💳 Your Manus credits have run out — please recharge first to keep using the Manus agent in Law Agent.\n` +
      `Billing: https://manus.im/settings/billing\n` +
      `Other models (Claude / ChatGPT / Gemini / free) still work.`
    );
  }

  // ── Invalid / expired / revoked API key ───────────────────────────
  //
  // Distinct from the "out of credit" cases above: the account may be
  // perfectly funded, but the KEY itself no longer authenticates. Every
  // provider words this differently, so match on the shared vocabulary.
  // Without this branch the user just sees the raw provider string
  // ("API key is invalid.") with no clue which key or where to fix it.
  const keyEnvVar = directKeyEnvVar(family);
  const isInvalidKey =
    lower.includes("api key is invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("incorrect api key") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication_error") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthorized");
  if (isInvalidKey) {
    const providerLabel = providerDisplayName(family);
    const consoleUrl = providerKeyConsoleUrl(family);
    return (
      `${tag}🔑 ${providerLabel} API 키가 유효하지 않습니다 (만료되었거나 취소된 키입니다).\n` +
      `잔액 문제가 아니라 키 자체의 문제이므로, 새 키를 발급받아 교체해 주세요.\n` +
      (consoleUrl ? `키 발급: ${consoleUrl}\n` : "") +
      (keyEnvVar
        ? `교체 위치: 로컬 \`.env.local\` 의 ${keyEnvVar}, 그리고 Vercel 프로젝트 환경 변수.\n`
        : "") +
      `무료 모델(Open GPT 120B)은 별도 키를 쓰므로 지금도 정상 작동합니다.\n\n` +
      `🔑 Your ${providerLabel} API key is invalid (expired or revoked).\n` +
      `This is not a billing problem — the key itself no longer authenticates, so issue a new one.\n` +
      (consoleUrl ? `Get a key: ${consoleUrl}\n` : "") +
      (keyEnvVar
        ? `Replace it in \`.env.local\` (${keyEnvVar}) AND in your Vercel project env vars.\n`
        : "") +
      `The free model (Open GPT 120B) uses a separate key and still works right now.`
    );
  }

  // ── Vercel AI Gateway insufficient funds (generic) ────────────────
  const envVar = keyEnvVar;
  if (
    lower.includes("insufficient funds") ||
    lower.includes("insufficient_funds")
  ) {
    return envVar
      ? `${tag}💳 Law Agent의 AI 게이트웨이 잔액이 부족합니다.\n` +
        `해결 방법 (둘 중 하나):\n` +
        `  1) Vercel 프로젝트 환경 변수에 ${envVar}를 추가하여 직접 라우팅 — 즉시 사용 가능\n` +
        `  2) Vercel → AI Gateway → Top up 에서 충전\n\n` +
        `💳 Law Agent's AI Gateway is out of credit.\n` +
        `Either: (1) add ${envVar} to your Vercel env vars to route this model directly, OR (2) top up at vercel.com → AI Gateway → Top up.`
      : `${tag}💳 Law Agent의 AI 게이트웨이 잔액이 부족합니다. 결제 페이지에서 충전하시거나 다른 모델을 선택해 주세요.\n\n` +
        `💳 Law Agent's AI Gateway is out of credit. Top up, or pick a different model.`;
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
    case "groq":
      return "GROQ_API_KEY";
    case "manus":
      return "MANUS_API_KEY";
    default:
      return undefined;
  }
}

/** User-recognizable brand name for a family — matches FAMILY_LABELS. */
function providerDisplayName(family: string | undefined): string {
  switch (family) {
    case "anthropic":
      return "Claude (Anthropic)";
    case "openai":
      return "ChatGPT (OpenAI)";
    case "google":
      return "Gemini (Google AI Studio)";
    case "groq":
      return "Groq";
    case "manus":
      return "Manus";
    default:
      return "AI 제공자 / provider";
  }
}

/** Where the user goes to mint a replacement key for this family. */
function providerKeyConsoleUrl(family: string | undefined): string | undefined {
  switch (family) {
    case "anthropic":
      return "https://console.anthropic.com/settings/keys";
    case "openai":
      return "https://platform.openai.com/api-keys";
    case "google":
      return "https://aistudio.google.com/apikey";
    case "groq":
      return "https://console.groq.com/keys";
    case "manus":
      return "https://manus.im/settings/api";
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
