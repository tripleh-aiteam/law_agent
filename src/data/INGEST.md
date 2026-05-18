# Corpus Ingest from law.go.kr

This document describes how to replace the seed `corpus.json` with real Korean Supreme Court (대법원) precedents pulled from the official law.go.kr Open API.

> 본 데이터는 한국 법제처(Ministry of Government Legislation)가 운영하는 law.go.kr 공개 API에서 제공받습니다. 본 프로젝트는 학습/연구 목적이며, 모든 판례 본문의 출처와 저작권은 법제처와 대법원에 있습니다.

---

## 1. Get an Open API key (OC) — 약 1-2시간 소요

1. Visit [open.law.go.kr](https://open.law.go.kr) and create an account.
2. After login, request API access ("OPEN API 활용신청"). Approval is usually granted within a few hours.
3. Your **OC** key is the **email username** (the part before `@`) of the account you registered with. It is **not** the full email and **not** a typical long random token.

## 2. Configure the environment

Add the key to `.env.local` in the project root:

```bash
LAW_GO_KR_API_KEY=your_oc_username_here
```

## 3. Verify the key

```bash
npm run check:lawgo
```

Expected:

- ✅ `API key works — ready for full ingest` → proceed.
- ❌ `No API key found` → script falls back to scrape mode (limited to ~200 cases).
- ❌ `key is set but the probe call did not return data` → the OC is not approved yet, or you set the full email rather than the username prefix.

## 4. Run the ingest

Small smoke test (5 cases, no writes):

```bash
npm run ingest:lawgo -- --limit 5 --dry-run
```

Real run (500 cases, written to `src/data/corpus-lawgo.json`):

```bash
npm run ingest:lawgo -- --limit 500
```

Useful flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--limit N` | `200` | Max cases to ingest this run. |
| `--from YYYY-MM-DD` | `2010-01-01` | Earliest 선고일자. |
| `--to YYYY-MM-DD` | today | Latest 선고일자. |
| `--out PATH` | `src/data/corpus-lawgo.json` | Output file. Default writes to a **new** file so the seed corpus is preserved. |
| `--resume` | off | Skip case numbers already present in `--out`. Periodically flushes every 25 cases so crashes are recoverable. |
| `--dry-run` | off | Do everything except write files. |

## 5. Swap in the new corpus and re-embed

Once the new file looks good (open it, spot-check 5 cases):

```bash
# back up the seed, then promote
mv src/data/corpus.json src/data/corpus.seed.json
cp src/data/corpus-lawgo.json src/data/corpus.json

# regenerate embeddings (incremental — only the new cases will be embedded)
npm run embed:corpus
```

---

## Rate limits and politeness

- **API mode:** hard-capped at **5 requests/second**. The API quota is generally generous but Korean government servers are sensitive — do not parallelize across machines.
- **Scrape mode:** hard-capped at **1 request/second**. The fallback uses `glaw.scourt.go.kr`; this is intended for local development only, not bulk acquisition.
- We send a polite `User-Agent`:
  `Law-Agent/0.1 (https://github.com/example/law-agent; korean-legal-research)`
- Transient 5xx errors are retried up to 3 times with exponential backoff.

## Throughput estimate

- API mode: roughly **1 case per 0.4 s** (one list + one detail request, both rate-limited) plus normalization latency from the LLM call (~1-3 s).
- 500 cases ≈ 10-25 minutes wall-clock (mostly LLM-bound).
- 50,000 cases ≈ 6-12 hours wall-clock.

## On HWP files

Some older 대법원 판례 are distributed as HWP (한글) attachments. The Open API returns the structured text fields (`판시사항`, `판결요지`, `판례내용`) as plain UTF-8 — we do **not** parse HWP binaries. If a future feature needs the original document, route it through a server-side HWP-to-text tool; do not add HWP parsing to this ingest path.

---

## 한국어 요약

1. `open.law.go.kr` 에서 가입 후 OPEN API 활용신청. 승인되면 가입 이메일의 **아이디 부분**이 `OC` 값입니다.
2. `.env.local` 에 `LAW_GO_KR_API_KEY=...` 형식으로 추가.
3. `npm run check:lawgo` 로 키 검증.
4. `npm run ingest:lawgo -- --limit 500` 로 인제스트. 결과는 `src/data/corpus-lawgo.json` 에 저장됩니다 (기존 `corpus.json` 은 보존됨).
5. 결과 확인 후 `corpus.json` 을 교체하고 `npm run embed:corpus` 실행.

API 호출은 초당 5건 이내로 제한되어 있으며, 법제처/대법원 서버 부담을 고려해 무리한 병렬 호출은 피해야 합니다.
