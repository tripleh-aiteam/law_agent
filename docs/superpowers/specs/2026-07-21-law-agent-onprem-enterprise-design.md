# Law Agent — On-Prem Enterprise Design

**Date:** 2026-07-21
**Status:** Approved (design); Phase 1 to be built and verified locally first
**Author:** brainstorming session

---

## 1. Purpose

Move Law Agent off Vercel and onto the firm's own Linux server, and raise it from a
single-user demo to an internal enterprise tool for the firm's law team.

Two things force the move, beyond preference:

1. **law.go.kr blocks Vercel's US egress IPs**, so citation verification is
   permanently degraded in production. A Korean office server hits law.go.kr from a
   Korean IP and simply works.
2. **Vercel's 250 MB function limit** is what forced the project off local
   embeddings onto the Vercel AI Gateway. On-prem, that limit does not exist, so
   local embeddings become available again — removing a paid dependency, removing
   the currently-broken Gateway, and keeping retrieval entirely inside the network.

## 2. Context — where the project stands

| Concern | Today |
|---|---|
| Authentication | None. Anyone with the URL has full access. |
| Case storage | Browser `localStorage` only (`src/components/cases/cases-context.tsx`). Not on any server; lost when cache clears; invisible to colleagues. |
| Multi-user | None. |
| Audit trail | None. |
| Corpus | 409 대법원 cases in a 47 MB JSON file, loaded into memory. |
| Embeddings | Vercel AI Gateway → `openai/text-embedding-3-small` (1536-dim). **Key expired; retrieval is down.** |
| Hosting | Vercel project `law-agent`, org `team_4IeLLCy4FPvg4HwTXD9roXs3`. |

Working and worth preserving: legal element extraction, the 7-section detailed
analysis, LLM rerank, court drafts, contract redline, PII redaction, document diff,
KO/EN bilingual UI.

## 3. Requirements

**Confirmed with the user:**

- Internal tool for **one firm's law team**. No multi-tenancy, no public access.
- Runs on the **company's own Linux server**, deployed via **Docker**.
- Server has **open outbound internet**; external LLM API keys will be used.
- **One account per attorney**, created by an admin. No self-signup.
- **Password reset by emailed link**, sent from `tripleh.agents@gmail.com`.
- **PII auto-redacted before any text leaves the network.**
- Local **CPU** embeddings.
- Server RAM: >12 GB total, shared with other applications.
- **Build and verify locally first**, then deploy to the company server.

**Non-goals (explicitly out of scope):**

- Multi-tenant SaaS, per-firm billing, public sign-up.
- Air-gapped / self-hosted LLM inference.
- Splitting the backend into a separate API service.

## 4. Approach

**Chosen: harden the existing Next.js app in place, phased.**

The application logic is sound and tested; the gaps are around it (auth,
persistence, packaging), not inside it. A rewrite would discard working Korean
legal prompt engineering for no user-visible benefit.

Rejected:
- *Separate API service + frontend* — weeks of re-plumbing, zero benefit for a
  single law team.
- *Move on-prem with no enterprise layers* — leaves an unauthenticated tool holding
  privileged client data. Access control and audit **are** the requirement.

## 5. Target architecture

```
[Attorney browser — firm intranet]
            │ HTTPS (internal DNS)
            ▼
     ┌──────────────┐
     │   caddy      │  TLS termination, reverse proxy
     └──────┬───────┘
            ▼
     ┌──────────────────────────────────┐
     │   app  (Next.js 16, standalone)  │
     │  ├─ PII redact      ── local     │
     │  ├─ embeddings      ── local CPU │
     │  ├─ LLM calls       ── external ─┼──▶ OpenAI / Anthropic / Google
     │  └─ law.go.kr verify            ─┼──▶ law.go.kr  (Korean IP ✓)
     └──────┬───────────────────────────┘
            ▼
     ┌──────────────────────────┐
     │  db (Postgres + pgvector)│  corpus, cases, users, audit
     └──────────────────────────┘
```

Only two categories of data leave the network: **redacted** text to LLM providers,
and case numbers to law.go.kr. Retrieval and redaction are fully local.

### Service boundaries

| Service | Responsibility | Depends on |
|---|---|---|
| `caddy` | TLS, reverse proxy | `app` |
| `app` | UI, API routes, LLM orchestration, embeddings, redaction | `db`, external LLM APIs |
| `db` | Postgres 17 + pgvector: corpus vectors, cases, users, audit log | — |

## 6. Phases

Each phase is independently useful and independently shippable.

| Phase | Delivers | Rationale |
|---|---|---|
| **1. On-prem foundation** | Docker stack, Postgres + pgvector, local embeddings, direct LLM keys, Vercel decommissioned | Restores precedent search (broken today) and removes the Gateway dependency |
| **2. Access control** | Per-attorney accounts, admin screen, reset-by-email, sessions | Makes it safe to hold real client data |
| **3. Shared case memory** | Cases move `localStorage` → Postgres, visible across the team | Turns a personal tool into firm infrastructure |
| **4. Audit + PII gate** | Per-attorney query log; redaction enforced before egress | The compliance story |
| **5. Citation integrity** | Eliminate fabricated case numbers; verify every citation against law.go.kr | Highest legal risk; law.go.kr works from a Korean IP |

**Note on ordering:** Phase 5 is last because it is the most involved, *not* because
it matters least. An attorney citing a non-existent 판례 in court is the worst
outcome this system can produce. The user may promote it at any time.

## 7. Phase 1 — detailed scope

### 7.1 Changes

| # | Change | Files |
|---|---|---|
| 1 | `output: "standalone"` for a slim runtime image | `next.config.ts` |
| 2 | Restore local embeddings — `multilingual-e5-base` via `@huggingface/transformers` | `src/lib/local-embed.ts` |
| 3 | Corpus from 47 MB JSON → Postgres + pgvector | new `src/lib/db.ts`, `src/lib/retrieval.ts` |
| 4 | Remove AI Gateway paths; direct provider keys only | `src/lib/resolve-model.ts`, `src/lib/ai.ts` |
| 5 | Container packaging | new `Dockerfile`, `docker-compose.yml`, `.env.production.example` |
| 6 | One-time corpus migration | new `scripts/migrate-corpus-to-db.ts` |

### 7.2 Embedding model change

Current Gateway embeddings are **1536-dim**; `multilingual-e5-base` is **768-dim**.
All 409 cases must therefore be re-embedded. This is free, local, and takes minutes.

`src/lib/local-embed.ts` already carries a `role: "query" | "passage"` parameter,
retained "for API compat" when the project moved to the Gateway. e5 models require
exactly these prefixes (`query: ` / `passage: `), so the parameter becomes
meaningful again rather than being a no-op.

`EMBEDDING_DIMS` changes from 1536 to 768 and must be updated everywhere it is
consumed.

### 7.3 Database schema (Phase 1 subset)

Only the corpus lands in Postgres in Phase 1. Cases, users, and audit tables arrive
in Phases 2–4.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE precedents (
  case_number      TEXT PRIMARY KEY,
  court            TEXT,
  decided_on       DATE,
  holding          TEXT,          -- 판시사항
  summary          TEXT,          -- 판결요지
  full_text        TEXT,          -- 전문
  metadata_only    BOOLEAN NOT NULL DEFAULT FALSE,
  embedding        vector(768),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX precedents_embedding_idx
  ON precedents USING hnsw (embedding vector_cosine_ops);
```

### 7.4 Local-first build

Phase 1 is built and verified on the Windows development machine before it touches
the company server. Docker Desktop v29.1.3 and Compose v2.40.3 are already
installed there; WSL2 is available; Node is v24.14.1. The daemon must be started.

The same `docker-compose.yml` is then used on the Linux server unchanged.

**Caddy is not started in the local build.** TLS on `localhost` adds friction with no
benefit, so the local stack runs `app` + `db` only and the app is reached directly on
its port. Caddy is defined in a `proxy` compose profile that is activated on the
server (`docker compose --profile proxy up`), so the same file serves both
environments without divergence.

## 8. Vercel decommissioning

Deliberately last, and reversible until the final step.

1. Export Vercel env vars and any state worth keeping.
2. Stand up on-prem; verify end-to-end.
3. Run both in parallel briefly.
4. Remove the domain alias (`law-agent-jet.vercel.app`).
5. **Delete the Vercel project** — irreversible. Requires explicit user confirmation
   at that moment.
6. Strip `.vercel/` and `.vercelignore` from the repo.

The Vercel CLI is not installed on the development machine; step 5 needs
`npm i -g vercel` or the Vercel dashboard.

## 9. Testing

| Test | Purpose |
|---|---|
| Retrieval parity | Same queries before/after the dim change; results must not degrade |
| Embedding sanity | Known-similar 임대차 cases must score highly against each other |
| law.go.kr verification | Expected to start **working** from a Korean IP (blocked on Vercel) |
| Playwright UI drive | End-to-end ask flow; harness already exists from prior session |
| Cold start | `docker compose up` from scratch on a clean machine |
| Typecheck | `npx tsc --noEmit` clean |

## 10. Risks

| Risk | Handling |
|---|---|
| Re-embedding changes result quality | Parity test before deleting anything from Vercel |
| Server RAM shared with other apps | >12 GB total; tune Postgres `shared_buffers`, keep embed batch small |
| 47 MB corpus JSON in git | Moves to the database; JSON retained as seed only |
| Losing Vercel as a fallback | Keep Vercel live until on-prem is proven |
| Expired provider keys (Anthropic, OpenAI, Google, Gateway) | Must be rotated before Phase 1 can be fully verified; only `GROQ_API_KEY` is currently valid |

## 11. Open items

- Company server OS/distribution and internal DNS/TLS arrangements not yet supplied.
- Whether an existing corporate proxy must be traversed for outbound calls.
- SMTP app password for `tripleh.agents@gmail.com` (needed in Phase 2, not Phase 1).
