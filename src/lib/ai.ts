/**
 * Central AI model exports.
 *
 * Setup (production / Vercel-compatible):
 *   - LLM:        Groq `meta-llama/llama-4-scout-17b-16e-instruct`
 *                 via @ai-sdk/groq (free tier, reliable JSON schema)
 *   - Embeddings: OpenAI `text-embedding-3-small` (1536-dim) via Vercel AI Gateway
 *                 (covered by Vercel Pro credits, deploys cleanly — see local-embed.ts)
 *
 * Required env vars:
 *   - GROQ_API_KEY            (LLM calls — direct to Groq)
 *   - AI_GATEWAY_API_KEY      (embedding calls — routed via Vercel AI Gateway)
 *
 * Swap providers later by changing the imports below.
 */
import { groq } from "@ai-sdk/groq";

/**
 * Primary model for fact extraction, dashboard tabs, rerank, and citability.
 *
 * Picked `openai/gpt-oss-120b` because:
 *   - Hosted on Groq (free tier, very fast) and CONFIRMED present on this
 *     account's model list — see the note on decommissioning below.
 *   - Supports `response_format: json_schema` reliably; verified against
 *     our nested zod extraction schema via /api/extract.
 *   - Most capable free option Groq currently serves.
 *
 * NOTE: this used to be `meta-llama/llama-4-scout-17b-16e-instruct`, which
 * Groq has since retired — every call 404'd with "does not exist or you do
 * not have access to it", silently breaking extract, the dashboard tabs,
 * redline, court drafts and PII redaction. Groq rotates its hosted roster,
 * so verify against `GET https://api.groq.com/openai/v1/models` before
 * pinning a new default here.
 *
 * NOTE: Most Llama models on Groq (incl. llama-3.3-70b-versatile) do NOT
 * support structured outputs and will fail every generateObject call.
 * See https://console.groq.com/docs/structured-outputs#supported-models
 */
export const EXTRACTION_MODEL = groq("openai/gpt-oss-120b");

/** Smaller sibling, also supports structured outputs. */
export const EXTRACTION_MODEL_FALLBACK = groq("openai/gpt-oss-20b");

/**
 * Citability rerank model — the default used when the caller doesn't pass an
 * explicit model.
 *
 * This was previously the bare string "openai/gpt-4o", which the AI SDK
 * routed through the Vercel AI Gateway. On-prem there is no gateway, so a
 * bare string would fail with an authentication error. It now points at the
 * same local-key-backed model as extraction.
 *
 * Korean legal nuance genuinely matters here (the rerank decides
 * 강한 권위 / 참고 / 부적합), so pass an explicit premium model via the
 * `modelId` argument to llmReranker when one is configured — that path is
 * unchanged and takes precedence over this default.
 */
export const RERANK_MODEL = EXTRACTION_MODEL;

/** Embedding dimensions — re-exported from local-embed for convenience. */
export { EMBEDDING_DIMS } from "./local-embed";

/**
 * Cosine similarity between two equally-sized numeric vectors.
 * Returns 0 if either vector is empty / zero-norm or lengths differ.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
