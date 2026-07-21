/**
 * One-time corpus migration: src/data/corpus.json  ->  Postgres + pgvector.
 *
 * Run once after the database container is up:
 *   npm run migrate:corpus
 *
 * What it does:
 *   1. Reads the seed corpus JSON (409 대법원 cases).
 *   2. Embeds each one LOCALLY with multilingual-e5-base (role="passage").
 *   3. Upserts rows into `precedents` with their 768-dim vectors.
 *
 * Why it re-embeds rather than importing corpus-embeddings.json:
 *   those stored vectors are 1536-dim, produced by the Vercel AI Gateway's
 *   text-embedding-3-small. The on-prem model is 768-dim. Mixing dimensions
 *   is not possible — pgvector rejects it at insert — so every case must be
 *   re-embedded with the new model. This is free and local; expect a few
 *   minutes on CPU for ~400 cases.
 *
 * Safe to re-run: upserts by case_number, so it repairs/updates in place.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrecedentSchema, type Precedent } from "../src/lib/types";
import { embedTextsLocal, EMBEDDING_DIMS } from "../src/lib/local-embed";
import { getPool, upsertPrecedent, countPrecedents } from "../src/lib/db";

const CORPUS_PATH = path.join(process.cwd(), "src", "data", "corpus.json");

/** Batch size for embedding + inserting. Keeps peak memory modest. */
const BATCH = 16;

/**
 * Text that represents a precedent for retrieval purposes. Mirrors the
 * query-side ordering in buildQueryText: the controlling question first,
 * then the legal frame, then the facts. Front-loaded because transformer
 * embeddings weight earlier tokens more heavily.
 */
function buildPrecedentText(p: Precedent): string {
  const parts: string[] = [];
  if (p.coreIssue) parts.push(`쟁점: ${p.coreIssue}`);
  if (p.legalRelationship) parts.push(`법률관계: ${p.legalRelationship}`);
  if (p.holding) parts.push(`판시사항: ${p.holding}`);
  if (p.summary) parts.push(`판결요지: ${p.summary}`);
  if (p.applicableStatutes?.length) {
    parts.push(`적용 법령: ${p.applicableStatutes.join(", ")}`);
  }
  if (p.facts) parts.push(`사실관계: ${p.facts}`);
  if (p.caseTitle) parts.push(`사건명: ${p.caseTitle}`);
  return parts.join("\n\n");
}

async function loadSeedCorpus(): Promise<Precedent[]> {
  const raw = await fs.readFile(CORPUS_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${CORPUS_PATH} does not contain a JSON array.`);
  }
  const out: Precedent[] = [];
  let skipped = 0;
  for (const item of parsed) {
    const r = PrecedentSchema.safeParse(item);
    if (r.success) out.push(r.data);
    else skipped++;
  }
  if (skipped > 0) {
    console.warn(`  ⚠ ${skipped} entries failed schema validation and were skipped.`);
  }
  return out;
}

async function main(): Promise<void> {
  console.log("Law Agent — corpus migration to Postgres/pgvector\n");

  const corpus = await loadSeedCorpus();
  console.log(`  Loaded ${corpus.length} precedents from corpus.json`);
  if (corpus.length === 0) {
    console.error("  Nothing to migrate. Aborting.");
    process.exit(1);
  }

  console.log(`  Embedding locally with multilingual-e5-base (${EMBEDDING_DIMS}-dim)…`);
  console.log("  First run downloads/loads the model — this takes a minute.\n");

  const pool = getPool();
  const client = await pool.connect();
  let done = 0;
  let failed = 0;

  try {
    for (let i = 0; i < corpus.length; i += BATCH) {
      const slice = corpus.slice(i, i + BATCH);
      const texts = slice.map(buildPrecedentText);

      let vectors: number[][];
      try {
        vectors = await embedTextsLocal(texts, "passage");
      } catch (err) {
        console.error(
          `  ✗ Embedding failed for batch at ${i}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed += slice.length;
        continue;
      }

      // One transaction per batch: a mid-run crash leaves whole batches
      // committed rather than a half-written row.
      await client.query("BEGIN");
      try {
        for (let j = 0; j < slice.length; j++) {
          await upsertPrecedent(client, slice[j], vectors[j] ?? null);
        }
        await client.query("COMMIT");
        done += slice.length;
      } catch (err) {
        await client.query("ROLLBACK");
        failed += slice.length;
        console.error(
          `  ✗ Insert failed for batch at ${i}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      process.stdout.write(`\r  Progress: ${done}/${corpus.length}`);
    }
  } finally {
    client.release();
  }

  console.log("\n");
  const counts = await countPrecedents();
  console.log(`  Rows in database : ${counts.total}`);
  console.log(`  With embeddings  : ${counts.embedded}`);
  if (failed > 0) console.log(`  Failed           : ${failed}`);

  await pool.end();

  if (counts.embedded === 0) {
    console.error("\n  ✗ No embeddings were written. Search will return nothing.");
    process.exit(1);
  }
  console.log("\n  ✓ Migration complete.");
}

main().catch((err: unknown) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
