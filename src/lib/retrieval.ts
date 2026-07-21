/**
 * Precedent retrieval.
 *
 * Similarity search now runs in Postgres via pgvector rather than by parsing
 * a 47MB JSON corpus into memory on every cold start. `loadCorpus` and
 * `loadCorpusEmbeddings` are gone; `searchPrecedents` replaces them and the
 * old in-memory `semanticSearch` together.
 *
 * The seed JSON under src/data/ is retained as the migration source only —
 * see scripts/migrate-corpus-to-db.ts. Nothing at request time reads it.
 */
import type { LegalElements } from "./types";
import { embedTextLocal } from "./local-embed";
import { searchPrecedentsByEmbedding, countPrecedents } from "./db";
import type { Precedent } from "./types";

/** Embeds the query text using the local multilingual-e5-base pipeline. */
export async function embedQuery(text: string): Promise<number[]> {
  // role="query" — e5 requires different prefixes for queries vs passages.
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
 * Top-K precedents most similar to the query embedding, ranked by pgvector
 * cosine distance. Scores are similarity (higher is better), matching the
 * convention the reranker expects.
 */
export async function searchPrecedents(
  queryEmbedding: number[],
  topK = 10,
): Promise<Array<{ precedent: Precedent; embedding: number }>> {
  return searchPrecedentsByEmbedding(queryEmbedding, topK);
}

/**
 * Whether the corpus is loaded and usable. The search route calls this to
 * return an empty result set (rather than a 500) when the database has been
 * provisioned but the corpus migration hasn't been run yet.
 */
export async function isCorpusReady(): Promise<boolean> {
  try {
    const { embedded } = await countPrecedents();
    return embedded > 0;
  } catch {
    return false;
  }
}
