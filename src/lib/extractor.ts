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
      "Your DIRECT, COMPREHENSIVE answer to the user's question, in the USER'S LOCALE. DEFAULT to a memorandum-style legal analysis (6-10 substantial paragraphs, 30-60 sentences total) — DO NOT compress unless the user explicitly asked for a summary. The UI label is 'ANSWER'. Be thorough: name doctrines, cite specific Korean statute articles, walk through legal reasoning, address counter-arguments, identify procedural / 시효 / 입증책임 issues where relevant. ONLY when the user explicitly used '요약' / 'summarize' / 'TL;DR' / 'brief' / 'Case summary': write 4-8 sentences instead. Preserve Korean legal terms (판결, 청구원인, 쟁점, 법률관계, 손해배상, 부당이득, 인용 가능성 등) inline even when answering in English. Use paragraph breaks for readability; avoid markdown bullets. Do NOT prepend 'Summary:' / 'Detailed Analysis:' or any header — the UI handles labeling."
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

DEFAULT MODE: DETAILED RESPONSE (this is the default — use it unless the user EXPLICITLY asked for a summary).
- Write a comprehensive legal memorandum-style analysis. 6–10 substantial paragraphs, roughly 30–60 sentences in total. AIM HIGH on depth — lawyers actually using this should not feel like they need to ask a follow-up just to get to the meat.
- Use clear paragraph breaks for readability. Lawyers reading this should be able to skim by paragraph.
- Match the depth of the user's question:
  • "Find precedents on X / 판례를 찾아 주세요" → at least 4–5 paragraphs: (a) controlling doctrines + 쟁점 framing, (b) what the leading 대법원 line of cases holds, (c) which specific holdings or fact patterns would best support the user's position with reasoning, (d) potential distinguishing factors opposing counsel might raise, (e) recommended citation strategy. The precedent LIST comes from a separate search step — your job is analysis.
  • "Find applicable statutes / 적용 법령을 분석해 주세요" → walk through every plausible Korean statute with specific articles. For each, include 2–3 sentences of reasoning + how it interacts with the others. Cover constitutional provisions, primary statutes, special acts, and applicable regulations.
  • "Analyze opposing arguments / 반대 측 논거" → 4–6 distinct counter-arguments. For each: (a) the argument's logic, (b) the legal basis the opponent would cite, (c) why it has merit, (d) the user's strongest response. One paragraph per argument.
  • "Detailed analysis / 상세 분석" → full structured analysis: ① 쟁점 ② 법률관계 ③ 적용 법령 ④ 판례 적용 ⑤ 전략적 고려사항 ⑥ 입증 책임 / 시효 / 절차적 쟁점. At least one full paragraph per section.
  • The user attached a document with no specific question → comprehensive legal-analyst review covering: court & parties, claim & defense, controlling statutes (with article numbers), 판시사항 reasoning, 판결요지, strengths, weaknesses, implications for similar cases. NOT a summary.

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

  // Attempt #1 with the standard system prompt. Models like Claude/GPT
  // usually nail strict JSON schema on the first try.
  const callOnce = (systemPrompt: string) =>
    generateObject({
      model,
      schema: ExtractionResponseSchema,
      system: systemPrompt,
      prompt: userPrompt,
      abortSignal,
      // 8192 — the schema now defaults to VERY DETAILED responses (6-10
      // paragraphs, 30-60 sentences in the `summary` field) plus the
      // structured-elements payload + clarifying questions. A long
      // Korean legal memorandum easily blows past 6144 mid-JSON, which
      // Groq surfaces as "Failed to generate JSON". 8192 gives all
      // models headroom.
      maxOutputTokens: 8192,
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
