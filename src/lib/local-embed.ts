/**
 * Text embeddings via Vercel AI Gateway → OpenAI `text-embedding-3-small`.
 *
 * Why this provider:
 *   - Bundled with Vercel Pro plan (AI Gateway credits cover usage)
 *   - 1536-dim, strong multilingual including Korean
 *   - Deploys cleanly to Vercel (no bundled binaries)
 *   - Reliable rate limits + observability via Vercel dashboard
 *
 * Required env var:
 *   AI_GATEWAY_API_KEY=vck_...
 *
 * Note: OpenAI embedding models don't distinguish "query" vs "passage" inputs
 * the way some Korean-tuned models do (e.g. e5-base, BGE). The `role` parameter
 * is kept for API compatibility but does not change the embedding output.
 *
 * Function names (`embedTextLocal`, `embedTextsLocal`) are retained — the
 * "local" prefix is now historical; we kept the names so existing callers
 * (retrieval.ts, embed-corpus.ts) don't need to change.
 */
import { embed, embedMany } from "ai";

/** Gateway-routed model ID. Vercel routes this to OpenAI under the hood. */
const MODEL_ID = "openai/text-embedding-3-small";

/** Output dimensionality of text-embedding-3-small. */
export const EMBEDDING_DIMS = 1536;

const QUERY_TIMEOUT_MS = 30_000;
const BATCH_TIMEOUT_MS = 180_000;

/** Embed a single text. `role` is accepted for API compat but is a no-op here. */
export async function embedTextLocal(
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _role: "query" | "passage" = "query",
): Promise<number[]> {
  const { embedding } = await embed({
    model: MODEL_ID,
    value: text,
    abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  return embedding;
}

/**
 * Embed many texts in batch. The AI SDK + Gateway transparently chunk this
 * into the underlying provider's preferred batch size, so we just pass the
 * full array through.
 */
export async function embedTextsLocal(
  texts: string[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _role: "query" | "passage" = "passage",
): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: MODEL_ID,
    values: texts,
    abortSignal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
  });
  return embeddings;
}
