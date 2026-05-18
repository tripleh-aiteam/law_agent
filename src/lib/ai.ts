/**
 * Central AI model exports.
 *
 * Setup (Option B — Groq + local embeddings):
 *   - LLM:        Groq `llama-3.3-70b-versatile` via @ai-sdk/groq (free tier)
 *   - Embeddings: local @huggingface/transformers (Xenova/multilingual-e5-base, 768-dim)
 *
 * Requires only GROQ_API_KEY in .env.local. No paid OpenAI/Anthropic billing
 * needed. Embeddings run on your own CPU — first call downloads ~280 MB ONNX.
 *
 * Swap providers later by changing the imports below and editing one line.
 */
import { groq } from "@ai-sdk/groq";

/**
 * Primary model for fact extraction, dashboard tabs, rerank, and citability.
 *
 * Picked `qwen/qwen3-32b` because:
 *   - Hosted on Groq (free tier, very fast — ~600 tok/s)
 *   - Supports `response_format: json_schema` reliably
 *   - Excellent Korean / East-Asian language handling
 *     (Qwen is trained heavily on Korean + Chinese + Japanese corpora)
 *   - Follows complex nested zod schemas reliably (gpt-oss-120b returned
 *     empty objects on our schema; qwen3-32b doesn't)
 *
 * NOTE: Most Llama models on Groq (incl. llama-3.3-70b-versatile) do NOT
 * support structured outputs and will fail every generateObject call.
 * See https://console.groq.com/docs/structured-outputs#supported-models
 */
export const EXTRACTION_MODEL = groq("meta-llama/llama-4-scout-17b-16e-instruct");

/** Larger alternative, also supports structured outputs. */
export const EXTRACTION_MODEL_FALLBACK = groq("openai/gpt-oss-120b");

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
