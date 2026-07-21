/**
 * Text embeddings — LOCAL, on-CPU, via @huggingface/transformers.
 *
 * Why local again:
 *   The project originally ran `Xenova/multilingual-e5-base` locally and was
 *   forced onto the Vercel AI Gateway ONLY because the ~280MB ONNX weights
 *   exceeded Vercel's 250MB serverless function limit. Self-hosted on the
 *   firm's own server that limit does not exist, so we go back to local:
 *     - Case text never leaves the network for retrieval (privilege / PIPA)
 *     - No per-query cost and no API key to expire
 *     - No dependency on the AI Gateway, which is the component currently down
 *
 * Model: Xenova/multilingual-e5-base
 *   - 768 dimensions (NOTE: the Gateway model was 1536 — the corpus MUST be
 *     re-embedded when switching. See scripts/migrate-corpus-to-db.ts)
 *   - Strong Korean handling; e5 is trained multilingually
 *   - Runs comfortably on CPU
 *
 * e5 REQUIRES asymmetric prefixes — "query: " for the search text and
 * "passage: " for the indexed documents. Getting these wrong silently
 * degrades retrieval quality rather than erroring, so they are applied here
 * in one place. The `role` parameter (kept in the signature through the
 * Gateway era "for API compat") is what selects the prefix; it is meaningful
 * again.
 */
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

/** Output dimensionality of multilingual-e5-base. */
export const EMBEDDING_DIMS = 768;

const MODEL_ID = "Xenova/multilingual-e5-base";

/**
 * Hard cap on a single input. e5-base truncates at 512 tokens anyway; Korean
 * averages roughly 1 char/token, so this keeps us near the useful ceiling
 * without paying to tokenize text the model will discard.
 */
const MAX_INPUT_CHARS = 2_000;

/**
 * Batch size for embedTextsLocal. Deliberately small: the server shares RAM
 * with other applications, and the ONNX runtime allocates per-batch.
 */
const BATCH_SIZE = 16;

/**
 * The pipeline is expensive to construct (loads + warms the ONNX weights),
 * so build it once per process and reuse. Concurrent callers await the same
 * promise rather than each triggering their own load.
 */
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Weights are baked into the image at build time (see Dockerfile), so
      // the container never reaches out to huggingface.co at runtime. If the
      // cache is somehow missing, allow a one-time download rather than
      // hard-failing the whole app.
      if (process.env.TRANSFORMERS_CACHE) {
        env.cacheDir = process.env.TRANSFORMERS_CACHE;
      }
      return (await pipeline("feature-extraction", MODEL_ID, {
        dtype: "fp32",
      })) as FeatureExtractionPipeline;
    })().catch((err: unknown) => {
      // Don't cache a rejected promise — a transient failure would otherwise
      // poison every later call for the lifetime of the process.
      pipelinePromise = null;
      throw err;
    });
  }
  return pipelinePromise;
}

/** Apply the e5 prefix and clamp length. */
function prepare(text: string, role: "query" | "passage"): string {
  const trimmed = text.trim().slice(0, MAX_INPUT_CHARS);
  return `${role}: ${trimmed}`;
}

/** Embed a single text. `role` selects the required e5 prefix. */
export async function embedTextLocal(
  text: string,
  role: "query" | "passage" = "query",
): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(prepare(text, role), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data as Float32Array);
}

/**
 * Embed many texts. Processed in small batches so peak memory stays bounded
 * on a server shared with other applications.
 */
export async function embedTextsLocal(
  texts: string[],
  role: "query" | "passage" = "passage",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getPipeline();
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => prepare(t, role));
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    // The pipeline returns a flat [batch * dims] tensor — slice it back apart.
    const flat = output.data as Float32Array;
    for (let j = 0; j < batch.length; j++) {
      out.push(
        Array.from(flat.slice(j * EMBEDDING_DIMS, (j + 1) * EMBEDDING_DIMS)),
      );
    }
  }
  return out;
}

/**
 * Warm the model so the first user query doesn't pay the load cost. Safe to
 * call repeatedly; safe to ignore the result.
 */
export async function warmEmbeddings(): Promise<void> {
  await embedTextLocal("워밍업", "query");
}
