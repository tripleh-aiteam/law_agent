import { generateObject } from "ai";
import { z } from "zod";
import { LegalElementsSchema, type LegalElements, type ClarifyingQuestion } from "./types";
import { EXTRACTION_MODEL } from "./ai";
import { safeModelId } from "./models";
import { resolveModelForUse } from "./resolve-model";

/**
 * Schema used for the extraction call. We extend LegalElementsSchema with a
 * clarifyingQuestions field so the model produces both in a single call —
 * cheaper, lower-latency, and the model can ground each question in the gaps
 * it actually noticed during extraction.
 */
const ExtractionResponseSchema = LegalElementsSchema.extend({
  /**
   * Manus-style plain-language summary of the input. Always populated — even
   * when the input is a judgment PDF or a non-case document. This lets the
   * UI show a useful answer for "summarize this PDF" requests without
   * needing a separate endpoint.
   */
  summary: z
    .string()
    .describe(
      "1–2 paragraphs (4–8 sentences total) in the USER'S LOCALE summarizing the input. If the input is a judgment, summarize the holding + key reasoning. If it is a fact pattern, restate the dispute concisely. Preserve Korean legal terms (판결, 청구원인 등) inline even in English."
    ),
  clarifyingQuestions: z
    .array(
      z.object({
        id: z.string().describe("Short stable identifier, e.g. 'q_party_type'"),
        question: z.string().describe("The clarifying question, in the user's locale"),
        why: z.string().describe("Why this question matters for precedent matching, in the user's locale"),
      })
    )
    .max(4)
    .describe("0–4 highest-impact clarifying questions. Empty array when the narrative is already rich."),
});

type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

const SYSTEM_PROMPT = `You are a senior Korean litigation paralegal preparing a fact-pattern for 판례 (case law) retrieval against the Korean Supreme Court (대법원) corpus.

Your job is to (1) write a plain-language summary of the input, (2) extract structured legal elements, and (3) surface the highest-impact clarifying questions a Korean attorney would ask before relying on retrieved 판례.

SUMMARY RULES (critical for non-case inputs):
- ALWAYS produce a summary, even when the input is a court judgment, an academic excerpt, an email thread, or a draft pleading — never refuse and never leave it blank.
- 1–2 paragraphs, 4–8 sentences total, in the USER'S LOCALE.
- If the input is a 판결문 (judgment): identify the court, the parties, the holding, and the key reasoning. Name the controlling statute.
- If the input is a fact pattern: restate the dispute, the parties' positions, and what the user is asking the system to do.
- Preserve Korean legal terms inline (e.g. 판시사항, 청구원인) even when the rest of the summary is English.

LANGUAGE RULES (critical):
- ALL extracted legal elements (청구원인, 법률관계, 쟁점, 당사자 지위, 손해 종류, 적용 법령, keyFacts, missingInfo, parties) MUST be written in Korean, regardless of the input language. This is because the 판례 corpus is Korean and the extraction is used directly for semantic retrieval.
- Use canonical Korean legal terminology: 청구원인, 법률관계, 쟁점, 당사자 지위, 손해 종류, 적용 법령, 원고/피고, 계약, 불법행위, 부당이득, 손해배상 등.
- Statute citations should follow Korean conventions (e.g. "민법 제750조", "상법 제382조의3", "근로기준법 제23조").
- clarifyingQuestions.question and clarifyingQuestions.why MUST be written in the user's locale (provided in the user prompt). Everything else stays Korean.

EXTRACTION RULES:
- Be concrete. Avoid generic placeholders like "분쟁" or "당사자 간 문제".
- 쟁점 (coreIssue) is the controlling legal question, not a fact summary. Phrase it as a question the court would answer.
- keyFacts: only load-bearing facts that move the legal analysis. Strip narrative color.
- missingInfo: facts that would CHANGE the analysis if known — not nice-to-haves.
- applicableStatutes: include specific articles when the narrative supports it; if only the statute is clear, list the statute alone.
- caseNature: pick the single best match from the enum.

CLARIFYING QUESTIONS RULES:
- Produce 0 questions if the narrative already covers party type, written agreement existence, jurisdiction/venue, timeline, and prior litigation.
- Otherwise, ask up to 4 of the HIGHEST-IMPACT questions a Korean attorney would ask. Prioritize:
  1. Party type (natural person vs. juristic person; consumer vs. business; employer vs. employee).
  2. Existence/form of written agreement (계약서, 각서, 합의서).
  3. Jurisdiction / venue / governing law where ambiguous.
  4. Timeline gaps (소멸시효, 제척기간 implications).
  5. Prior litigation, mediation, or administrative proceeding history.
- Each question must be one a Korean lawyer would actually ask aloud — short, direct, no hedging.
- "why" explains in 1 sentence how the answer would change which 판례 are citable.
- IDs are stable snake_case identifiers (e.g. q_party_type, q_written_agreement, q_jurisdiction, q_timeline_gap, q_prior_litigation).`;

const TIMEOUT_MS = 90_000;

/**
 * Cap the narrative sent to the LLM. Large PDFs combined with the question
 * and the system prompt can otherwise blow past slow models' practical
 * timeouts (e.g. Claude Opus on a 25k-char attachment).
 *
 * We trim the MIDDLE of overly-long narratives, keeping both the start
 * (often the user's question + recent facts) and the end (often citations
 * or judgment text from attached files). Result: representative slice
 * that fits within most premium models' tactical budget.
 */
const MAX_NARRATIVE_CHARS = 18_000;

function trimMiddle(narrative: string): string {
  if (narrative.length <= MAX_NARRATIVE_CHARS) return narrative;
  const head = Math.floor(MAX_NARRATIVE_CHARS * 0.6);
  const tail = Math.floor(MAX_NARRATIVE_CHARS * 0.35);
  return (
    narrative.slice(0, head) +
    `\n\n…[중간 생략 / middle truncated — ${narrative.length - head - tail} chars]…\n\n` +
    narrative.slice(narrative.length - tail)
  );
}

/**
 * Combines two AbortSignals into one — fires when either fires. Used so the
 * extractor honors both an internal timeout and the request's client-abort
 * signal (Stop button → fetch.abort()).
 */
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

/**
 * Extracts a plain-language summary, structured Korean legal elements, and
 * clarifying questions from a free-form narrative. Summary + clarifying
 * questions are in the caller's locale; elements are always Korean (used
 * downstream for semantic retrieval against the Korean corpus).
 */
export async function extractLegalElements(
  narrative: string,
  locale: "ko" | "en",
  modelId?: string,
  clientSignal?: AbortSignal,
): Promise<{
  elements: LegalElements;
  summary: string;
  clarifyingQuestions: ClarifyingQuestion[];
}> {
  const trimmedNarrative = trimMiddle(narrative.trim());
  const userPrompt = [
    `User locale (for summary + clarifyingQuestions): ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    "",
    "Input:",
    "---",
    trimmedNarrative,
    "---",
    "",
    "First, write the plain-language summary (user locale).",
    "Then extract the legal elements in Korean.",
    "Then write 0–4 clarifyingQuestions in the user locale.",
  ].join("\n");

  // Resolve the caller's selected model: prefer a direct provider when its
  // API key is set (more predictable rate limits, fewer hops), fall back
  // to the AI Gateway string form, else the module's default EXTRACTION_MODEL.
  const model = modelId
    ? (resolveModelForUse(modelId) ?? safeModelId(modelId))
    : EXTRACTION_MODEL;

  // Merge a 90s safety timeout with the client's Stop-button signal so EITHER
  // can cancel the upstream LLM call promptly.
  const abortSignal = clientSignal
    ? anySignal([clientSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  const result = await generateObject({
    model,
    schema: ExtractionResponseSchema,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    abortSignal,
    maxOutputTokens: 2048,
  });

  const { clarifyingQuestions, summary, ...elements } =
    result.object as ExtractionResponse;
  return {
    elements: elements as LegalElements,
    summary,
    clarifyingQuestions: clarifyingQuestions as ClarifyingQuestion[],
  };
}
