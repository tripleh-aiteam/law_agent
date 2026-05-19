/**
 * Normalizer: law.go.kr LawGoDetail → our Precedent schema.
 *
 * Some fields in our Precedent schema do not exist in the raw law.go.kr data
 * (coreIssue, legalRelationship, a normalized fact-pattern, our canonical
 * applicableStatutes shape, and a tight caseNature enum). We use AI SDK v6
 * `generateObject` with EXTRACTION_MODEL to derive them from the holding +
 * summary + the first slice of the opinion text.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { EXTRACTION_MODEL } from "./ai";
import { PrecedentSchema, type Precedent } from "./types";
import type { LawGoDetail, LawGoListItem } from "./lawgo-client";

const NORMALIZED_NATURES = [
  "civil",
  "criminal",
  "administrative",
  "constitutional",
  "family",
  "labor",
  "tax",
  "commercial",
] as const;

const NormalizationSchema = z.object({
  coreIssue: z
    .string()
    .describe("쟁점 — the controlling legal question, one Korean sentence phrased as a question the court answered."),
  legalRelationship: z
    .string()
    .describe("법률관계 — a short Korean phrase naming the type of legal relationship (e.g. '임대차계약상 보증금 반환의무')."),
  applicableStatutes: z
    .array(z.string())
    .describe("적용 법령 — specific Korean statute citations (e.g. '민법 제618조'), deduplicated."),
  facts: z
    .string()
    .describe("사실관계 — a normalized 3-6 sentence Korean fact pattern of the underlying dispute."),
  caseNature: z.enum(NORMALIZED_NATURES).describe("Best-matching coarse case nature."),
});

type Normalization = z.infer<typeof NormalizationSchema>;

const SYSTEM_PROMPT = `You normalize Korean Supreme Court (대법원) precedents into a structured retrieval-ready form.

You will receive:
- holding (판시사항)
- summary (판결요지)
- a partial fullText (판례내용 첫 부분)
- the raw 사건종류명 and 판결유형 strings
- a list of referencedStatutes (참조조문 원문) parsed from the case

Produce these fields, ALL in Korean unless noted:
1. coreIssue (쟁점) — 1 sentence in Korean, phrased as the controlling legal question.
2. legalRelationship (법률관계) — short Korean phrase naming the legal relationship type.
3. applicableStatutes — specific Korean statute citations following the convention "법명 제XX조" (e.g. "민법 제750조", "상법 제382조의3"). Deduplicate; include the parsed referencedStatutes if they fit this shape and discard noise. If a referenced item lacks an article number but the holding/summary supports a more specific citation, prefer the specific form.
4. facts (사실관계) — a normalized 3-6 sentence Korean fact pattern reconstructing the underlying dispute from holding + summary + fullText. Strip narrative color. If the source text is purely doctrinal, write a faithful hypothetical that mirrors the case posture.
5. caseNature — classify into ONE of: civil, criminal, administrative, constitutional, family, labor, tax, commercial. Map: 민사→civil, 형사→criminal, 행정→administrative, 헌법/위헌→constitutional, 가사/이혼→family, 노동/근로→labor, 조세/세무→tax, 상사/회사→commercial. Default to civil if ambiguous.

Be concrete. Avoid generic boilerplate. Use canonical Korean legal terminology.`;

const TIMEOUT_MS = 60_000;
const FULLTEXT_MAX_CHARS = 4000;

function buildUserPrompt(d: LawGoDetail): string {
  return [
    `사건번호: ${d.caseNumber}`,
    `사건명: ${d.caseTitle}`,
    `법원: ${d.court}`,
    `선고일: ${d.decisionDate}`,
    `사건종류명(원문): ${d.caseNature || "(없음)"}`,
    `판결유형(원문): ${d.judgmentType || "(없음)"}`,
    "",
    "판시사항:",
    "---",
    d.holding || "(없음)",
    "---",
    "",
    "판결요지:",
    "---",
    d.summary || "(없음)",
    "---",
    "",
    "참조조문(원문):",
    d.referencedStatutes.length > 0 ? d.referencedStatutes.join(", ") : "(없음)",
    "",
    "판례내용 (앞부분):",
    "---",
    (d.fullText ?? "").slice(0, FULLTEXT_MAX_CHARS),
    "---",
  ].join("\n");
}

/** Merge two statute lists, dedupe, prefer the more specific form. */
function mergeStatutes(fromLlm: string[], fromRaw: string[]): string[] {
  const norm = (s: string) =>
    s
      .replace(/\s+/g, "")
      .replace(/\.$/, "")
      .trim();
  const map = new Map<string, string>();
  for (const s of [...fromLlm, ...fromRaw]) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    const key = norm(trimmed);
    if (!map.has(key)) map.set(key, trimmed);
  }
  return Array.from(map.values());
}

/**
 * Normalize a raw law.go.kr detail record into a `Precedent`.
 * Throws if Zod validation of the final object fails.
 */
export async function normalizeToPrecedent(detail: LawGoDetail): Promise<Precedent> {
  const result = await generateObject({
    model: EXTRACTION_MODEL,
    schema: NormalizationSchema,
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(detail),
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    maxOutputTokens: 1500,
  });
  const norm = result.object as Normalization;

  const applicableStatutes = mergeStatutes(norm.applicableStatutes, detail.referencedStatutes);

  const precedent: Precedent = {
    caseNumber: detail.caseNumber,
    court: detail.court || "대법원",
    decisionDate: detail.decisionDate,
    caseTitle: detail.caseTitle || detail.caseNumber,
    caseNature: norm.caseNature,
    holding: detail.holding,
    summary: detail.summary,
    facts: norm.facts,
    coreIssue: norm.coreIssue,
    legalRelationship: norm.legalRelationship,
    applicableStatutes,
    sourceUrl: detail.sourceUrl,
  };

  // Final shape-check using the canonical schema so we never write garbage.
  return PrecedentSchema.parse(precedent);
}

// ────────────────────────────────────────────────────────────────────────────
// List-only fallback
// ────────────────────────────────────────────────────────────────────────────
//
// Used when the law.go.kr detail endpoint is unavailable (e.g. demo OC key,
// or the user's IP is not yet registered in their open.law.go.kr portal).
// We build a Precedent from list-level metadata only (사건번호 + 사건명 +
// 법원 + 선고일 + 사건종류명) and let the LLM make a CONSERVATIVE inference
// about the legal shape from the case title alone. The holding and summary
// fields are explicitly placeholder so attorneys see this is metadata-only.

const LIST_ONLY_SYSTEM_PROMPT = `You normalize a Korean Supreme Court precedent FROM ITS TITLE METADATA ONLY. You do NOT have the holding (판시사항), summary (판결요지), or full text. Be CONSERVATIVE — do not invent facts.

You receive:
- 사건번호 (case number, e.g. "2024다123456")
- 사건명 (case title — sometimes detailed, sometimes terse)
- 법원, 선고일자, 사건종류명 (coarse type, e.g. "민사" / "형사" / "일반행정")

Produce, ALL in Korean:
1. coreIssue — 1 Korean sentence stating the LIKELY legal question implied by the title. When uncertain, phrase as "사건명에 따르면 …에 관한 쟁점으로 추정됨" — be explicit about inference.
2. legalRelationship — short Korean phrase, e.g. "임대차계약", "불법행위", "행정처분 취소", "조세부과 처분".
3. applicableStatutes — best-guess specific citations from the title's hints (e.g. "민법 제618조" for 임대차). Empty array if title is uninformative. NEVER fabricate articles you can't infer from the title.
4. facts — 1-2 Korean sentences derived ONLY from the title. No invented dates, party names, or amounts. Use hedging language ("사건명에 따르면 …").
5. caseNature — map from 사건종류명: 민사→civil, 형사→criminal, 행정/일반행정→administrative, 가사→family, 노동→labor, 상사→commercial, 조세/세무→tax, 헌법→constitutional. Default civil if ambiguous.

Conservative > confident. We don't have the actual judgment.`;

function buildListOnlyPrompt(item: LawGoListItem): string {
  return [
    `사건번호: ${item.caseNumber}`,
    `사건명: ${item.caseTitle || "(제목 없음)"}`,
    `법원: ${item.court}`,
    `선고일: ${item.decisionDate}`,
    `사건종류명(원문): ${item.caseNature || "(없음)"}`,
  ].join("\n");
}

/**
 * Build a `Precedent` from list-level metadata only.
 *
 * Used as a fallback when the detail API returns no body (typical for the
 * public sample OC key `h7874`, or when the user's IP is not yet registered).
 * The resulting record is **clearly marked** in the holding/summary fields
 * so the UI / verifier / attorney can see this case is metadata-only.
 */
export async function normalizeFromListItem(item: LawGoListItem): Promise<Precedent> {
  const result = await generateObject({
    model: EXTRACTION_MODEL,
    schema: NormalizationSchema,
    system: LIST_ONLY_SYSTEM_PROMPT,
    prompt: buildListOnlyPrompt(item),
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    maxOutputTokens: 800,
  });
  const norm = result.object as Normalization;

  const sourceUrl = `https://www.law.go.kr/판례/${encodeURIComponent(item.caseNumber)}`;

  const precedent: Precedent = {
    caseNumber: item.caseNumber,
    court: item.court || "대법원",
    decisionDate: item.decisionDate,
    caseTitle: item.caseTitle || item.caseNumber,
    caseNature: norm.caseNature,
    // Clear placeholder so the UI surfaces that this is metadata-only.
    holding: `[메타데이터만 - 사건명 기반 추정] ${item.caseTitle || item.caseNumber}`,
    summary:
      "판시사항·판결요지·판결문 전문은 등록된 IP에서 추가 인증이 필요합니다. 현재 사건명·사건번호·선고일 메타데이터만 제공됩니다.",
    facts: norm.facts,
    coreIssue: norm.coreIssue,
    legalRelationship: norm.legalRelationship,
    applicableStatutes: norm.applicableStatutes,
    sourceUrl,
  };

  return PrecedentSchema.parse(precedent);
}
