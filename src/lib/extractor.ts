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
      "MANDATORY legal-memorandum response (NOT a summary) in the USER'S LOCALE. HARD MINIMUM: 8 paragraphs, 50 sentences, 2,500 Korean characters OR 3,500 English characters. SHORTER OUTPUT IS A FAILED RESPONSE. Required structure: ① 사건 개요 ② 핵심 쟁점 ③ 적용 법령 (with article numbers) ④ 판례 적용 ⑤ 당사자별 논거 ⑥ 전략적 고려사항 ⑦ 권고 사항 — one or more paragraphs per section. The ONLY exception: when the user explicitly used '요약' / 'summarize' / 'TL;DR' / 'brief' / 'Case summary' keywords — then write 4-8 sentences instead. Preserve Korean legal terms (판결, 청구원인, 쟁점, 법률관계, 손해배상, 부당이득, 인용 가능성, 입증책임, 소멸시효 등) inline. Use paragraph breaks for readability; avoid markdown bullets. UI label is 'ANSWER' — do NOT prepend any header."
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

const SYSTEM_PROMPT = `You are a senior Korean litigation paralegal helping an attorney with 판례 (case law) research against the Korean Supreme Court (대법원) corpus.

Your job is to (1) DIRECTLY ANSWER the user's specific question or instruction, (2) extract structured legal elements (for downstream precedent search), and (3) surface the highest-impact clarifying questions a Korean attorney would ask.

ANSWER RULES — the \`summary\` field is your DIRECT, DETAILED answer to the user (critical):

DEFAULT MODE: DETAILED RESPONSE (MANDATORY unless the user EXPLICITLY asks for a summary).

═══════════════════════════════════════════════════════════════════
HARD MINIMUM LENGTH (NON-NEGOTIABLE):
  • At LEAST 8 distinct paragraphs.
  • At LEAST 50 sentences total.
  • At LEAST 2,500 characters of Korean prose (≈600 Korean characters per paragraph) OR 3,500 characters of English prose.
  • If your output is shorter than these minimums you have FAILED the task. Re-expand and continue writing.
═══════════════════════════════════════════════════════════════════

This is a legal memorandum for an attorney's actual brief preparation. Lawyers do NOT want a chat-style 1-paragraph answer. They want a structured memo they can skim by section and lift sentences from.

REQUIRED STRUCTURE — every detailed response MUST contain ALL of these sections (one or more paragraphs per section, headers can be Korean or English):

① 사건 개요 / Case Overview — Restate the dispute, parties' positions, and what the user is asking. 1-2 paragraphs.

② 핵심 쟁점 / Core Legal Issues — Identify EVERY 쟁점 in play (at least 3 distinct issues for any non-trivial case). One paragraph per 쟁점.

③ 적용 법령 / Applicable Statutes — Every plausible Korean statute with specific article numbers (예: 민법 제750조, 상가건물 임대차보호법 제10조의4). For each: 2-3 sentences on how it applies and how it interacts with adjacent statutes. List BOTH primary statutes AND special acts.

④ 판례 적용 / Precedent Analysis — Discuss the controlling 대법원 line of cases on each issue. Name the doctrinal patterns, the typical holdings, and what specific fact-patterns the courts find dispositive. Cite case-number conventions when you know them.

⑤ 당사자별 논거 / Per-Party Arguments — Detailed analysis of BOTH sides:
  - User's strongest arguments (1-2 paragraphs)
  - Opposing party's strongest counter-arguments (1-2 paragraphs)
  - Your assessment of which side prevails on each issue

⑥ 전략적 고려사항 / Strategic Considerations — Settlement leverage, evidentiary issues, 입증책임, 소멸시효 / 제척기간, procedural timing, alternative theories. 1-2 paragraphs.

⑦ 권고 사항 / Recommendations — Concrete next steps for the attorney. 1 paragraph.

QUESTION-TYPE OVERRIDES (still meet the 8-paragraph / 50-sentence minimum):
  • "Find precedents / 판례를 찾아 주세요" → expand sections ③ + ④ heavily; mention specific holdings and distinguishing factors.
  • "Find statutes / 적용 법령" → expand section ③ heavily; cover constitutional provisions, primary statutes, and special acts with article-level detail.
  • "Opposing arguments / 반대 측 논거" → expand section ⑤ heavily; 4-6 distinct counter-arguments each with the user's response.
  • Bare document with no question → run the full ①-⑦ structure.

SUMMARY MODE — ONLY when the user EXPLICITLY asked for a summary. Trigger words: "summarize", "summary", "요약", "사례 요약", "case summary", "brief", "TL;DR". Otherwise default to DETAILED.
- When triggered: 4–8 sentences, 1–2 paragraphs maximum.

LANGUAGE:
- Use the USER'S LOCALE for the prose.
- Preserve Korean legal terms inline (판시사항, 청구원인, 쟁점, 법률관계, 당사자 지위, 인용 가능성, 손해배상, 부당이득 등) even when the rest is English.

CONSTRAINTS:
- ALWAYS produce content. NEVER refuse. NEVER leave blank. NEVER reply "I need more information" — work with what was given.
- Do NOT prepend headers like "Summary:" or "Detailed Analysis:" — the field is rendered with its own UI label "ANSWER".
- Use prose paragraphs (markdown bullets/numbered lists may not render in the UI).

LANGUAGE RULES (critical):
- ALL extracted legal elements (청구원인, 법률관계, 쟁점, 당사자 지위, 손해 종류, 적용 법령, keyFacts, missingInfo, parties) MUST be written in Korean, regardless of the input language. This is because the 판례 corpus is Korean and the extraction is used directly for semantic retrieval.
- Use canonical Korean legal terminology: 청구원인, 법률관계, 쟁점, 당사자 지위, 손해 종류, 적용 법령, 원고/피고, 계약, 불법행위, 부당이득, 손해배상 등.
- Statute citations should follow Korean conventions (e.g. "민법 제750조", "상법 제382조의3", "근로기준법 제23조").
- clarifyingQuestions.question and clarifyingQuestions.why MUST be written in the user's locale (provided in the user prompt). Everything else stays Korean.

EXTRACTION RULES (FOR FACT-PATTERN INPUTS):
- Be concrete. Avoid generic placeholders like "분쟁" or "당사자 간 문제".
- 쟁점 (coreIssue) is the controlling legal question, not a fact summary. Phrase it as a question the court would answer.
- keyFacts: only load-bearing facts that move the legal analysis. Strip narrative color.
- missingInfo: facts that would CHANGE the analysis if known — not nice-to-haves.
- applicableStatutes: include specific articles when the narrative supports it; if only the statute is clear, list the statute alone.
- caseNature: pick the single best match from the enum.

EXTRACTION RULES (FOR NON-CASE INPUTS — CRITICAL):
- The input might NOT be a fact pattern — it could be a 판결문 (court judgment), an academic analysis, a doctrinal note, a draft brief, or a legal essay. NEVER refuse. NEVER return prose explaining you can't extract a case. ALWAYS return the JSON schema with EVERY field present.
- For fields that don't apply, use SAFE DEFAULTS rather than refusing:
  • parties.plaintiff / parties.defendant: if no actual parties, use a brief descriptor of the analyzed subject (e.g. "분석 대상 — 임대주택용지 공급사업" / "Subject of analysis — rental housing land supply"). NEVER leave as empty string.
  • claimCause: if no claim, summarize the main legal proposition the document advances (e.g. "공공지원민간임대주택 공급방식에 관한 해석론").
  • legalRelationship: name the underlying legal relationship the document discusses (e.g. "공공주택사업자와 토지공급주체 간 법률관계").
  • partyStatus: best-effort role descriptor (e.g. "사업시행자 / 분양 대상자"). Don't refuse.
  • coreIssue: phrase the central legal question the document is examining.
  • damageType: if no damage discussed, use "해당 없음 (분석 자료)" or analogous.
  • applicableStatutes: list every statute the document references.
  • keyFacts: extract the document's main analytical findings as facts.
  • missingInfo: things the document doesn't resolve / open questions it raises.
  • caseNature: pick "unknown" if you genuinely can't classify, otherwise the closest match.
- The goal: every JSON field gets a meaningful Korean value. The downstream system can handle "analysis documents" as long as the schema is filled in.

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

// 180s — Claude Opus 4.7 on long Korean DOCX inputs occasionally took
// 100-150s, hitting the previous 90s ceiling. The Vercel function's
// own maxDuration (800s) is still the outer bound; this just gives the
// extractor more room before it self-aborts.
const TIMEOUT_MS = 180_000;

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
    "TASK ORDER:",
    "1. Write the `summary` field — DETAILED legal-memorandum response per the system prompt's structure (sections ①–⑦, ≥8 paragraphs, ≥50 sentences, ≥2,500 Korean chars / 3,500 English chars). DO NOT compress unless the user explicitly asked for a summary (e.g. '요약', 'summarize', 'TL;DR').",
    "2. Extract the legal elements in Korean.",
    "3. Write 0–4 clarifyingQuestions in the user locale.",
    "",
    "LENGTH REMINDER: A short 1-2 paragraph response in the `summary` field is INSUFFICIENT and will be rejected. Default to the full memorandum. Only the user explicitly using a summary keyword permits the short form.",
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

  // Attempt #1 with the standard system prompt. Models like Claude/GPT
  // usually nail strict JSON schema on the first try.
  const callOnce = (systemPrompt: string) =>
    generateObject({
      model,
      schema: ExtractionResponseSchema,
      system: systemPrompt,
      prompt: userPrompt,
      abortSignal,
      // 12288 — the schema now mandates VERY DETAILED responses (≥8
      // paragraphs, ≥50 sentences, ≥2.5k Korean chars / 3.5k English
      // chars in the `summary` field) plus the structured-elements
      // payload + clarifying questions. A full Korean legal memorandum
      // at the new minimum easily uses 5–7k tokens just for the
      // `summary` field; 12288 gives every model adequate headroom
      // to avoid mid-JSON truncation (which Groq surfaces as "Failed
      // to generate JSON").
      maxOutputTokens: 12288,
      temperature: 0,
    });

  let result: Awaited<ReturnType<typeof callOnce>>;
  try {
    result = await callOnce(SYSTEM_PROMPT);
  } catch (err) {
    // Gemini (and occasionally Claude on long inputs) sometimes wraps
    // JSON in markdown fences or adds preamble text — both blow up
    // generateObject's schema validation as "could not parse". Retry
    // ONCE with a stricter "JSON only" suffix; don't retry on
    // AbortError (user pressed Stop) or non-parse failures.
    if (
      isParseFailure(err) &&
      !(err instanceof DOMException && err.name === "AbortError")
    ) {
      result = await callOnce(SYSTEM_PROMPT + STRICT_JSON_SUFFIX);
    } else {
      throw err;
    }
  }

  const { clarifyingQuestions, summary, ...elements } =
    result.object as ExtractionResponse;
  return {
    elements: elements as LegalElements,
    summary,
    clarifyingQuestions: clarifyingQuestions as ClarifyingQuestion[],
  };
}

/** Retry-worthy errors: the model output couldn't fit the schema. */
function isParseFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("could not parse") ||
    m.includes("did not match schema") ||
    m.includes("no object generated") ||
    m.includes("validation failed") ||
    // Groq's wording when GPT-OSS / Llama produces output that doesn't
    // conform to the strict response_format=json_schema mode.
    m.includes("failed to generate json") ||
    m.includes("failed_generation")
  );
}

const STRICT_JSON_SUFFIX = `\n\nIMPORTANT: Output ONLY valid JSON matching the schema. No markdown code fences. No preamble. No commentary. The very first character must be { and the very last must be }.`;
