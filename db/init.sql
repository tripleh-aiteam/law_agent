-- Law Agent — on-prem schema (Phase 1)
--
-- Runs automatically on first container start: the official postgres image
-- executes every *.sql in /docker-entrypoint-initdb.d exactly once, when the
-- data directory is empty. Re-running `docker compose up` will NOT re-execute
-- this file; drop the volume to reinitialize.
--
-- Phase 1 stores only the precedent corpus. Users, cases and the audit log
-- arrive in Phases 2-4.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS precedents (
  case_number           TEXT PRIMARY KEY,           -- 사건번호, e.g. 2019다12345
  court                 TEXT NOT NULL,              -- 법원
  decision_date         TEXT NOT NULL,              -- 선고일 (kept TEXT: source data is not uniformly ISO)
  case_title            TEXT NOT NULL DEFAULT '',   -- 사건명
  case_nature           TEXT NOT NULL DEFAULT '',
  holding               TEXT NOT NULL DEFAULT '',   -- 판시사항
  summary               TEXT NOT NULL DEFAULT '',   -- 판결요지
  facts                 TEXT NOT NULL DEFAULT '',   -- normalized fact pattern
  core_issue            TEXT NOT NULL DEFAULT '',   -- 쟁점
  legal_relationship    TEXT NOT NULL DEFAULT '',
  applicable_statutes   TEXT[] NOT NULL DEFAULT '{}',
  source_url            TEXT,
  -- 768 dims = Xenova/multilingual-e5-base. If the embedding model ever
  -- changes, this column's dimension must change with it AND every row must
  -- be re-embedded — pgvector rejects mismatched dimensions at insert time.
  embedding             vector(768),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW + cosine: the app normalizes embeddings, so cosine and inner product
-- rank identically, but cosine keeps the stored operator honest if a future
-- model emits unnormalized vectors.
CREATE INDEX IF NOT EXISTS precedents_embedding_idx
  ON precedents USING hnsw (embedding vector_cosine_ops);

-- Partial index: retrieval only ever reads rows that have an embedding.
CREATE INDEX IF NOT EXISTS precedents_embedded_idx
  ON precedents (case_number)
  WHERE embedding IS NOT NULL;
