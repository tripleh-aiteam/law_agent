/**
 * Build / refresh the embeddings index for src/data/corpus.json.
 *
 * Usage:
 *   pnpm embed:corpus           # incremental: only embed missing case numbers
 *   pnpm embed:corpus -- --force  # re-embed everything
 *
 * Reads:  src/data/corpus.json         (Precedent[])
 * Writes: src/data/corpus-embeddings.json  (Array<{caseNumber, embedding}>)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrecedentSchema, type Precedent } from "../src/lib/types";
import { embedTextsLocal } from "../src/lib/local-embed";

const CORPUS_PATH = path.join(process.cwd(), "src", "data", "corpus.json");
const EMBEDDINGS_PATH = path.join(process.cwd(), "src", "data", "corpus-embeddings.json");

/** Build the precedent-side embedding text. Order is tuned for legal retrieval. */
function buildPrecedentText(p: Precedent): string {
  return [
    p.caseTitle,
    p.coreIssue,
    p.legalRelationship,
    p.holding,
    p.summary,
    p.facts,
    (p.applicableStatutes ?? []).join(", "),
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface EmbeddingRecord {
  caseNumber: string;
  embedding: number[];
}

async function readCorpus(): Promise<Precedent[]> {
  const raw = await fs.readFile(CORPUS_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("corpus.json must be a JSON array of Precedent");
  const out: Precedent[] = [];
  for (const item of parsed) {
    const r = PrecedentSchema.safeParse(item);
    if (r.success) {
      out.push(r.data);
    } else {
      const cn = (item as { caseNumber?: string })?.caseNumber ?? "<unknown>";
      console.warn(`[embed-corpus] Skipping invalid precedent ${cn}: ${r.error.message}`);
    }
  }
  return out;
}

async function readExistingEmbeddings(): Promise<Map<string, number[]>> {
  try {
    const raw = await fs.readFile(EMBEDDINGS_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const map = new Map<string, number[]>();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { caseNumber?: unknown }).caseNumber === "string" &&
          Array.isArray((item as { embedding?: unknown }).embedding)
        ) {
          map.set(
            (item as { caseNumber: string }).caseNumber,
            (item as { embedding: number[] }).embedding
          );
        }
      }
    }
    return map;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
    throw err;
  }
}

/** Chunk an array into batches of `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const t0 = Date.now();

  console.log(`[embed-corpus] Reading corpus from ${CORPUS_PATH}`);
  const corpus = await readCorpus();
  console.log(`[embed-corpus] Loaded ${corpus.length} precedents`);

  const existing = force ? new Map<string, number[]>() : await readExistingEmbeddings();
  if (!force) {
    console.log(`[embed-corpus] Existing embeddings: ${existing.size}`);
  } else {
    console.log(`[embed-corpus] --force flag: re-embedding everything`);
  }

  const todo = corpus.filter((p) => !existing.has(p.caseNumber));
  console.log(`[embed-corpus] To embed: ${todo.length}`);

  if (todo.length === 0) {
    console.log(`[embed-corpus] Nothing to do.`);
    return;
  }

  // Local transformers.js embeds one-at-a-time on CPU. Modest batches keep
  // progress reporting useful without buying anything performance-wise.
  const BATCH = 8;
  const batches = chunk(todo, BATCH);
  let totalDimsSum = 0;
  let totalEmbedded = 0;

  console.log(
    `[embed-corpus] Embedding via Vercel AI Gateway → openai/text-embedding-3-small (1536-dim).`,
  );

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const values = batch.map(buildPrecedentText);
    const tStart = Date.now();
    // role="passage" — e5 requires the prefix on indexed documents.
    const embeddings = await embedTextsLocal(values, "passage");
    if (embeddings.length !== batch.length) {
      throw new Error(
        `[embed-corpus] embedTextsLocal returned ${embeddings.length} embeddings for ${batch.length} inputs`
      );
    }
    for (let i = 0; i < batch.length; i++) {
      existing.set(batch[i].caseNumber, embeddings[i]);
      totalDimsSum += embeddings[i].length;
      totalEmbedded++;
    }
    const elapsedBatch = ((Date.now() - tStart) / 1000).toFixed(2);
    console.log(
      `[embed-corpus] Batch ${bi + 1}/${batches.length} (${batch.length} items) in ${elapsedBatch}s — ` +
        `total ${totalEmbedded}/${todo.length}`
    );
  }

  const out: EmbeddingRecord[] = [];
  for (const [caseNumber, embedding] of existing) {
    out.push({ caseNumber, embedding });
  }

  await fs.mkdir(path.dirname(EMBEDDINGS_PATH), { recursive: true });
  await fs.writeFile(EMBEDDINGS_PATH, JSON.stringify(out), "utf-8");

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const avgDim = totalEmbedded > 0 ? Math.round(totalDimsSum / totalEmbedded) : 0;
  console.log(
    `[embed-corpus] Done. Wrote ${out.length} records to ${EMBEDDINGS_PATH} ` +
      `in ${elapsed}s (avg dim: ${avgDim})`
  );
}

main().catch((err) => {
  console.error("[embed-corpus] Fatal:", err);
  process.exit(1);
});
