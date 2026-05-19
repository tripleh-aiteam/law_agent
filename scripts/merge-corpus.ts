/**
 * Merge corpus-lawgo.json (real 대법원 cases from law.go.kr ingest) into the
 * primary corpus.json, preserving the existing 15 hand-crafted seed cases.
 *
 * Strategy:
 *   1. Read existing corpus.json (the diverse seed cases — covers 임대차,
 *      손해배상, 노동, 가사, 형사, etc.)
 *   2. Read corpus-lawgo.json (real 대법원 cases — typically tax-heavy when
 *      using the demo h7874 OC key, more diverse once user upgrades)
 *   3. Dedupe by caseNumber — later wins (so a real case replaces any seed
 *      that happens to share its case number)
 *   4. Write the merged set back to corpus.json
 *
 * Usage:
 *   npm run merge:corpus
 *
 * Then re-embed:
 *   npm run embed:corpus
 *
 * (The embedder is incremental — it only computes new embeddings, so the
 * existing seed embeddings are preserved.)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrecedentSchema, type Precedent } from "../src/lib/types";

const CORPUS_PATH = path.join(process.cwd(), "src", "data", "corpus.json");
const LAWGO_PATH = path.join(process.cwd(), "src", "data", "corpus-lawgo.json");

async function readPrecedents(p: string): Promise<Precedent[]> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[merge-corpus] ${p}: not an array, skipping`);
      return [];
    }
    const out: Precedent[] = [];
    for (const item of parsed) {
      const r = PrecedentSchema.safeParse(item);
      if (r.success) {
        out.push(r.data);
      } else {
        const cn = (item as { caseNumber?: string })?.caseNumber ?? "<unknown>";
        console.warn(`[merge-corpus] Skipping invalid item ${cn}: ${r.error.message.slice(0, 120)}`);
      }
    }
    return out;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[merge-corpus] ${p} not found — treating as empty`);
      return [];
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log("[merge-corpus] Reading corpus.json (seed cases)...");
  const seed = await readPrecedents(CORPUS_PATH);
  console.log(`[merge-corpus] Loaded ${seed.length} seed precedents`);

  console.log("[merge-corpus] Reading corpus-lawgo.json (real cases)...");
  const real = await readPrecedents(LAWGO_PATH);
  console.log(`[merge-corpus] Loaded ${real.length} real precedents from law.go.kr ingest`);

  // Dedupe by caseNumber. Real cases win over seed (so when the user upgrades
  // their OC key and re-ingests, the real data replaces any placeholder seed).
  const byCaseNumber = new Map<string, Precedent>();
  for (const p of seed) byCaseNumber.set(p.caseNumber, p);
  let replaced = 0;
  for (const p of real) {
    if (byCaseNumber.has(p.caseNumber)) replaced++;
    byCaseNumber.set(p.caseNumber, p);
  }

  const merged = Array.from(byCaseNumber.values());
  await fs.writeFile(CORPUS_PATH, JSON.stringify(merged, null, 2), "utf-8");

  console.log("──────────────────────────────────────────────────────────────────");
  console.log(`MERGE COMPLETE`);
  console.log(`   seed cases       : ${seed.length}`);
  console.log(`   real (law.go.kr) : ${real.length}`);
  console.log(`   replaced overlaps: ${replaced}`);
  console.log(`   total in corpus  : ${merged.length}`);
  console.log(`   wrote            : ${CORPUS_PATH}`);
  console.log(`   next step        : npm run embed:corpus`);
  console.log("──────────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("[merge-corpus] Fatal:", err);
  process.exit(1);
});
