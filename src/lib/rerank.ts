import { generateObject } from "ai";
import { z } from "zod";
import type { LegalElements, Precedent, PrecedentMatch } from "./types";
import { EXTRACTION_MODEL } from "./ai";

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
  citable: z
    .boolean()
    .describe(
      "True if the precedent's legal reasoning or holding could be cited in support of the user's argument — either as direct authority OR as analogous/supporting authority. " +
        "False only when the precedent is clearly inapplicable (different legal area, different controlling rule)."
    ),
  citabilityReason: z
    .string()
    .max(300)
    .describe("Why citable / not citable, in the user's locale. Reference the load-bearing facts."),
});

type PerCandidateAnalysis = z.infer<typeof PerCandidateAnalysisSchema>;

const RERANK_SYSTEM_PROMPT = `You are a Korean Supreme Court (대법원) precedent analyst. For a user case described by structured legal elements (in Korean) and a narrative, you evaluate ONE candidate 판례 at a time.

Your task is to determine whether the candidate precedent is **citable** for the user's case — meaning the precedent could realistically be cited in a Korean 준비서면 either as direct authority or as analogous/supporting authority.

CITABILITY — practical-attorney standard:
- "citable: true" when EITHER:
    (a) the precedent's holding could directly govern the user's case (load-bearing facts align on 쟁점, 법률관계, 당사자 지위), OR
    (b) the precedent's legal reasoning is analogous and a Korean attorney would realistically cite it as 참고 / 유추 적용 / 동일 법리 to support their argument, even if facts aren't identical.
- "citable: false" only when the precedent is clearly inapplicable — different legal area, different controlling rule, or fundamentally different legal posture (e.g. citing a criminal 사기 precedent for a civil 임대차 보증금 dispute with no overlap).
- A 매매 precedent CAN be citable to a different 매매 case for shared legal principles even if the underlying assets differ.
- An 임대차 precedent CAN be citable to a 사용대차 case for the shared 차주 의무 framework.
- The standard is "would a competent Korean attorney include this in their brief?" — that's a much wider net than "does the holding directly govern?".
- Distinguishing facts should still be flagged in distinguishingFacts, even when citable: true. Citability ≠ "no risk".

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
  locale: "ko" | "en"
): Promise<PrecedentMatch[]> {
  const top = candidates.slice(0, 6);
  const localeLabel = locale === "ko" ? "Korean (한국어)" : "English";

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
        "Evaluate citability using the practical-attorney standard above. Output the schema.",
      ].join("\n");

      try {
        const { object } = await generateObject({
          model: EXTRACTION_MODEL,
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
        citable: analysis.citable,
        citabilityReason: analysis.citabilityReason,
        verified: false,
      };
    }
    // Fallback: heuristic-only entry.
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
      citable: false,
      citabilityReason: fallbackReason,
      verified: false,
    };
  });

  matches.sort((a, b) => b.scores.final - a.scores.final);
  return matches;
}
