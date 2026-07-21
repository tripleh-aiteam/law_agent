/**
 * Postgres access layer (on-prem).
 *
 * Replaces the previous file-based corpus (a 47MB JSON blob parsed into
 * memory on every cold start) with pgvector-backed similarity search that
 * runs inside the database.
 *
 * Connection is configured entirely by DATABASE_URL so the same build runs
 * against docker-compose locally and against the firm's server unchanged.
 */
import { Pool, type PoolClient } from "pg";
import type { Precedent } from "./types";
import { EMBEDDING_DIMS } from "./local-embed";

/**
 * One pool per process. Next.js hot-reloads modules in dev, which would
 * otherwise leak a new pool (and its sockets) on every edit — so in dev we
 * stash it on globalThis and reuse.
 */
const globalForDb = globalThis as unknown as { __lawAgentPool?: Pool };

export function getPool(): Pool {
  if (globalForDb.__lawAgentPool) return globalForDb.__lawAgentPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.production.example to .env and set it " +
        "(docker-compose provides it automatically).",
    );
  }

  const pool = new Pool({
    connectionString,
    // Small pool: this is an internal tool for one law team, not a public
    // service. Postgres connections are expensive; 10 is ample headroom.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool-level error (e.g. the DB restarting) would otherwise crash the
  // process as an unhandled 'error' event.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  globalForDb.__lawAgentPool = pool;
  return pool;
}

/** Serialize a JS number[] into the pgvector literal format: '[1,2,3]'. */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedding has ${embedding.length} dims but the schema expects ${EMBEDDING_DIMS}. ` +
        "The corpus and the query must use the same model — re-run the corpus migration.",
    );
  }
  return `[${embedding.join(",")}]`;
}

/** Row shape as stored. snake_case here, camelCase at the Precedent boundary. */
interface PrecedentRow {
  case_number: string;
  court: string;
  decision_date: string;
  case_title: string;
  case_nature: string;
  holding: string;
  summary: string;
  facts: string;
  core_issue: string;
  legal_relationship: string;
  applicable_statutes: string[];
  source_url: string | null;
}

function rowToPrecedent(row: PrecedentRow): Precedent {
  return {
    caseNumber: row.case_number,
    court: row.court,
    decisionDate: row.decision_date,
    caseTitle: row.case_title,
    caseNature: row.case_nature,
    holding: row.holding,
    summary: row.summary,
    facts: row.facts,
    coreIssue: row.core_issue,
    legalRelationship: row.legal_relationship,
    applicableStatutes: row.applicable_statutes ?? [],
    // Precedent.sourceUrl is `.url().optional()` — an empty string would fail
    // validation downstream, so normalize NULL/'' to undefined.
    sourceUrl: row.source_url ? row.source_url : undefined,
  };
}

/**
 * Top-K nearest precedents by cosine distance, computed in Postgres.
 *
 * `<=>` is pgvector's cosine-distance operator (0 = identical, 2 = opposite).
 * We return similarity (1 - distance) so callers keep the same
 * higher-is-better convention the old in-memory cosineSimilarity used.
 */
export async function searchPrecedentsByEmbedding(
  queryEmbedding: number[],
  topK = 10,
): Promise<Array<{ precedent: Precedent; embedding: number }>> {
  const pool = getPool();
  const vec = toVectorLiteral(queryEmbedding);

  const { rows } = await pool.query<PrecedentRow & { similarity: number }>(
    `SELECT case_number, court, decision_date, case_title, case_nature,
            holding, summary, facts, core_issue, legal_relationship,
            applicable_statutes, source_url,
            1 - (embedding <=> $1::vector) AS similarity
       FROM precedents
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [vec, topK],
  );

  return rows.map((r) => ({
    precedent: rowToPrecedent(r),
    embedding: Number(r.similarity),
  }));
}

/**
 * Every case number in the corpus.
 *
 * The citation verifier uses this as its first-pass check: the corpus was
 * ingested from the official law.go.kr Open API, so presence here is proof
 * the case is real, without a network round-trip.
 */
export async function loadCorpusCaseNumbers(): Promise<Set<string>> {
  const pool = getPool();
  const { rows } = await pool.query<{ case_number: string }>(
    `SELECT case_number FROM precedents`,
  );
  return new Set(rows.map((r) => r.case_number));
}

/** How many precedents are loaded and embedded. Used for health checks. */
export async function countPrecedents(): Promise<{
  total: number;
  embedded: number;
}> {
  const pool = getPool();
  const { rows } = await pool.query<{ total: string; embedded: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(embedding) AS embedded
       FROM precedents`,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    embedded: Number(rows[0]?.embedded ?? 0),
  };
}

/** Upsert one precedent with its embedding. Used by the migration script. */
export async function upsertPrecedent(
  client: PoolClient,
  p: Precedent,
  embedding: number[] | null,
): Promise<void> {
  await client.query(
    `INSERT INTO precedents (
        case_number, court, decision_date, case_title, case_nature,
        holding, summary, facts, core_issue, legal_relationship,
        applicable_statutes, source_url, embedding, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector, now())
     ON CONFLICT (case_number) DO UPDATE SET
        court               = EXCLUDED.court,
        decision_date       = EXCLUDED.decision_date,
        case_title          = EXCLUDED.case_title,
        case_nature         = EXCLUDED.case_nature,
        holding             = EXCLUDED.holding,
        summary             = EXCLUDED.summary,
        facts               = EXCLUDED.facts,
        core_issue          = EXCLUDED.core_issue,
        legal_relationship  = EXCLUDED.legal_relationship,
        applicable_statutes = EXCLUDED.applicable_statutes,
        source_url          = EXCLUDED.source_url,
        embedding           = EXCLUDED.embedding,
        updated_at          = now()`,
    [
      p.caseNumber,
      p.court,
      p.decisionDate,
      p.caseTitle,
      p.caseNature,
      p.holding,
      p.summary,
      p.facts,
      p.coreIssue,
      p.legalRelationship,
      p.applicableStatutes,
      p.sourceUrl ?? null,
      embedding ? toVectorLiteral(embedding) : null,
    ],
  );
}
