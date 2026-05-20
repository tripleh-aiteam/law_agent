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

/**
 * Citability is graded into 3 tiers — much better than a binary citable/not
 * because most analogous precedents fall somewhere in the middle:
 *  - "strong"    : precedent's holding would survive 인용 scrutiny — direct authority
 *  - "supporting": worth citing as 참고 / 유추 적용 — analogous authority
 *  - "weak"      : limited applicability — different legal area or rule
 *
 * UI renders these as green / amber / slate badges respectively.
 */
export type CitabilityTier = "strong" | "supporting" | "weak";

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
  /** 3-tier citability assessment. */
  citability: CitabilityTier;
  /** Convenience flag derived from citability — true unless tier is "weak". */
  citable: boolean;
  citabilityReason: string;
  verified: boolean;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  why: string;
}

/**
 * One entry in a case file's question history. Each time the user hits
 * Send, the textarea contents (their question, NOT the combined narrative)
 * are appended here so they can see their conversation history.
 *
 * @deprecated Kept only so older localStorage payloads still hydrate. New
 * code uses CaseTurn, which carries the answer for each question inline.
 */
export interface CaseQuestion {
  id: string;
  text: string;
  /** ISO timestamp when the question was sent. */
  createdAt: string;
  /** AI model that processed this question (for the receipt). */
  modelId?: string;
  /** Filenames of attached files at the time of asking — shown for context. */
  attachmentNames?: string[];
}

/**
 * Status of one conversation turn (Q → A pair).
 *  - "pending"    : extract/search still running. Stop button visible.
 *  - "complete"   : answer populated.
 *  - "cancelled"  : user clicked Stop; Q stays visible but answer is empty.
 *  - "error"      : pipeline threw; `error` carries the message.
 */
export type TurnStatus = "pending" | "complete" | "cancelled" | "error";

/**
 * A single conversational exchange under one case. Each Send creates one
 * turn that carries BOTH the question and its own answer payload — so the
 * conversation thread can render Q→A→Q→A independently per turn instead
 * of all questions sharing one global "latest result".
 */
/**
 * One per-model answer attached to a turn. When the user picks N models
 * and hits Send, the turn gets N branches — one per model — and the UI
 * renders them as tabs so the user can compare and pick the best.
 */
export interface TurnBranch {
  /** Model that produced this branch (gateway-form id, e.g. "anthropic/claude-opus-4.7"). */
  modelId: string;
  status: TurnStatus;
  /** Manus-style 1–2 paragraph summary in the user's locale. */
  summary?: string;
  elements?: LegalElements;
  matches?: PrecedentMatch[];
  /** Human-readable error message when status === "error". */
  error?: string;
  /** Local timestamp when this branch started (for the elapsed counter). */
  startedAt?: number;
  finishedAt?: number;
}

export interface CaseTurn {
  id: string;
  /** The question text exactly as the user typed it. */
  question: string;
  /** ISO timestamp when the user hit Send. */
  createdAt: string;
  /** Filenames attached when the question was sent. */
  attachmentNames?: string[];
  /** Full narrative actually sent to /api/extract (question + file text). */
  narrative?: string;
  /**
   * Aggregate status across all branches:
   *  - pending: at least one branch still running
   *  - complete: all branches in a terminal state (and at least one complete)
   *  - cancelled: user pressed Stop before any branch completed
   *  - error: every branch errored
   */
  status: TurnStatus;
  /**
   * One entry per model the user selected when this turn was sent. Always
   * present on new turns (len >= 1). Old turns that predate the multi-model
   * refactor won't have this — render code synthesizes a single branch
   * from the legacy fields below.
   */
  branches?: TurnBranch[];
  /** Model the user marked as the best answer for this turn, if any. */
  bestBranchModelId?: string;

  // ── Legacy single-model fields ──────────────────────────────────────
  // Old turns wrote answers directly onto these fields. New code writes
  // into `branches`. Kept here for back-compat with localStorage payloads
  // from before the multi-model refactor.
  /** @deprecated use branches[0].modelId */
  modelId?: string;
  /** @deprecated use branches[0].summary */
  summary?: string;
  /** @deprecated use branches[0].elements */
  elements?: LegalElements;
  /** @deprecated use branches[0].matches */
  matches?: PrecedentMatch[];
  /** @deprecated use branches[0].error */
  error?: string;
}
