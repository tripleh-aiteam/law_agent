/**
 * Ingest Korean Supreme Court (대법원) precedents from law.go.kr.
 *
 * Modes:
 *   - API mode    (LAW_GO_KR_API_KEY set)  — fast, full coverage, 5 req/sec
 *   - Scrape mode (no key)                 — slow fallback, capped ~200 cases
 *
 * Usage:
 *   npm run ingest:lawgo -- --limit 200
 *   npm run ingest:lawgo -- --limit 5 --out src/data/corpus-smoke.json --dry-run
 *   npm run ingest:lawgo -- --limit 500 --resume
 *
 * Output (default): src/data/corpus-lawgo.json
 *
 * After a successful run, embed with:
 *   npm run embed:corpus
 * (Point embed at this file by overwriting src/data/corpus.json or editing the
 * embedder's CORPUS_PATH constant.)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  listPrecedents,
  getPrecedentDetail,
  checkApiKey,
  getMode,
} from "../src/lib/lawgo-client";
import {
  normalizeToPrecedent,
  normalizeFromListItem,
} from "../src/lib/lawgo-normalizer";
import { PrecedentSchema, type Precedent } from "../src/lib/types";
import type { LawGoListItem } from "../src/lib/lawgo-client";

// ────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────────────────

interface Flags {
  limit: number;
  fromDate: string;
  toDate: string;
  out: string;
  dryRun: boolean;
  resume: boolean;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    limit: 200,
    fromDate: "2010-01-01",
    toDate: todayIso(),
    out: path.join("src", "data", "corpus-lawgo.json"),
    dryRun: false,
    resume: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--limit":
        flags.limit = Math.max(1, Number(argv[++i] ?? "200"));
        break;
      case "--from":
        flags.fromDate = argv[++i] ?? flags.fromDate;
        break;
      case "--to":
        flags.toDate = argv[++i] ?? flags.toDate;
        break;
      case "--out":
        flags.out = argv[++i] ?? flags.out;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--resume":
        flags.resume = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.warn(`[ingest-lawgo] Unknown flag: ${a}`);
        }
    }
  }
  return flags;
}

// ────────────────────────────────────────────────────────────────────────────
// IO helpers
// ────────────────────────────────────────────────────────────────────────────

async function loadExisting(outPath: string): Promise<Map<string, Precedent>> {
  try {
    const raw = await fs.readFile(outPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const map = new Map<string, Precedent>();
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const r = PrecedentSchema.safeParse(item);
        if (r.success) map.set(r.data.caseNumber, r.data);
      }
    }
    return map;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

async function writeOutput(outPath: string, items: Precedent[]): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(items, null, 2), "utf-8");
}

interface FailureRecord {
  caseId: string;
  caseNumber?: string;
  caseTitle?: string;
  stage: "detail" | "normalize" | "validate";
  reason: string;
}

async function writeFailures(outPath: string, failures: FailureRecord[]): Promise<void> {
  if (failures.length === 0) return;
  const failPath = `${outPath}.failed.json`;
  await fs.writeFile(failPath, JSON.stringify(failures, null, 2), "utf-8");
  console.log(`[ingest-lawgo] Wrote ${failures.length} failure records to ${failPath}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const outPath = path.isAbsolute(flags.out) ? flags.out : path.join(process.cwd(), flags.out);

  const apiKeyOk = await checkApiKey();
  const mode = getMode();
  const banner = [
    "──────────────────────────────────────────────────────────────────",
    " law.go.kr ingest pipeline",
    `   mode      : ${mode === "api" ? "API (LAW_GO_KR_API_KEY detected)" : "SCRAPE (fallback — no API key)"}`,
    `   api-probe : ${mode === "api" ? (apiKeyOk ? "PASS" : "FAIL — key set but unverified, continuing best-effort") : "skipped"}`,
    `   date range: ${flags.fromDate} → ${flags.toDate}`,
    `   limit     : ${flags.limit}${mode === "scrape" && flags.limit > 200 ? " (will be clamped to 200 in scrape mode)" : ""}`,
    `   out       : ${outPath}${flags.dryRun ? "  [DRY-RUN, will not write]" : ""}`,
    `   resume    : ${flags.resume ? "yes" : "no"}`,
    "──────────────────────────────────────────────────────────────────",
  ].join("\n");
  console.log(banner);

  if (mode === "scrape" && flags.limit > 200) {
    flags.limit = 200;
  }

  if (flags.limit > 1000) {
    const hoursLo = (flags.limit / 5 / 3600).toFixed(1);
    const hoursHi = (flags.limit / 2 / 3600).toFixed(1);
    console.log(
      `[ingest-lawgo] Note: at API rate-limit (5 req/s ⇒ 1 list + 1 detail per case) expect roughly ${hoursLo}–${hoursHi} hours.`
    );
  }

  const existing = flags.resume ? await loadExisting(outPath) : new Map<string, Precedent>();
  if (flags.resume) {
    console.log(`[ingest-lawgo] --resume: loaded ${existing.size} existing precedents from ${outPath}`);
  }

  // ── List phase: paginate until we have enough new candidates ──────────────
  // We keep the full LawGoListItem so the list-only fallback has every field
  // it needs (decisionDate, caseNature, etc.) when detail is unavailable.
  const candidates: LawGoListItem[] = [];
  let page = 1;
  const displayPerPage = mode === "api" ? 100 : 20;
  let totalReported = 0;

  console.log(`[ingest-lawgo] Listing precedents...`);
  while (candidates.length < flags.limit) {
    let listRes;
    try {
      listRes = await listPrecedents({
        fromDate: flags.fromDate,
        toDate: flags.toDate,
        page,
        display: displayPerPage,
      });
    } catch (err) {
      console.error(`[ingest-lawgo] list page ${page} failed: ${(err as Error).message}`);
      break;
    }
    if (page === 1) {
      totalReported = listRes.total;
      console.log(`[ingest-lawgo] Server reports ~${totalReported} total cases in range`);
    }
    if (listRes.items.length === 0) {
      console.log(`[ingest-lawgo] No more items on page ${page} — list exhausted`);
      break;
    }
    for (const item of listRes.items) {
      if (existing.has(item.caseNumber)) continue;
      candidates.push(item);
      if (candidates.length >= flags.limit) break;
    }
    page += 1;
    if (page > 1000) {
      console.warn(`[ingest-lawgo] Reached pagination guardrail at page 1000; stopping`);
      break;
    }
  }
  console.log(`[ingest-lawgo] Will fetch + normalize ${candidates.length} cases`);

  // ── Fetch + normalize phase ───────────────────────────────────────────────
  const collected: Precedent[] = Array.from(existing.values());
  const failures: FailureRecord[] = [];
  let success = 0;
  let skipped = 0;
  const total = candidates.length;

  let listOnlyFallbacks = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const tag = `[${i + 1}/${total}]`;
    let precedent: Precedent;
    let detailError: string | null = null;
    let detail;
    try {
      detail = await getPrecedentDetail(c.caseId);
    } catch (err) {
      detailError = (err as Error).message;
    }

    if (detail) {
      // Detail path — full holding/summary/facts from the real opinion text.
      try {
        precedent = await normalizeToPrecedent(detail);
      } catch (err) {
        const reason = (err as Error).message;
        console.warn(`${tag} 대법원 ${c.caseNumber} — ${c.caseTitle} ✗ normalize: ${reason}`);
        failures.push({ caseId: c.caseId, caseNumber: c.caseNumber, caseTitle: c.caseTitle, stage: "normalize", reason });
        skipped++;
        continue;
      }
      collected.push(precedent);
      success++;
      console.log(`${tag} 대법원 ${precedent.caseNumber} — ${precedent.caseTitle || "(제목없음)"} ✓`);
    } else {
      // List-only fallback — typical when OC key lacks detail access (e.g. h7874)
      // or the calling IP hasn't been registered yet.
      try {
        precedent = await normalizeFromListItem(c);
      } catch (err) {
        const reason = (err as Error).message;
        console.warn(`${tag} 대법원 ${c.caseNumber} — ${c.caseTitle} ✗ list-only: ${reason} (detail err: ${detailError})`);
        failures.push({ caseId: c.caseId, caseNumber: c.caseNumber, caseTitle: c.caseTitle, stage: "normalize", reason });
        skipped++;
        continue;
      }
      collected.push(precedent);
      success++;
      listOnlyFallbacks++;
      console.log(`${tag} 대법원 ${precedent.caseNumber} — ${precedent.caseTitle || "(제목없음)"} ✓ [list-only]`);
    }

    // Periodically flush so progress survives crashes when in --resume mode.
    if (!flags.dryRun && success % 25 === 0) {
      try {
        await writeOutput(outPath, collected);
      } catch (err) {
        console.warn(`[ingest-lawgo] interim write failed: ${(err as Error).message}`);
      }
    }
  }

  // ── Write final output ────────────────────────────────────────────────────
  if (!flags.dryRun) {
    await writeOutput(outPath, collected);
    await writeFailures(outPath, failures);
  } else {
    console.log(`[ingest-lawgo] DRY-RUN: skipping writes. Would have written ${collected.length} precedents.`);
  }

  console.log("──────────────────────────────────────────────────────────────────");
  console.log(`INGEST COMPLETE — ${success}/${total} new cases ingested, ${skipped} skipped.`);
  if (listOnlyFallbacks > 0) {
    console.log(`   List-only fallbacks: ${listOnlyFallbacks} (detail unavailable — likely demo OC key or unregistered IP)`);
    console.log(`   These records have placeholder holding/summary. Upgrade by registering your IP at open.law.go.kr → re-running ingest.`);
  }
  console.log(`   Total in ${outPath}: ${collected.length}`);
  console.log(`   Next step: npm run embed:corpus`);
  console.log(`   (If happy, replace src/data/corpus.json with ${outPath} and re-run embed.)`);
  console.log("──────────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("[ingest-lawgo] Fatal:", err);
  process.exit(1);
});
