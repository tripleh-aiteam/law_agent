/**
 * Mixture-of-Agents (MoA) extraction.
 *
 * Selecting the special `auto/mixture-of-agents` model triggers this path
 * instead of a single-model call. We fan the same prompt out to several
 * strong models in parallel, then use Claude Opus 4.7 as an aggregator that
 * sees all candidates and synthesizes ONE final output.
 *
 * Why MoA helps:
 *   - Different models have different failure modes. Claude is conservative,
 *     GPT is verbose, Grok takes contrarian angles. The aggregator picks the
 *     strongest version of each field from across the candidates.
 *   - Disagreement is itself a signal — if 2/3 models flag the same legal
 *     element, it's likely real; if only 1/3 does, it's likely speculation.
 *
 * Cost:
 *   - ~4× a single-model call (3 candidates + 1 aggregator).
 *   - Latency: roughly max(candidate_times) + aggregator_time, since the
 *     candidates run in parallel.
 *
 * Failure handling:
 *   - If a candidate model fails (timeout, malformed JSON), we drop it and
 *     proceed with the survivors. The aggregator just sees fewer candidates.
 *   - If ALL candidates fail, we throw the last error so the route layer
 *     can produce a clean 500 with a useful message.
 *   - If the aggregator itself fails but at least one candidate succeeded,
 *     we degrade gracefully by returning the first successful candidate
 *     instead of a hard error.
 */
import { generateObject } from "ai";
import { z } from "zod";
import {
  LegalElementsSchema,
  type LegalElements,
  type ClarifyingQuestion,
} from "./types";
import { resolveModelForUse } from "./resolve-model";
import { MOA_AGGREGATOR_MODEL_ID, MOA_ROSTER } from "./models";

/** The roster — strong, viewpoint-diverse, all good at structured output. */
const MOA_CANDIDATES = MOA_ROSTER;

/** The aggregator — best legal reasoner we have. */
const MOA_AGGREGATOR = MOA_AGGREGATOR_MODEL_ID;

/** Per-candidate timeout. Aggregator gets its own (longer) timeout below. */
const CANDIDATE_TIMEOUT_MS = 75_000;
const AGGREGATOR_TIMEOUT_MS = 60_000;

const ResponseSchema = LegalElementsSchema.extend({
  summary: z
    .string()
    .describe(
      "1–2 paragraph plain-language summary of the input, in the user's locale. Preserve Korean legal terms inline.",
    ),
  clarifyingQuestions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        why: z.string(),
      }),
    )
    .max(4),
});

type Candidate = z.infer<typeof ResponseSchema>;

const CANDIDATE_SYSTEM = `You are a senior Korean litigation paralegal extracting legal elements and writing a plain-language summary for a 판례 (case-law) retrieval system against the Korean Supreme Court corpus.

LANGUAGE
- summary + clarifyingQuestions: user's locale (specified in the user prompt).
- All extracted legal element fields (청구원인, 법률관계, 쟁점, etc.): ALWAYS Korean.
- Preserve canonical Korean legal terms inline even when writing English (판결, 청구원인, 법률관계, 쟁점, 당사자 지위, 손해, etc.).

EXTRACTION
- Be concrete. No generic placeholders like "분쟁" or "당사자 간 문제".
- coreIssue (쟁점): the controlling legal question phrased as a question.
- keyFacts: only load-bearing facts that move the legal analysis.
- missingInfo: facts that would CHANGE the analysis if known.
- applicableStatutes: specific articles when supported (e.g. 민법 제750조).

SUMMARY
- ALWAYS produce a summary, even for judgments, academic excerpts, or fragments.
- 1–2 paragraphs, 4–8 sentences total. Cover the parties, dispute, and (for judgments) the holding + reasoning.

CLARIFYING QUESTIONS
- 0–4 highest-impact questions a Korean attorney would actually ask.
- Skip if the narrative already covers party type, written agreement, jurisdiction, timeline, and prior litigation.`;

const AGGREGATOR_SYSTEM = `You are the aggregator in a Mixture-of-Agents legal extraction system. Three strong models each produced their own extraction of the same input. Your job is to produce ONE final synthesis that beats every individual candidate.

Rules:
1. For each field, pick the strongest version. "Strongest" = most specific, most grounded in the input, most aligned with Korean legal terminology. If candidates disagree on a fact, default to whichever version is most directly traceable to the source.
2. For arrays (keyFacts, missingInfo, applicableStatutes): take the union, deduplicate semantically (don't keep "민법 제750조" and "민법 750조" as separate entries), then trim to the strongest items.
3. For the summary: write a NEW one that is better than any of the inputs. Do NOT just pick the longest. Synthesize, don't concatenate.
4. For clarifyingQuestions: dedupe semantically across candidates, keep the highest-impact ones, up to 4.
5. NEVER invent facts that no candidate produced. Your job is selection + synthesis, not new generation.

OUTPUT LANGUAGE
- summary + clarifyingQuestions in the user's locale (specified in the user prompt).
- All legal element fields stay Korean. Preserve Korean legal terms inline.`;

export type MoaResult = {
  elements: LegalElements;
  summary: string;
  clarifyingQuestions: ClarifyingQuestion[];
  /** Per-candidate audit trail — useful for the UI's "X models agreed" badge. */
  candidates: Array<{
    modelId: string;
    status: "ok" | "failed";
    error?: string;
  }>;
};

/**
 * Lifecycle events emitted while the MoA pipeline runs. The /api/extract
 * route forwards these as NDJSON so the UI can render a real-time
 * visualization (3 cards working in parallel → aggregator → done).
 */
export type MoaProgressEvent =
  | { type: "candidate_start"; modelId: string; candidateIndex: number }
  | {
      type: "candidate_done";
      modelId: string;
      candidateIndex: number;
      status: "ok" | "failed";
      error?: string;
    }
  | { type: "aggregator_start"; modelId: string }
  | { type: "aggregator_done"; status: "ok" | "failed"; error?: string };


/** Combine internal timeout with the caller's abort signal. */
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

async function runCandidate(
  modelId: string,
  userPrompt: string,
  clientSignal?: AbortSignal,
): Promise<Candidate> {
  const model = resolveModelForUse(modelId) ?? modelId;
  const abortSignal = clientSignal
    ? anySignal([clientSignal, AbortSignal.timeout(CANDIDATE_TIMEOUT_MS)])
    : AbortSignal.timeout(CANDIDATE_TIMEOUT_MS);
  const result = await generateObject({
    model,
    schema: ResponseSchema,
    system: CANDIDATE_SYSTEM,
    prompt: userPrompt,
    abortSignal,
    maxOutputTokens: 2048,
  });
  return result.object as Candidate;
}

async function runAggregator(
  candidates: Candidate[],
  locale: "ko" | "en",
  inputPreview: string,
  clientSignal?: AbortSignal,
): Promise<Candidate> {
  const model = resolveModelForUse(MOA_AGGREGATOR) ?? MOA_AGGREGATOR;
  const abortSignal = clientSignal
    ? anySignal([clientSignal, AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS)])
    : AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS);
  const userPrompt = [
    `User locale: ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    "",
    "Original input (truncated for reference):",
    "---",
    inputPreview.slice(0, 3000),
    "---",
    "",
    "Candidate extractions:",
    ...candidates.map(
      (c, i) =>
        `\n=== Candidate ${i + 1} ===\n` +
        "```json\n" +
        JSON.stringify(c, null, 2) +
        "\n```",
    ),
    "",
    "Synthesize ONE final extraction per the rules.",
  ].join("\n");
  const result = await generateObject({
    model,
    schema: ResponseSchema,
    system: AGGREGATOR_SYSTEM,
    prompt: userPrompt,
    abortSignal,
    maxOutputTokens: 2048,
  });
  return result.object as Candidate;
}

/**
 * Run the MoA pipeline end-to-end. Throws only when EVERY candidate fails;
 * partial failures degrade gracefully (the aggregator just sees fewer
 * candidates, and if the aggregator itself fails we fall back to the first
 * successful candidate).
 */
export async function moaExtract(
  narrative: string,
  locale: "ko" | "en",
  clientSignal?: AbortSignal,
  onProgress?: (event: MoaProgressEvent) => void,
): Promise<MoaResult> {
  const userPrompt = [
    `User locale (for summary + clarifyingQuestions): ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    "",
    "Input:",
    "---",
    narrative,
    "---",
    "",
    "Produce the summary, the Korean legal elements, and 0–4 clarifyingQuestions.",
  ].join("\n");

  const emit = (e: MoaProgressEvent) => {
    try {
      onProgress?.(e);
    } catch {
      // The route layer's writer may be closed (client aborted) — swallow,
      // we still want the pipeline to drain cleanly.
    }
  };

  // Fan out — Promise.allSettled so one failure doesn't kill the others.
  // Each candidate emits start/done events so the UI can render in real
  // time which model is still working vs. which has returned.
  const candidatePromises = MOA_CANDIDATES.map((id, i) => {
    emit({ type: "candidate_start", modelId: id, candidateIndex: i });
    return runCandidate(id, userPrompt, clientSignal).then(
      (value) => {
        emit({
          type: "candidate_done",
          modelId: id,
          candidateIndex: i,
          status: "ok",
        });
        return value;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          type: "candidate_done",
          modelId: id,
          candidateIndex: i,
          status: "failed",
          error: message,
        });
        throw err;
      },
    );
  });

  const settled = await Promise.allSettled(candidatePromises);

  const candidatesAudit: MoaResult["candidates"] = settled.map((s, i) => ({
    modelId: MOA_CANDIDATES[i],
    status: s.status === "fulfilled" ? "ok" : "failed",
    error:
      s.status === "rejected"
        ? s.reason instanceof Error
          ? s.reason.message
          : String(s.reason)
        : undefined,
  }));

  const successful = settled
    .map((s, i) =>
      s.status === "fulfilled" ? { value: s.value, idx: i } : null,
    )
    .filter((x): x is { value: Candidate; idx: number } => x !== null);

  if (successful.length === 0) {
    // All candidates failed — surface the last error so the route can wrap it.
    const lastFailure = settled[settled.length - 1];
    if (lastFailure.status === "rejected") {
      throw lastFailure.reason instanceof Error
        ? lastFailure.reason
        : new Error(String(lastFailure.reason));
    }
    throw new Error("MoA: all candidates failed with unknown errors");
  }

  // If only one candidate survived, skip the aggregator — there's nothing
  // to synthesize across.
  if (successful.length === 1) {
    const only = successful[0].value;
    const { clarifyingQuestions, summary, ...elements } = only;
    return {
      elements: elements as LegalElements,
      summary,
      clarifyingQuestions: clarifyingQuestions as ClarifyingQuestion[],
      candidates: candidatesAudit,
    };
  }

  // Aggregate — but fall back to the first successful candidate if the
  // aggregator itself fails.
  emit({ type: "aggregator_start", modelId: MOA_AGGREGATOR });
  let aggregated: Candidate;
  try {
    aggregated = await runAggregator(
      successful.map((s) => s.value),
      locale,
      narrative,
      clientSignal,
    );
    emit({ type: "aggregator_done", status: "ok" });
  } catch (err) {
    aggregated = successful[0].value;
    const message =
      "Aggregator failed; degraded to first successful candidate: " +
      (err instanceof Error ? err.message : String(err));
    candidatesAudit.push({
      modelId: MOA_AGGREGATOR,
      status: "failed",
      error: message,
    });
    emit({ type: "aggregator_done", status: "failed", error: message });
  }

  const { clarifyingQuestions, summary, ...elements } = aggregated;
  return {
    elements: elements as LegalElements,
    summary,
    clarifyingQuestions: clarifyingQuestions as ClarifyingQuestion[],
    candidates: candidatesAudit,
  };
}
