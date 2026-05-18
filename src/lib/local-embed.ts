/**
 * Local Korean-capable text embeddings via @huggingface/transformers.
 *
 * Uses `Xenova/multilingual-e5-base` (768-dim, ~280 MB ONNX, excellent Korean).
 * First call downloads the model (~280 MB) to the OS cache; subsequent calls
 * load from disk. Inference is CPU-only, ~1–4 seconds per query.
 *
 * The e5 family requires role-prefixed inputs:
 *   - Documents to be retrieved → `"passage: <text>"`
 *   - Search queries           → `"query: <text>"`
 * Without these prefixes the embeddings still work but retrieval quality drops.
 *
 * Pipeline is lazy-loaded and cached for the lifetime of the Node process.
 */

import { pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/multilingual-e5-base";

/** Output dimensionality of multilingual-e5-base. */
export const EMBEDDING_DIMS = 768;

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

let pipePromise: Promise<FeatureExtractor> | null = null;

async function getPipe(): Promise<FeatureExtractor> {
  if (!pipePromise) {
    pipePromise = pipeline("feature-extraction", MODEL_ID);
  }
  return pipePromise;
}

/**
 * Embed a single text. `role` controls the e5 prefix:
 *   - "query"   → used when embedding a user search query
 *   - "passage" → used when embedding a precedent document to index
 */
export async function embedTextLocal(
  text: string,
  role: "query" | "passage" = "query",
): Promise<number[]> {
  const [out] = await embedTextsLocal([text], role);
  return out;
}

/**
 * Embed many texts. Runs sequentially — transformers.js feature-extraction
 * pipelines don't batch internally on CPU, so manual chunking is fine.
 */
export async function embedTextsLocal(
  texts: string[],
  role: "query" | "passage" = "passage",
): Promise<number[][]> {
  const pipe = await getPipe();
  const prefix = role === "query" ? "query: " : "passage: ";
  const out: number[][] = [];
  for (const text of texts) {
    const result = await pipe(prefix + text, {
      pooling: "mean",
      normalize: true,
    });
    // result.data is a Float32Array of length EMBEDDING_DIMS.
    out.push(Array.from(result.data as Float32Array));
  }
  return out;
}
