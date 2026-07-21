# Handoff prompt — for Claude Code on the firm server

Clone the repo on the server, `cd` into it, start Claude Code, and paste the
block below as your first message. It gives that session everything it needs
without you re-explaining the project.

---

## Copy from here ↓

```
You are working on Law Agent, a Korean legal AI tool, on our firm's own Linux
server. Read DEPLOY.md and
docs/superpowers/specs/2026-07-21-law-agent-onprem-enterprise-design.md first —
they contain the full context and phase plan.

WHAT THIS PROJECT IS
Law Agent finds Korean Supreme Court (대법원) precedents by fact pattern rather
than keywords, and produces court-ready analysis for our law team. It was
previously hosted on Vercel and is being moved on-prem.

WHERE THINGS STAND
Phase 1 (on-prem foundation) has been written but NEVER RUN. It was authored on
a Windows dev machine without Docker running, so it is typecheck-clean and
nothing more. Your first job is to make it actually work on this server.

Phase 1 changed:
  - Embeddings are now LOCAL and on-CPU (Xenova/multilingual-e5-base, 768-dim)
    in src/lib/local-embed.ts. Previously they went through the Vercel AI
    Gateway at 1536-dim. The corpus MUST be re-embedded; dimensions can't mix.
  - The 47MB JSON corpus moved to Postgres + pgvector (db/init.sql,
    src/lib/db.ts, src/lib/retrieval.ts).
  - All Vercel AI Gateway fallbacks were removed. Every LLM call goes direct to
    its provider with our own key (src/lib/resolve-model.ts).
  - Added: Dockerfile, docker-compose.yml, Caddyfile, .env.production.example,
    scripts/migrate-corpus-to-db.ts, and /api/health.

YOUR TASK — bring Phase 1 up and verify it end to end:

  1. cp .env.production.example .env
     Set POSTGRES_PASSWORD (openssl rand -base64 32) and at least GROQ_API_KEY.
     Ask me for keys — do not invent them.
  2. docker compose up -d --build
  3. Fix whatever breaks. Expect real problems: this code has never executed.
     Likely suspects are the @huggingface/transformers API surface in
     local-embed.ts (verify against the installed version's actual types), the
     Dockerfile's model pre-download step, and pgvector literal formatting.
  4. docker compose exec app npx tsx scripts/migrate-corpus-to-db.ts
  5. curl -s http://localhost:3000/api/health | jq
     Expect status "ok" and corpus.embedded == 409.
  6. Open /ko in a browser, ask a real Korean legal question, and confirm you
     get BOTH an analysis AND precedent matches.

VERIFICATION STANDARD
Do not tell me something works because it compiles. Run it, show me the output,
and quote the actual result. If a step fails, say so plainly rather than
working around it silently.

IMPORTANT CONTEXT

- law.go.kr allowlists by IP. It blocked Vercel's US IPs, which is a main
  reason we moved. From this Korean server it should work. Get the server's
  public IP (curl -s https://api.ipify.org), register it at open.law.go.kr,
  and confirm citation verification actually returns results.
- Only GROQ_API_KEY was known-valid as of 2026-07-21. Anthropic, OpenAI,
  Google and the Vercel Gateway keys had all EXPIRED. Groq alone is enough
  for the system to work; the paid keys give much better Korean quality.
- DO NOT delete the Vercel project yet. Keep it as a fallback until this
  server is proven. Removal is the last step of Phase 1 and needs my explicit
  go-ahead.
- Never commit .env or any API key. .env and .env.local are gitignored — keep
  it that way.

KNOWN DEFECT — HIGHEST PRIORITY AFTER DEPLOYMENT
The LLM fabricates Korean case numbers inside its prose. Real examples it
produced: 대법원 2005다12345, 2010다56789, 2018다34567, 2021다11223 — none exist
in our 409-case corpus. Precedents in the results panel are real (they come
from the corpus), but citations written into the narrative text are NOT
checked. For a tool attorneys take into court this is the most dangerous
behavior in the system. It is Phase 5 in the spec; raise it with me once the
deployment is stable.

AFTER PHASE 1 IS VERIFIED
Phases 2-5 are specified in the design doc: per-attorney accounts
(admin-created, password reset emailed from tripleh.agents@gmail.com), moving
cases from browser localStorage into Postgres, an audit log, enforced PII
redaction before any text leaves our network, and the citation-integrity fix.
Confirm with me before starting any of them.
```

## Copy to here ↑

---

## What to have ready before you start

- **Database password** — `openssl rand -base64 32`
- **At least one LLM key.** `GROQ_API_KEY` is free: <https://console.groq.com/keys>
- **law.go.kr OC code**, and the server's public IP registered at <https://open.law.go.kr>
- **Server public IP** — `curl -s https://api.ipify.org`

## A realistic expectation

Phase 1 was written but never executed — there was no running Docker on the
machine where it was authored. It typechecks, and the logic follows the
existing codebase's patterns, but **expect the first `docker compose up` to
fail on something.** That is normal for un-run infrastructure code, and the
prompt above tells Claude to expect it too.

The most likely failure points, in order:

1. `@huggingface/transformers` v4 API details in `src/lib/local-embed.ts` —
   the pooling/tensor-slicing shape should be checked against the installed
   version's real types.
2. The model pre-download step in the `Dockerfile` builder stage.
3. pgvector literal formatting in `src/lib/db.ts`.
