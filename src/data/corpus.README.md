# Precedent Corpus / 판례 코퍼스

This directory holds the seed corpus of Korean Supreme Court (대법원) precedents used by the AI case-law search agent. It is loaded by the retrieval pipeline and embedded for semantic search.

이 디렉터리에는 AI 판례 검색 에이전트가 사용하는 대법원 판례 시드 코퍼스가 포함되어 있습니다.

## Files

- `corpus.json` — array of `Precedent` records, each conforming to `PrecedentSchema` in `src/lib/types.ts`.
- `corpus-embeddings.json` — **generated**, do not edit by hand. Produced by `scripts/embed-corpus.ts`.

## Adding a new precedent / 새 판례 추가하기

1. Append a new object to the array in `corpus.json`. **Every field required by `PrecedentSchema` must be present.** See `src/lib/types.ts` for the canonical definition.
2. Required fields (모든 필드 필수):
   - `caseNumber` — e.g. `"2019다12345"` (civil), `"2020도5678"` (criminal), `"2021두1234"` (administrative), `"2022므9999"` (family).
   - `court` — typically `"대법원"`.
   - `decisionDate` — `YYYY-MM-DD`.
   - `caseTitle` — 사건명.
   - `caseNature` — one of `civil`, `criminal`, `administrative`, `constitutional`, `family`, `labor`, `tax`, `commercial`.
   - `holding` — 판시사항 (2–4 sentences, formal 판결문 style).
   - `summary` — 판결요지 (2–4 sentences).
   - `facts` — normalized 3–6 sentence fact pattern in Korean. **This is the primary field used by the embedding pipeline**, so write it carefully.
   - `coreIssue` — 쟁점, a single Korean sentence stating the controlling legal question.
   - `legalRelationship` — short Korean phrase describing the legal relationship.
   - `applicableStatutes` — string array of specific Korean article citations (e.g. `["민법 제750조"]`).
3. Optional:
   - `sourceUrl` — include **only** when you can verify the URL points to the actual decision (e.g. on glaw.scourt.go.kr or casenote.kr). If you cannot verify, **omit the field** so the citation verifier marks the entry as unverified.
4. Save the file. Then re-run the embedding pipeline:
   ```bash
   npm run embed:corpus
   ```
   This regenerates `corpus-embeddings.json`. **Skipping this step means your new entry will not be searchable.**

판례를 추가한 후에는 반드시 `npm run embed:corpus`를 실행하여 임베딩을 재생성해야 합니다. 그렇지 않으면 새 판례가 검색되지 않습니다.

## Unverified entries / 미검증 항목

Records without a verified `sourceUrl` will surface in the UI as **"unverified" (미검증)**. The citation verifier (built separately) flags these so the user knows the case number and content have not been confirmed against an authoritative source. This is by design for the v1 seed corpus — several entries use plausible-format case numbers as representative patterns rather than confirmed citations.

`sourceUrl`이 검증되지 않은 항목은 UI에서 **"미검증"**으로 표시됩니다. v1 시드 코퍼스의 일부 항목은 검증된 인용이 아닌 대표적인 패턴으로서 형식만 그럴듯한 사건번호를 사용하므로, 사용자가 인용 전에 원문 확인이 필요함을 인지하도록 의도된 설계입니다.

## Constraints

- Keep the file under ~100 KB to keep embedding cost and load time reasonable.
- Do not commit `corpus-embeddings.json` edits by hand.
- Do not duplicate `caseNumber` values.
