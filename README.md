# Law Agent — 대법원 판례 검색 AI

Find Korean Supreme Court precedents by **fact pattern**, not keywords. Returns precedents that would survive citation scrutiny (인용), with a side-by-side fact-mapping explanation and distinguishing-facts warning.

## Spec (from the user)

1. Match precedents to the **most factually similar** case.
2. Only such matches are citable (인용 가능한 판례).
3. Keyword search returns too much noise.
4. Input is a detailed factual narrative; output is a curated list of similar-case precedents.
5. The agent finds the most similar precedent from a sentence-form fact description.

## Stack

- **Next.js 16** App Router with React 19
- **AI SDK v6** via **Vercel AI Gateway** (`"openai/gpt-4o"`, `"openai/text-embedding-3-large"`)
- **next-intl** for KO + EN bilingual UI
- **Tailwind + shadcn/ui** (new-york style)
- **Local JSON corpus** for v1 (10–20 seed 대법원 cases) — upgradeable to pgvector via Supabase
- **law.go.kr** for citation verification (when API key is set)

## Run

```bash
npm install
cp .env.example .env.local   # add AI_GATEWAY_API_KEY
npm run embed:corpus         # one-time: precompute corpus embeddings
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — it redirects to `/ko` or `/en`.

## Architecture

```
User narrative
  → /api/extract     (LLM → structured 청구원인/법률관계/쟁점/...)
  → /api/clarify     (optional follow-up questions)
  → /api/search      (embed query → cosine search corpus
                       → element-level rerank
                       → citability filter
                       → why-it-matches explanation)
  → /api/verify      (law.go.kr lookup — confirms case actually exists)
  → ranked precedents UI with side-by-side fact mapping
```

## Status

Greenfield, v1 in progress. See `Daily_changes.md` for the build log.
