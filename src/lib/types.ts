import { z } from "zod";

/** Structured legal elements extracted from a fact-pattern narrative. */
export const LegalElementsSchema = z.object({
  caseNature: z.enum(["civil", "criminal", "administrative", "constitutional", "family", "labor", "tax", "commercial", "unknown"]),
  parties: z.object({
    plaintiff: z.string().describe("원고/신청인/검사 등 — role + nature (natural/juristic person)"),
    defendant: z.string().describe("피고/피신청인/피고인 — role + nature"),
  }),
  claimCause: z.string().describe("청구원인 — what legal right is being asserted and why"),
  legalRelationship: z.string().describe("법률관계 — type of legal relationship between the parties (계약, 불법행위, 부당이득, etc.)"),
  partyStatus: z.string().describe("당사자 지위 — capacity in which each party acts (소비자, 사용자, 임차인, etc.)"),
  coreIssue: z.string().describe("쟁점 — the controlling legal question"),
  damageType: z.string().describe("손해 종류 — what harm is alleged (재산상/정신적, 적극적/소극적, etc.)"),
  applicableStatutes: z.array(z.string()).describe("적용 법령 candidates — specific articles when possible (e.g. 민법 제750조)"),
  keyFacts: z.array(z.string()).describe("Load-bearing factual statements, normalized"),
  missingInfo: z.array(z.string()).describe("Information that would change the analysis if known"),
});
export type LegalElements = z.infer<typeof LegalElementsSchema>;

/** A precedent record in our corpus. */
export const PrecedentSchema = z.object({
  caseNumber: z.string().describe("사건번호 e.g. 2019다12345"),
  court: z.string().describe("법원 e.g. 대법원"),
  decisionDate: z.string().describe("선고일 YYYY-MM-DD"),
  caseTitle: z.string().describe("사건명"),
  caseNature: z.string(),
  holding: z.string().describe("판시사항"),
  summary: z.string().describe("판결요지"),
  facts: z.string().describe("Normalized fact pattern of the precedent"),
  coreIssue: z.string().describe("쟁점"),
  legalRelationship: z.string(),
  applicableStatutes: z.array(z.string()),
  sourceUrl: z.string().url().optional(),
});
export type Precedent = z.infer<typeof PrecedentSchema>;

export interface PrecedentMatch {
  precedent: Precedent;
  scores: {
    embedding: number;
    elementOverlap: number;
    final: number;
  };
  matchingFacts: string[];
  distinguishingFacts: string[];
  whyMatches: string;
  citable: boolean;
  citabilityReason: string;
  verified: boolean;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  why: string;
}
