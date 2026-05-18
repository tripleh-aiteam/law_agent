# law-agent — Daily Changes Log

---

### [17:00] Hardening: bilingual fixes, hydration, button discoverability, provider swap (OpenAI → Groq + local embeddings)

- **What:** Fixed five real bugs the user hit while testing v2, then pivoted the entire AI stack to a fully-free setup.
  1. **Language-toggle bug** — auto-created folder/case names (받은 사건, 새 폴더, 이름 없는 사건) stayed Korean when toggled to English. Added optional `nameKey?: string` field on `Folder`/`CaseFile`; renderers prefer `t(nameKey)` over the literal `name`; user-typed names keep the literal. Migration in `loadInitial()` retroactively tags legacy localStorage entries with the right `nameKey`. New translation keys `sidebar.inbox / newFolderDefault / untitledCase` in both `messages/ko.json` and `messages/en.json`.
  2. **Hydration mismatch on mic button** — Web Speech detection ran inside `useMemo` so SSR returned `null` and client returned the constructor, producing a `+ <button>` diff in React's hydration tree. Moved the check into `useEffect` so the server renders without the mic button and the client adds it on mount.
  3. **Bottom "+ New case" button was actually creating a folder** — `onClick` called `createFolder(null)` despite the label saying "+ New case". Added `currentFolderId` to `CasesContext` (derived from `findParentFolderId(folders, currentCaseId)`); the bottom button now calls `createCase(currentFolderId ?? folders[0]?.id ?? null)`, auto-expands the target folder, and drops into rename mode. Added a separate small **FolderPlus** outline button for explicitly creating a new top-level folder.
  4. **Per-folder action icons were hover-only and ambiguous** — User couldn't find how to add a case to a specific folder. Switched icons from `FileText`/`Plus` to **`FilePlus` (green) for add-case** and **`FolderPlus` (amber) for add-folder**. Changed visibility from `opacity-0` to `opacity-60` so they're always visible, full opacity on hover.
  5. **Next.js 16 deprecation warnings** — `experimental.typedRoutes` moved to top-level `typedRoutes`. Renamed `src/middleware.ts` → `src/proxy.ts` (Next 16 convention).
- **Why provider swap:** OpenAI sign-up succeeded but the account had $0 credit balance (`"You exceeded your current quota"`). User asked for free options; we audited Groq (free, fast) vs Claude vs hybrid. Picked **Groq + local embeddings** for $0 sustained cost.
  - Iterated through Groq models (the painful part):
    - `llama-3.3-70b-versatile` → **fails**: no `response_format: json_schema` support
    - `openai/gpt-oss-120b` → fails: returned empty `''` JSON, schema validation rejected
    - `qwen/qwen3-32b` → fails: not on Groq's structured-outputs supported list (verified via WebFetch of https://console.groq.com/docs/structured-outputs)
    - **`meta-llama/llama-4-scout-17b-16e-instruct` ✅ works**: best-effort json_schema mode, full Korean structured output. Reverified end-to-end via curl with the office-lease test narrative.
  - Embeddings now run **locally** via `@huggingface/transformers` (`Xenova/multilingual-e5-base`, 768-dim, ~280 MB ONNX). First call downloads model (~120 s); subsequent calls ~0.4 s. Required `serverExternalPackages: ["@huggingface/transformers"]` in `next.config.ts` so Turbopack doesn't try to bundle the native ONNX runtime.
- **Files:**
  - Modified: [`src/components/cases/cases-context.tsx`](src/components/cases/cases-context.tsx) (nameKey, migration, currentFolderId), [`src/components/layout/sidebar.tsx`](src/components/layout/sidebar.tsx) (FilePlus/FolderPlus, always-visible buttons, fixed handleNewCase), [`src/components/layout/header.tsx`](src/components/layout/header.tsx) (nameKey render), [`src/components/chat/chat-input.tsx`](src/components/chat/chat-input.tsx) (useEffect mic detection), [`src/lib/ai.ts`](src/lib/ai.ts) (groq llama-4-scout), [`src/lib/retrieval.ts`](src/lib/retrieval.ts) (local-embed instead of API), [`src/lib/extractor.ts`](src/lib/extractor.ts) (unchanged call sites — model swap is transparent), [`scripts/embed-corpus.ts`](scripts/embed-corpus.ts) (local embed, BATCH=8), [`next.config.ts`](next.config.ts) (serverExternalPackages, typedRoutes moved), [`messages/ko.json`](messages/ko.json) + [`messages/en.json`](messages/en.json) (new keys)
  - Added: [`src/lib/local-embed.ts`](src/lib/local-embed.ts) (lazy pipeline, query/passage prefix handling for e5 family)
  - Renamed: `src/middleware.ts` → [`src/proxy.ts`](src/proxy.ts)
  - Package.json: `+@ai-sdk/groq`, `+@huggingface/transformers`, removed reliance on `@ai-sdk/openai` for runtime
- **End state:** Dev server stopped. `src/data/corpus-embeddings.json` exists (15 records × 768-dim, 238 KB). End-to-end pipeline verified via curl — Extract / Search / Summarize / Detailed all return valid Korean structured JSON. UI fully functional with Manus-style sidebar (FilePlus/FolderPlus), per-folder hover-visible action buttons, KO ↔ EN locale toggle.
- **Next:** User to complete law.go.kr OC key application + IP/domain registration in open.law.go.kr portal; then `npm run check:lawgo` → `npm run ingest:lawgo -- --limit 500` → manually promote `corpus-lawgo.json` to `corpus.json` → `npm run embed:corpus`. Comprehensive snapshot saved to Ruflo memory under namespace `law-agent` keys `law-agent-final-state-eod-2026-05-18` and `law-agent-next-session-quickstart` so the next session can resume without re-reading source files.

---

## 2026-05-18 (Monday) — v2: Manus-style UI · dashboard tabs · law.go.kr ingest · file upload

### Goal

Pivot v1 into a court-preparation assistant the user can actually live in: a **Manus-style UI** (left sidebar with case folders, centered chat input, voice + drag-drop + file upload), a **case dashboard** with 요약/상세/왜? tabs that auto-explain each case, real **법원 Open API ingest** to replace the 15 placeholder cases with the official Korean Supreme Court corpus, and **PDF/DOCX upload** so attorneys can drop in their actual case documents. Built with 4 parallel Claude Code subagents under one Ruflo swarm.

### Files added — Manus-style shell (parallel Agent A)

- [`src/components/cases/cases-context.tsx`](src/components/cases/cases-context.tsx) — `CasesProvider` + `useCases()`. Folder/case tree CRUD persisted to `localStorage["law-agent:cases"]`. Type: `Folder { id, name, cases: CaseFile[], subfolders: Folder[] }`. Auto-creates a 받은 사건 (Inbox) folder when none exists so new cases never get lost.
- [`src/components/layout/app-shell.tsx`](src/components/layout/app-shell.tsx) — wraps everything in `CasesProvider`; sidebar + header + scrollable main column.
- [`src/components/layout/sidebar.tsx`](src/components/layout/sidebar.tsx) — 280px rail; recursive folder/case tree; inline rename; per-row hover action buttons (add case, add folder, rename, delete); `+ 새 사건` button anchored bottom.
- [`src/components/layout/header.tsx`](src/components/layout/header.tsx) — editable case title + `🌐 EN ↔ 한국어` toggle (next-intl locale routing, `router.replace` to keep history clean) + ⚙ settings placeholder.
- [`src/components/chat/chat-input.tsx`](src/components/chat/chat-input.tsx) — Manus-style: autoresize textarea + `+ 📎` file picker (POSTs to `/api/upload`, appends `[FROM FILE: <name>]\n<extracted>`) + drag-drop overlay + paste-files + `🎤` Web Speech (ko-KR, continuous + interim, hidden on Firefox/Safari) + Cmd/Ctrl+Enter send. ≥20-char gate. Pipeline: `/api/extract` → `/api/search` → persists matches into current case so dashboard can read them.
- [`src/components/chat/action-chips.tsx`](src/components/chat/action-chips.tsx) — 5 prefilled prompts driven by `chips.*` translations.

### Files added — case dashboard + analysis APIs (parallel Agent B)

- [`src/components/dashboard/case-dashboard.tsx`](src/components/dashboard/case-dashboard.tsx) — Tabs wrapper (`요약 / 상세 / 왜?`), per-(caseId+locale) in-memory cache, lazy-loads each tab on first view, empty/loading/error states. Accepts either context (`useCases().currentCase`) or props (`narrative`, `elements`, `matches`) as a fallback path.
- [`src/components/dashboard/summary-view.tsx`](src/components/dashboard/summary-view.tsx) — overview · keyIssue · parties · claim · statute chip-row.
- [`src/components/dashboard/detailed-view.tsx`](src/components/dashboard/detailed-view.tsx) — factPattern · legalAnalysis · applicableStatutes table (citation ↔ why) · strategic-notes callout · openQuestions bullets.
- [`src/components/dashboard/why-view.tsx`](src/components/dashboard/why-view.tsx) — custom accordion (no `@radix-ui/react-accordion` install needed). Per-match: reasoning · `pairedMappings` 3-col grid (사용자 사실 / 판례 사실 / 같은 이유) · green citation-strategy callout · amber distinguishing-risk callout.
- [`src/app/api/case/summarize/route.ts`](src/app/api/case/summarize/route.ts) — `POST {narrative, elements, locale}` → `{summary: {overview, keyIssue, parties, claim, statutes[]}}`. `generateObject` with `gpt-4o`, 60s timeout, zod-validated.
- [`src/app/api/case/detailed/route.ts`](src/app/api/case/detailed/route.ts) — `POST` → `{detailed: {factPattern, legalAnalysis, applicableStatutes[{citation,why}], strategicNotes, openQuestions[]}}`.
- [`src/app/api/case/why/route.ts`](src/app/api/case/why/route.ts) — `POST {narrative, elements, match}` → `{why: {reasoning, pairedMappings[3-5], citationStrategy, distinguishingRisk}}`.

### Files added — law.go.kr ingest (parallel Agent C)

- [`src/lib/lawgo-client.ts`](src/lib/lawgo-client.ts) — dual-mode client. **API mode** (OC key set): `www.law.go.kr/DRF/lawSearch.do` (list, `org=400201` for 대법원) + `lawService.do` (detail), 5 req/s, exponential-backoff retry on 5xx, polite UA. **Scrape mode** (no key): `glaw.scourt.go.kr/wsjo/panre/sjo060.do` via cheerio, 1 req/s, ~200-case cap. Korean date `YYYY.MM.DD.` → `YYYY-MM-DD`. `checkApiKey()` probes the API.
- [`src/lib/lawgo-normalizer.ts`](src/lib/lawgo-normalizer.ts) — `normalizeToPrecedent(detail)`. Maps raw law.go.kr fields → our `Precedent` schema; uses `generateObject` with `gpt-4o` to LLM-extract `coreIssue` (쟁점), `legalRelationship`, normalized `applicableStatutes`, synthesized `facts` (3-6 sentence Korean fact pattern), and enum-restricted `caseNature`. Final result validated via `PrecedentSchema.parse`.
- [`scripts/ingest-lawgo.ts`](scripts/ingest-lawgo.ts) — CLI: `--limit/--from/--to/--out/--dry-run/--resume`. Banner shows mode + probe result + time estimate for `--limit > 1000`. Periodic flush every 25 cases. Writes `.failed.json` sidecar. **Defaults `--out` to `src/data/corpus-lawgo.json`** so the seed corpus stays intact until user explicitly promotes.
- [`scripts/check-lawgo-key.ts`](scripts/check-lawgo-key.ts) — user-facing probe; prints `✅ ready for full ingest` or `❌ no key → scrape mode (capped ~200)`.
- [`src/data/INGEST.md`](src/data/INGEST.md) — bilingual KO+EN: how to apply for OC key, register IP, set env, verify, ingest, embed, rate-limit reasoning, HWP note, throughput estimates.

### Files added — file upload (parallel Agent D)

- [`src/lib/file-extractor.ts`](src/lib/file-extractor.ts) — `extractFromBuffer(buffer, filename, mimeType)` + `buildNarrativeFromFiles`. PDF via `pdf-parse` (scanned-PDF detection → "OCR not performed" warning); DOCX via `mammoth`; TXT/MD UTF-8 with BOM strip; HWP/HWPX → empty + bilingual warning ("convert to PDF").
- [`src/app/api/upload/route.ts`](src/app/api/upload/route.ts) — `POST multipart/form-data`; caps: 20 MB/file, 5 files/request, 40 MB total (HTTP 413). Per-file failure → `text: ""` + warnings (not 500). Response: `{files: ExtractedFile[]}`.
- [`src/lib/FILE-EXTRACTOR.md`](src/lib/FILE-EXTRACTOR.md) — format/limit doc, planned HWP-via-Python-sidecar upgrade path.

### Files updated

- [`src/app/[locale]/page.tsx`](src/app/%5Blocale%5D/page.tsx) — replaced hero+IntakeForm with `<AppShell><CaseDashboard /><ChatInput /><ActionChips /></AppShell>`.
- [`src/app/[locale]/layout.tsx`](src/app/%5Blocale%5D/layout.tsx) — Pretendard CDN `<link>` + Korean-first font stack; `bg-slate-50` body.
- [`src/app/globals.css`](src/app/globals.css) — `--font-sans` var → Tailwind picks up Pretendard everywhere.
- [`messages/ko.json`](messages/ko.json) + [`messages/en.json`](messages/en.json) — new keys `dashboard.*`, `shell.*`, `sidebar.*`, `chat.*`, `chips.*`, `header.*` (existing v1 keys preserved).
- [`package.json`](package.json) — `+cheerio@^1.2.0`, `+pdf-parse@^1.1.1`, `+mammoth@^1.8.0`, `+@types/pdf-parse@^1.1.4`; scripts `+ingest:lawgo`, `+check:lawgo`.

### Multi-agent execution

4 Claude Code subagents dispatched in parallel under the same Ruflo swarm with strict file-ownership boundaries: **A** (UI shell), **B** (dashboard + analysis APIs), **C** (law.go.kr ingest), **D** (file upload). No file collisions. Coordination via shared types in `src/lib/types.ts` and a documented import contract (`@/components/cases/cases-context` for `useCases`, `@/components/dashboard/case-dashboard` for the dashboard).

### What this unblocks

```bash
npm install                  # picks up cheerio, pdf-parse, mammoth
npm run dev                  # Manus UI runs against the 15 seed cases right now
```

The full Manus-style attorney experience works today against the 15-case seed corpus. To switch to the real Korean Supreme Court corpus the user needs to:

1. Apply for **OC key** at `open.law.go.kr` (회원가입 → Open API 신청)
2. **Register their server IP** in the open.law.go.kr portal (otherwise API returns `사용자 검증 실패 / IP 등록 필요`)
3. Set `LAW_GO_KR_API_KEY` in `.env.local`
4. `npm run check:lawgo` → expect ✅
5. `npm run ingest:lawgo -- --limit 500` (writes `corpus-lawgo.json`)
6. `cp src/data/corpus-lawgo.json src/data/corpus.json`
7. `npm run embed:corpus`

### Next

- **User action required** — OC key + IP registration at `open.law.go.kr`. Everything else is ready.
- **Web Speech API limitation:** mic auto-hidden on Firefox/Safari (only Chromium browsers support `SpeechRecognition`).
- **HWP files unsupported in v1** — bilingual warning shown when user uploads `.hwp`. Future: Python sidecar service for HWP→text.
- **Scrape-mode smoke test** could not be verified inside the sandbox (outbound to `glaw.scourt.go.kr` was blocked). Needs verification on the user's machine.
- **Once corpus lands:** add automated tests for the retrieval + rerank pipeline against the real data.

---

## 2026-05-18 (Monday) — v1 scaffold: 대법원 판례 검색 AI agent

### Goal

Build a Korean Supreme Court case-law search agent from a greenfield directory. The user's spec: take a **fact-pattern narrative** (not keywords), find the **most factually similar 대법원 판례**, and only surface precedents that would survive 인용 (citation) scrutiny. Must support **KO + EN** UI and inputs. Built with parallel multi-agent execution (Ruflo swarm + Claude Code Agent tool).

### Architecture

```
narrative → /api/extract  (LLM → 청구원인/법률관계/쟁점/...)
          → clarifying-question loop (optional)
          → /api/search   (embed → cosine top-10
                            → element-overlap rerank (0.4·embed + 0.6·overlap)
                            → citability filter
                            → law.go.kr verifier)
          → ranked precedents with side-by-side fact mapping
            + distinguishing-facts caution
```

Stack: Next.js 16 App Router · React 19 · AI SDK v6 via Vercel AI Gateway (`openai/gpt-4o` + `openai/text-embedding-3-large`) · next-intl (ko/en) · Tailwind + shadcn/ui · local JSON corpus for v1.

### Files added — base scaffold

- [`package.json`](package.json) — Next 16, AI SDK v6, next-intl, shadcn deps
- [`tsconfig.json`](tsconfig.json), [`next.config.ts`](next.config.ts), [`tailwind.config.ts`](tailwind.config.ts), [`postcss.config.mjs`](postcss.config.mjs), [`components.json`](components.json) — config baseline
- [`.env.example`](.env.example) — `AI_GATEWAY_API_KEY`, `LAW_GO_KR_API_KEY`
- [`.gitignore`](.gitignore), [`README.md`](README.md)
- [`src/i18n/routing.ts`](src/i18n/routing.ts), [`src/i18n/request.ts`](src/i18n/request.ts), [`src/i18n/navigation.ts`](src/i18n/navigation.ts), [`src/middleware.ts`](src/middleware.ts) — next-intl wiring (ko default, en secondary, `localePrefix: "always"`)
- [`messages/ko.json`](messages/ko.json), [`messages/en.json`](messages/en.json) — full bilingual translation tables (common, home, intake, elements, results)
- [`src/app/globals.css`](src/app/globals.css), [`src/app/[locale]/layout.tsx`](src/app/%5Blocale%5D/layout.tsx) — Tailwind base + `NextIntlClientProvider`
- [`src/lib/utils.ts`](src/lib/utils.ts), [`src/lib/types.ts`](src/lib/types.ts) — `cn` helper + zod schemas (`LegalElementsSchema`, `PrecedentSchema`, `PrecedentMatch`, `ClarifyingQuestion`)

### Files added — UI layer (parallel Agent A)

- [`src/components/ui/`](src/components/ui/) — hand-written shadcn primitives: `button.tsx`, `card.tsx`, `textarea.tsx`, `label.tsx`, `badge.tsx`, `separator.tsx`, `tabs.tsx`, `skeleton.tsx` (added `success`/`warning` badge variants for verified/unverified)
- [`src/components/locale-switcher.tsx`](src/components/locale-switcher.tsx) — KO/EN toggle via `useRouter`+`usePathname` from `@/i18n/navigation`
- [`src/components/intake-form.tsx`](src/components/intake-form.tsx) — client orchestrator: textarea → POST `/api/extract` → optional clarifying-question panel → POST `/api/search` → skeleton loaders → results
- [`src/components/clarifying-questions-panel.tsx`](src/components/clarifying-questions-panel.tsx) — inline Q+A with "why we're asking" rationale; user can skip
- [`src/components/extracted-elements-card.tsx`](src/components/extracted-elements-card.tsx) — collapsible card showing extracted 청구원인/법률관계/쟁점/etc.
- [`src/components/results-list.tsx`](src/components/results-list.tsx) — ranked match cards with citable/verified badges, score chips (embedding / element / final, all 0..1 rendered as %), expandable "Why it matches" side-by-side (matching vs distinguishing facts in destructive accent)
- [`src/app/[locale]/page.tsx`](src/app/%5Blocale%5D/page.tsx) — hero + intake form with header `LocaleSwitcher`; calls `setRequestLocale`
- [`src/app/page.tsx`](src/app/page.tsx) — root redirects to `/ko`

### Files added — backend pipeline (parallel Agent B)

- [`src/lib/ai.ts`](src/lib/ai.ts) — model constants (`EXTRACTION_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS=3072`) + `cosineSimilarity`
- [`src/lib/extractor.ts`](src/lib/extractor.ts) — `extractLegalElements()` via `generateObject` with schema extended to include 0–4 clarifying questions. Korean legal terms preserved in output regardless of UI locale.
- [`src/lib/retrieval.ts`](src/lib/retrieval.ts) — `loadCorpus`, `loadCorpusEmbeddings`, `embedQuery`, `buildQueryText` (front-loads 쟁점 → 법률관계 → 청구원인 → key facts → narrative tail capped at 800 chars), `semanticSearch` (cosine, top-K)
- [`src/lib/rerank.ts`](src/lib/rerank.ts) — `elementOverlapScore` (Jaccard + char-bigram heuristic robust to Korean compounds) and `llmReranker` (per-candidate `generateObject` for matching/distinguishing facts + citability boolean + reason). Final blend `0.4·embedding + 0.6·elementOverlap`; embedding cosine remapped `[-1,1]→[0,1]`. Per-candidate failure falls back to heuristic-only with `citable:false` instead of failing the whole request.
- [`src/lib/verifier.ts`](src/lib/verifier.ts) — `verifyCitation()` against `https://www.law.go.kr/DRF/lawSearch.do?target=prec&...` with in-process Map cache; fail-closed for external lookup, fail-open for local-corpus presence when no API key.
- [`src/app/api/extract/route.ts`](src/app/api/extract/route.ts), [`src/app/api/search/route.ts`](src/app/api/search/route.ts), [`src/app/api/verify/route.ts`](src/app/api/verify/route.ts) — all `runtime: "nodejs"`, `maxDuration: 60`, zod-validated, graceful empty-corpus handling
- [`scripts/embed-corpus.ts`](scripts/embed-corpus.ts) — `tsx`-runnable; reads `corpus.json`, builds precedent-side embedding text, calls `embedMany`, writes `corpus-embeddings.json`. Idempotent unless `--force`.

### Files added — corpus (parallel Agent C)

- [`src/data/corpus.json`](src/data/corpus.json) — **15 representative 대법원 판례** spanning civil (4), 불법행위/손해배상 (3), 노동 (2), 상사 (2), 형사 (2), 행정 (1), 가사 (1). All in Korean with full 판시사항 / 판결요지 / facts / 쟁점 / 적용 법령. ~30 KB.
- [`src/data/corpus.README.md`](src/data/corpus.README.md) — KO+EN doc on adding precedents and re-running `npm run embed:corpus`.

### Multi-agent execution

- Ruflo swarm initialized (`swarm-1779062547793-eqxr6f`, `hierarchical-mesh`, 6 agents max, specialized strategy). Project brief + v1 state persisted to Ruflo memory under namespace `law-agent`.
- After base scaffolding (sequential), three Claude Code subagents ran in **parallel** with strict file-ownership boundaries: Agent A (UI), Agent B (backend), Agent C (corpus). They never collided on the same path.

### What this unblocks

```bash
npm install
cp .env.example .env.local   # set AI_GATEWAY_API_KEY
npm run embed:corpus         # build corpus-embeddings.json
npm run dev                  # http://localhost:3000 → redirects to /ko
```

A user can paste a Korean fact-pattern narrative in either language and get a ranked list of citable 대법원 precedents with a side-by-side fact-mapping explanation.

### Next

- **Corpus accuracy:** Agent C's 15 case numbers use plausible 대법원 docket format but are not all confirmed real cases — the verifier surfaces them as "unverified". Replace with confirmed real cases before relying on them. Get `LAW_GO_KR_API_KEY` from open.law.go.kr.
- **Clarifying answers don't re-extract:** answers append to the narrative but structured `elements` reflect only the original input. Add an optional re-extract step after the user answers clarifying questions.
- **Streaming UX:** rerank does 6 per-candidate LLM calls; stream them to the UI for perceived latency.
- **Tests:** add retrieval-pipeline tests once corpus is locked in.
- **Optional upgrade path:** swap local JSON corpus for pgvector via Supabase Marketplace once corpus grows beyond ~100 cases.

---
