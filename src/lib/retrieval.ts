import { promises as fs } from "node:fs";
import path from "node:path";
import { PrecedentSchema, type Precedent, type LegalElements } from "./types";
import { cosineSimilarity } from "./ai";
import { embedTextLocal } from "./local-embed";

const CORPUS_PATH = path.join(process.cwd(), "src", "data", "corpus.json");
const EMBEDDINGS_PATH = path.join(process.cwd(), "src", "data", "corpus-embeddings.json");

/** Reads src/data/corpus.json. Returns [] if the file does not yet exist. */
export async function loadCorpus(): Promise<Precedent[]> {
  try {
    const raw = await fs.readFile(CORPUS_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Be lenient: validate each item, drop the ones that don't match.
    const out: Precedent[] = [];
    for (const item of parsed) {
      const r = PrecedentSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch (err: unknown) {
    // ENOENT or malformed JSON — return empty corpus so the pipeline degrades gracefully.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return [];
  }
}

/** Reads src/data/corpus-embeddings.json keyed by caseNumber. Returns an empty Map if missing. */
export async function loadCorpusEmbeddings(): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  try {
    const raw = await fs.readFile(EMBEDDINGS_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        "caseNumber" in item &&
        "embedding" in item &&
        typeof (item as { caseNumber: unknown }).caseNumber === "string" &&
        Array.isArray((item as { embedding: unknown }).embedding)
      ) {
        const cn = (item as { caseNumber: string }).caseNumber;
        const emb = (item as { embedding: number[] }).embedding;
        out.set(cn, emb);
      }
    }
    return out;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return out;
    return out;
  }
}

/** Embeds the query text using the local multilingual-e5-base pipeline. */
export async function embedQuery(text: string): Promise<number[]> {
  // role="query" — e5 family uses different prefixes for queries vs passages.
  return embedTextLocal(text, "query");
}

/**
 * Builds a Korean-optimized retrieval query from extracted elements plus a
 * narrative tail. Order matters for transformer embedding models — earlier
 * tokens carry more weight. We front-load 쟁점 (the controlling question),
 * then 법률관계, then 청구원인, then key facts, then a narrative tail.
 */
export function buildQueryText(elements: LegalElements, narrative: string): string {
  const parts: string[] = [];
  if (elements.coreIssue) parts.push(`쟁점: ${elements.coreIssue}`);
  if (elements.legalRelationship) parts.push(`법률관계: ${elements.legalRelationship}`);
  if (elements.claimCause) parts.push(`청구원인: ${elements.claimCause}`);
  if (elements.partyStatus) parts.push(`당사자 지위: ${elements.partyStatus}`);
  if (elements.damageType) parts.push(`손해 종류: ${elements.damageType}`);
  if (elements.applicableStatutes?.length) {
    parts.push(`적용 법령: ${elements.applicableStatutes.join(", ")}`);
  }
  if (elements.keyFacts?.length) {
    parts.push(`주요 사실: ${elements.keyFacts.join(" / ")}`);
  }
  // Narrative tail — last so it doesn't dilute the front. Cap to keep the
  // embedding focused on the structured query.
  const tail = narrative.trim().slice(-800);
  if (tail) parts.push(`사실관계 서술: ${tail}`);
  return parts.join("\n\n");
}

/**
 * Cosine similarity search over the corpus. Returns top-K precedents with
 * their embedding score, sorted descending. Precedents missing an embedding
 * are silently skipped (they can still be added in a later embed run).
 */
export function semanticSearch(
  queryEmbedding: number[],
  corpus: Precedent[],
  embeddings: Map<string, number[]>,
  topK = 10
): Array<{ precedent: Precedent; embedding: number }> {
  const scored: Array<{ precedent: Precedent; embedding: number }> = [];
  for (const p of corpus) {
    const emb = embeddings.get(p.caseNumber);
    if (!emb) continue;
    const score = cosineSimilarity(queryEmbedding, emb);
    scored.push({ precedent: p, embedding: score });
  }
  scored.sort((a, b) => b.embedding - a.embedding);
  return scored.slice(0, topK);
}
