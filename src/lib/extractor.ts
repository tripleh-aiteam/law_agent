import { generateObject } from "ai";
import { z } from "zod";
import { LegalElementsSchema, type LegalElements, type ClarifyingQuestion } from "./types";
import { EXTRACTION_MODEL } from "./ai";
import { safeModelId } from "./models";

/**
 * Schema used for the extraction call. We extend LegalElementsSchema with a
 * clarifyingQuestions field so the model produces both in a single call —
 * cheaper, lower-latency, and the model can ground each question in the gaps
 * it actually noticed during extraction.
 */
const ExtractionResponseSchema = LegalElementsSchema.extend({
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

Your job is to extract structured legal elements from a user's narrative AND surface the highest-impact clarifying questions a Korean attorney would ask before relying on retrieved 판례.

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

const TIMEOUT_MS = 45_000;

/**
 * Extracts structured Korean legal elements and clarifying questions from a
 * free-form narrative. Elements are always Korean; clarifying questions are
 * in the caller's locale.
 */
export async function extractLegalElements(
  narrative: string,
  locale: "ko" | "en",
  modelId?: string,
): Promise<{ elements: LegalElements; clarifyingQuestions: ClarifyingQuestion[] }> {
  const userPrompt = [
    `User locale (for clarifyingQuestions only): ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    "",
    "Narrative:",
    "---",
    narrative.trim(),
    "---",
    "",
    "Extract the legal elements in Korean. Write clarifyingQuestions in the user locale above.",
  ].join("\n");

  // If the caller passes a model ID, route via AI Gateway (string form).
  // Otherwise fall back to the default direct-Groq EXTRACTION_MODEL.
  const model = modelId ? safeModelId(modelId) : EXTRACTION_MODEL;

  const result = await generateObject({
    model,
    schema: ExtractionResponseSchema,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    maxOutputTokens: 2048,
  });

  const { clarifyingQuestions, ...elements } = result.object as ExtractionResponse;
  return {
    elements: elements as LegalElements,
    clarifyingQuestions: clarifyingQuestions as ClarifyingQuestion[],
  };
}
