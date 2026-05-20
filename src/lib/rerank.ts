import { generateObject } from "ai";
import { z } from "zod";
import type { LegalElements, Precedent, PrecedentMatch } from "./types";
import { RERANK_MODEL } from "./ai";
import { safeModelId } from "./models";
import { resolveModelForUse } from "./resolve-model";

/* ----------------------------- heuristic layer ----------------------------- */

/** Lowercase + collapse whitespace for fuzzy comparison. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Token-set Jaccard over a normalized Korean+ASCII string. */
function jaccard(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  // Korean is largely non-whitespace-delimited at the token level; combine
  // whitespace split with bigram fallback so e.g. "임대차계약" and "임대차 계약"
  // still score meaningfully.
  const setA = new Set<string>();
  const setB = new Set<string>();
  for (const t of na.split(/\s+/)) if (t) setA.add(t);
  for (const t of nb.split(/\s+/)) if (t) setB.add(t);
  // Character bigrams for residual signal.
  for (let i = 0; i < na.length - 1; i++) setA.add(na.slice(i, i + 2));
  for (let i = 0; i < nb.length - 1; i++) setB.add(nb.slice(i, i + 2));
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Overlap ratio between two string arrays (Jaccard over normalized items). */
function arrayOverlap(a: string[], b: string[]): { ratio: number; matches: string[] } {
  if (!a.length || !b.length) return { ratio: 0, matches: [] };
  const normB = b.map(normalize);
  const matches: string[] = [];
  for (const item of a) {
    const ni = normalize(item);
    if (!ni) continue;
    if (normB.some((nb) => nb.includes(ni) || ni.includes(nb))) {
      matches.push(item);
    }
  }
  const union = new Set<string>([...a.map(normalize), ...normB]);
  return { ratio: union.size === 0 ? 0 : matches.length / union.size, matches };
}

/**
 * Heuristic element-overlap score. Cheap, deterministic, and used both as
 * a fast pre-filter and as a fallback when the LLM reranker fails on a
 * candidate. Returns score in [0,1] plus shallow matching/distinguishing
 * fact lists derived from the structured elements alone.
 */
export function elementOverlapScore(
  input: LegalElements,
  candidate: Precedent
): { score: number; matchingFacts: string[]; distinguishingFacts: string[] } {
  const issueSim = jaccard(input.coreIssue ?? "", candidate.coreIssue ?? "");
  const relSim = jaccard(input.legalRelationship ?? "", candidate.legalRelationship ?? "");
  const statuteOverlap = arrayOverlap(input.applicableStatutes ?? [], candidate.applicableStatutes ?? []);
  const partySim = jaccard(input.partyStatus ?? "", candidate.caseNature ?? "");

  // Weighted blend tuned for legal retrieval: 쟁점 and statutes dominate.
  const score =
    0.4 * issueSim + 0.25 * relSim + 0.25 * statuteOverlap.ratio + 0.1 * partySim;

  const matchingFacts: string[] = [];
  if (issueSim > 0.2) matchingFacts.push(`쟁점 유사: ${candidate.coreIssue}`);
  if (relSim > 0.2) matchingFacts.push(`법률관계 유사: ${candidate.legalRelationship}`);
  for (const m of statuteOverlap.matches) matchingFacts.push(`적용 법령 일치: ${m}`);

  const distinguishingFacts: string[] = [];
  if (issueSim < 0.1 && candidate.coreIssue) {
    distinguishingFacts.push(`쟁점 차이: ${candidate.coreIssue}`);
  }
  if (relSim < 0.1 && candidate.legalRelationship) {
    distinguishingFacts.push(`법률관계 차이: ${candidate.legalRelationship}`);
  }
  const inputStatutes = new Set((input.applicableStatutes ?? []).map(normalize));
  for (const s of candidate.applicableStatutes ?? []) {
    if (!inputStatutes.has(normalize(s))) distinguishingFacts.push(`판례 적용 법령: ${s}`);
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    matchingFacts,
    distinguishingFacts,
  };
}

/* -------------------------------- LLM layer -------------------------------- */

const PerCandidateAnalysisSchema = z.object({
  matchingFacts: z
    .array(z.string())
    .max(8)
    .describe("Load-bearing facts shared between the user case and this precedent. Korean."),
  distinguishingFacts: z
    .array(z.string())
    .max(8)
    .describe("Load-bearing facts that differ and could undermine reliance on this precedent. Korean."),
  whyMatches: z
    .string()
    .max(400)
    .describe("1–3 sentence explanation in the user's locale of why this precedent is or isn't applicable."),
  citability: z
    .enum(["strong", "supporting", "weak"])
    .describe(
      "Tiered citability rating: " +
        "'strong' = precedent's holding could directly govern the user's case (인용 가능 강력); " +
        "'supporting' = analogous authority worth citing as 참고 / 유추 적용 (참고 자료); " +
        "'weak' = limited applicability — different legal area or rule (제한적 적용)."
    ),
  citabilityReason: z
    .string()
    .max(300)
    .describe("Why this tier, in the user's locale. Reference the load-bearing facts."),
});

type PerCandidateAnalysis = z.infer<typeof PerCandidateAnalysisSchema>;

const RERANK_SYSTEM_PROMPT = `You are a Korean Supreme Court (대법원) precedent analyst. For a user case described by structured legal elements (in Korean) and a narrative, you evaluate ONE candidate 판례 at a time and assign a 3-tier citability rating.

CITABILITY TIERS — pick exactly one:

"strong" — 인용 가능 강력 (direct authority):
- The precedent's holding could directly govern the user's case
- Load-bearing facts align on 쟁점, 법률관계, 당사자 지위
- A court applying this precedent's holding would resolve the user's case
- Example: User case = 임대차 보증금 반환 분쟁. Precedent = 임대차보증금 반환청구 (2017다220744). → "strong" because the holding directly applies.

"supporting" — 참고 자료 (analogous authority worth citing) — DEFAULT for most relevant matches:
- The precedent shares a legal concept, 법률관계 family, or statute family with the user's case
- A Korean attorney would realistically cite it as 참고 / 유추 적용 in a 준비서면
- Direct holding doesn't govern but the reasoning supports the user's argument
- Examples:
   - User case = 매매계약 하자담보. Precedent = 도급계약 하자담보책임. → "supporting" (shared 하자담보 framework)
   - User case = 임대차 보증금. Precedent = 임차인 소유권 취득 후 대항력 상실. → "supporting" (same 임대차 area, can cite for 참고)
   - User case = 부동산 매매. Precedent = 매매대금반환. → "supporting" (related civil remedy)
   - User case = 형사 사기. Precedent = 형사 횡령. → "supporting" (both 형법, similar 기망 elements)

"weak" — 제한적 적용 (limited applicability):
- Different 사건 종류 (e.g. criminal precedent for a civil contract dispute) AND no shared concept
- Or fundamentally different legal posture with no obvious analogy
- Examples:
   - User case = 임대차 보증금 (civil). Precedent = 마약류관리법 위반 (criminal). → "weak"
   - User case = 매매계약 해제. Precedent = 행정처분 취소. → "weak"
   - User case = 양도소득세 부과. Precedent = 디자인 권리범위. → "weak"

KEY HEURISTICS:
- Most relevant matches the user sees will be "supporting" — that's the most useful tier for daily attorney work.
- Be generous with "supporting" — Korean attorneys cite analogous authority frequently. The 참고 자료 category is the workhorse of legal briefs.
- Only assign "weak" when the precedent is truly from a different domain with no useful overlap.
- Reserve "strong" for cases where the holding's direct application would resolve the user's dispute.
- When choosing between "supporting" and "weak", default to "supporting".
- Distinguishing facts go in distinguishingFacts regardless of tier — the user always needs the risk awareness.

OUTPUT RULES:
- matchingFacts / distinguishingFacts: Korean. Reference concrete facts, not abstractions.
- whyMatches: 1–3 sentences in the user's locale. Plain language. No hedging filler.
- citabilityReason: in the user's locale. Tie the verdict to specific load-bearing facts.`;

const PER_CANDIDATE_TIMEOUT_MS = 25_000;

interface RerankCandidate {
  precedent: Precedent;
  embedding: number;
}

/**
 * LLM-assisted reranking. Calls the LLM per candidate (top N=6) for parallel
 * latency, falls back to heuristic scoring when an individual call fails so
 * a single bad candidate doesn't break the whole request.
 *
 * Final score blend: 0.4 * embedding + 0.6 * elementOverlap (both normalized).
 * Embedding cosine is already in [-1,1]; we clamp to [0,1] via (x+1)/2. The
 * heuristic overlap is already in [0,1]. The 0.6 weight on element overlap
 * reflects that legal reasoning hinges on element alignment, not surface
 * semantic similarity — embedding scores are useful for recall, structured
 * overlap is the precision signal.
 */
export async function llmReranker(
  narrative: string,
  elements: LegalElements,
  candidates: RerankCandidate[],
  locale: "ko" | "en",
  modelId?: string,
): Promise<PrecedentMatch[]> {
  const top = candidates.slice(0, 6);
  const localeLabel = locale === "ko" ? "Korean (한국어)" : "English";
  // Caller-selected model overrides the default RERANK_MODEL.
  // Prefer direct provider keys when set; fall back to gateway string.
  const model = modelId
    ? (resolveModelForUse(modelId) ?? safeModelId(modelId))
    : RERANK_MODEL;

  const analyses = await Promise.all(
    top.map(async (c): Promise<{ analysis: PerCandidateAnalysis | null; heuristic: ReturnType<typeof elementOverlapScore> }> => {
      const heuristic = elementOverlapScore(elements, c.precedent);
      const userPrompt = [
        `User locale (for whyMatches and citabilityReason): ${localeLabel}`,
        "",
        "User case — structured elements (Korean):",
        JSON.stringify(elements, null, 2),
        "",
        "User case — narrative tail:",
        narrative.trim().slice(-1200),
        "",
        "Candidate precedent:",
        JSON.stringify(
          {
            caseNumber: c.precedent.caseNumber,
            court: c.precedent.court,
            decisionDate: c.precedent.decisionDate,
            caseTitle: c.precedent.caseTitle,
            caseNature: c.precedent.caseNature,
            coreIssue: c.precedent.coreIssue,
            legalRelationship: c.precedent.legalRelationship,
            applicableStatutes: c.precedent.applicableStatutes,
            holding: c.precedent.holding,
            summary: c.precedent.summary,
            facts: c.precedent.facts,
          },
          null,
          2
        ),
        "",
        "Assign one of the 3 citability tiers (strong / supporting / weak) using the rules above. Output the schema.",
      ].join("\n");

      try {
        const { object } = await generateObject({
          model,
          schema: PerCandidateAnalysisSchema,
          system: RERANK_SYSTEM_PROMPT,
          prompt: userPrompt,
          abortSignal: AbortSignal.timeout(PER_CANDIDATE_TIMEOUT_MS),
          maxOutputTokens: 1024,
        });
        return { analysis: object, heuristic };
      } catch {
        return { analysis: null, heuristic };
      }
    })
  );

  const matches: PrecedentMatch[] = top.map((c, i) => {
    const { analysis, heuristic } = analyses[i];
    // Normalize embedding cosine [-1,1] → [0,1]
    const embNorm = Math.max(0, Math.min(1, (c.embedding + 1) / 2));
    const overlapNorm = heuristic.score; // already 0..1
    const final = 0.4 * embNorm + 0.6 * overlapNorm;

    if (analysis) {
      return {
        precedent: c.precedent,
        scores: { embedding: embNorm, elementOverlap: overlapNorm, final },
        matchingFacts: analysis.matchingFacts,
        distinguishingFacts: analysis.distinguishingFacts,
        whyMatches: analysis.whyMatches,
        citability: analysis.citability,
        // Backwards-compat boolean: true unless tier is "weak".
        citable: analysis.citability !== "weak",
        citabilityReason: analysis.citabilityReason,
        verified: false,
      };
    }
    // Fallback: heuristic-only entry — assign a conservative middle tier
    // ("supporting") because the heuristic at least confirmed topical overlap.
    const fallbackReason =
      locale === "ko"
        ? "LLM 분석 실패로 휴리스틱 점수만 사용했습니다. 인용 전 추가 검토가 필요합니다."
        : "LLM analysis failed; falling back to heuristic scores. Manual review required before citing.";
    return {
      precedent: c.precedent,
      scores: { embedding: embNorm, elementOverlap: overlapNorm, final },
      matchingFacts: heuristic.matchingFacts,
      distinguishingFacts: heuristic.distinguishingFacts,
      whyMatches: fallbackReason,
      citability: "supporting",
      citable: true,
      citabilityReason: fallbackReason,
      verified: false,
    };
  });

  matches.sort((a, b) => b.scores.final - a.scores.final);
  return matches;
}
