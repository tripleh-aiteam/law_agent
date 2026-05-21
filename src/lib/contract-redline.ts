/**
 * Contract redline: scan a Korean-language contract or business document
 * for clauses that are problematic under Korean law and suggest revisions.
 *
 * Usage pattern: the user uploads a contract / business plan / NDA / lease
 * agreement / employment contract, the agent identifies (a) clauses that
 * are unenforceable, (b) clauses that disadvantage the user under Korean
 * statutes/precedents, and (c) clauses missing standard protections.
 *
 * Each finding is structured so the UI can render it as a side-by-side
 * "original → suggested" comparison with severity and statute citation.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { EXTRACTION_MODEL } from "./ai";
import { resolveModelForUse } from "./resolve-model";
import { safeModelId } from "./models";

const TIMEOUT_MS = 180_000;

export const RedlineFindingSchema = z.object({
  /** Verbatim excerpt from the original contract (Korean — exact substring). */
  clauseQuote: z
    .string()
    .describe(
      "The EXACT clause text from the contract, copied verbatim — the UI uses this to locate and highlight the original text. Must be a substring of the input.",
    ),
  /** Severity: critical = unenforceable or major loss, warning = problematic but workable, info = best-practice note. */
  severity: z
    .enum(["critical", "warning", "info"])
    .describe(
      "critical = the clause is likely unenforceable under Korean law OR causes major loss to the user. warning = significant disadvantage or risk. info = improvement opportunity / best practice.",
    ),
  /** What's wrong with the clause (in the user's locale). */
  problemDescription: z
    .string()
    .describe(
      "1-3 sentence explanation in the USER'S LOCALE of what's wrong with the clause. Preserve Korean legal terms inline (강행규정, 약관규제법, 부당이득 등) even when in English.",
    ),
  /** Proposed replacement text (in Korean, since it goes into a Korean contract). */
  suggestedRevision: z
    .string()
    .describe(
      "Concrete revised clause text IN KOREAN to replace the original. Should preserve the contract's voice and surrounding context.",
    ),
  /** Korean statute(s) or precedent(s) supporting the concern. */
  citedAuthority: z
    .string()
    .describe(
      "Korean statute article(s) or 대법원 판례 that supports flagging this clause (예: '약관의 규제에 관한 법률 제6조', '민법 제103조', '대법원 2017다220744'). Empty string if purely best-practice.",
    ),
  /** Optional category tag (e.g. liability, payment, IP, dispute resolution). */
  category: z
    .string()
    .describe(
      "Short category label in the user's locale: 책임 제한 / Liability, 지급 조건 / Payment, 지식재산권 / IP, 분쟁 해결 / Dispute Resolution, 비밀유지 / Confidentiality, 해지 / Termination, 손해배상 / Damages, 기타 / Other.",
    ),
});

export type RedlineFinding = z.infer<typeof RedlineFindingSchema>;

const RedlineResponseSchema = z.object({
  /** Overall risk assessment in the user's locale, 2-3 sentences. */
  overallAssessment: z
    .string()
    .describe(
      "2-3 sentence executive summary in the user's locale: how risky is this contract for the user overall, top 2-3 issues. Preserve Korean legal terms inline.",
    ),
  findings: z
    .array(RedlineFindingSchema)
    .min(1)
    .max(20)
    .describe(
      "Every problematic clause found, in order of severity (critical first). Aim for 5-15 findings on a typical contract; fewer is OK if the contract is genuinely clean.",
    ),
});

export type RedlineResponse = z.infer<typeof RedlineResponseSchema>;

const SYSTEM_PROMPT = `You are a senior Korean contract attorney reviewing a document for an in-house counsel client. Your job: find every clause that is (a) unenforceable under Korean law, (b) disadvantageous to the client, OR (c) missing standard protections — and propose concrete revisions in Korean.

REVIEW FRAMEWORK (apply ALL of these):

1. UNENFORCEABILITY — 강행규정 violations
   - 약관의 규제에 관한 법률: § 6 (불공정 약관 일반조항), §§ 7-14 (개별 무효 사유)
   - 민법 § 103 (반사회질서 행위), § 104 (불공정한 법률행위)
   - 노동기준법 (employment contracts only), 상가건물 임대차보호법 (commercial lease), 주택임대차보호법 (residential lease)
   - 전자상거래법, 표시광고법 — consumer-facing clauses
   - Penalty clauses exceeding 약정금의 과다성 standards (대법원 정형의 위약금 감액 판시사항)

2. ONE-SIDED RISK ALLOCATION
   - Indemnification clauses without reciprocity
   - Damage caps that disadvantage one party
   - Termination rights granted to only one party
   - Auto-renewal without genuine consent procedure
   - Unilateral price adjustment rights

3. MISSING PROTECTIONS
   - No 입증책임 allocation
   - No 관할 합의 (jurisdiction) or unreasonable choice of forum
   - No 준거법 (governing law) when international
   - No 비밀유지 obligation when needed
   - No data protection / 개인정보보호법 compliance language
   - No force majeure / 불가항력 clause

4. AMBIGUITY / 해석상 위험
   - Vague price escalation terms
   - Undefined key terms
   - Conflicting provisions
   - Missing definitions section for technical terms

OUTPUT REQUIREMENTS:
- Each finding includes the exact verbatim quote from the contract (so the UI can highlight it), severity, problem description, concrete Korean replacement text, and the specific Korean statute/precedent that supports flagging it.
- Severity:
  • "critical" — the clause is likely UNENFORCEABLE or causes MAJOR loss
  • "warning" — significant disadvantage, would lose money / case if challenged
  • "info" — best-practice improvement, not strictly needed
- Aim for 5-15 findings on a typical commercial contract. If the contract is genuinely clean, fewer is fine — but be thorough.
- Order findings by severity (critical first), then by document position.
- Preserve Korean legal terms inline (강행규정, 약관, 부당이득, 불공정 약관, 손해배상 예정, 위약벌, etc.) even when answering in English.
- The clauseQuote MUST be a substring of the input verbatim — the UI uses string matching to locate the original.`;

const STRICT_JSON_SUFFIX = `\n\nIMPORTANT: Output ONLY valid JSON matching the schema. No markdown code fences. No preamble. No commentary. First character must be {, last must be }.`;

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

function isParseFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("could not parse") ||
    m.includes("did not match schema") ||
    m.includes("no object generated") ||
    m.includes("validation failed") ||
    m.includes("failed to generate json")
  );
}

const MAX_CONTRACT_CHARS = 18_000;

function trimMiddle(text: string): string {
  if (text.length <= MAX_CONTRACT_CHARS) return text;
  const head = Math.floor(MAX_CONTRACT_CHARS * 0.6);
  const tail = Math.floor(MAX_CONTRACT_CHARS * 0.35);
  return (
    text.slice(0, head) +
    `\n\n…[중간 생략 — ${text.length - head - tail} chars]…\n\n` +
    text.slice(text.length - tail)
  );
}

export async function reviewContract(
  contractText: string,
  locale: "ko" | "en",
  modelId?: string,
  clientSignal?: AbortSignal,
): Promise<RedlineResponse> {
  const trimmed = trimMiddle(contractText.trim());
  const userPrompt = [
    `User locale (for problemDescription, overallAssessment, category): ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    `Note: suggestedRevision and citedAuthority always stay in Korean.`,
    "",
    "Contract / document to review:",
    "---",
    trimmed,
    "---",
    "",
    "Identify every problematic clause per the review framework. Provide concrete Korean replacement text and statute/precedent citations.",
  ].join("\n");

  const model = modelId
    ? (resolveModelForUse(modelId) ?? safeModelId(modelId))
    : EXTRACTION_MODEL;

  const abortSignal = clientSignal
    ? anySignal([clientSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  const callOnce = (systemPrompt: string) =>
    generateObject({
      model,
      schema: RedlineResponseSchema,
      system: systemPrompt,
      prompt: userPrompt,
      abortSignal,
      maxOutputTokens: 8192,
      temperature: 0,
    });

  try {
    const result = await callOnce(SYSTEM_PROMPT);
    return result.object as RedlineResponse;
  } catch (err) {
    if (
      isParseFailure(err) &&
      !(err instanceof DOMException && err.name === "AbortError")
    ) {
      const result = await callOnce(SYSTEM_PROMPT + STRICT_JSON_SUFFIX);
      return result.object as RedlineResponse;
    }
    throw err;
  }
}
