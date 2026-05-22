import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import {
  compareDocuments,
  diffToTextForLlm,
} from "@/lib/document-diff";
import { EXTRACTION_MODEL } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 800;

const BodySchema = z.object({
  original: z.string().min(1, "original text is required"),
  modified: z.string().min(1, "modified text is required"),
  locale: z.enum(["ko", "en"]),
  /** When true, also runs LLM analysis of what the changes mean
   * legally. When false (default), returns just the structural diff. */
  analyzeLegalSignificance: z.boolean().optional().default(false),
});

const AnalysisSchema = z.object({
  overallAssessment: z
    .string()
    .describe(
      "2-3 sentence executive summary in the user's locale: what's the net effect of these changes for the user? Better, worse, neutral? Top 1-2 changes that matter most.",
    ),
  keyChanges: z
    .array(
      z.object({
        summary: z
          .string()
          .describe(
            "Short Korean+English description of this change (1 line).",
          ),
        impact: z
          .enum(["favorable", "unfavorable", "neutral"])
          .describe(
            "Is this change in the user's favor, against them, or neutral?",
          ),
        explanation: z
          .string()
          .describe(
            "1-2 sentence explanation in the user's locale of the legal significance. Preserve Korean legal terms (강행규정, 약관 등) inline.",
          ),
      }),
    )
    .min(1)
    .max(15)
    .describe(
      "Each substantive change grouped by legal-meaning effect. Aim for 3-8 items for typical contract edits.",
    ),
});

const ANALYSIS_SYSTEM_PROMPT = `You are a Korean contract attorney explaining the legal significance of changes between two versions of a document to your client.

For each substantive change in the diff:
  • Identify whether it's FAVORABLE (helps the user), UNFAVORABLE (hurts the user), or NEUTRAL (housekeeping / clarification with no real legal effect).
  • Explain WHY in 1-2 sentences. Reference specific Korean statutes or principles where relevant (강행규정, 약관규제법, 손해배상 예정, 불공정 약관 등).
  • Skip trivial whitespace / typo / formatting changes.

Group all changes into 3-8 "keyChanges" items. Group related edits (e.g., several wording tweaks in the same liability clause) into one keyChange.

The user's perspective: assume they're reviewing changes the OTHER PARTY proposed to a contract — be skeptical and flag risks aggressively.

Output in user's locale (Korean or English) for explanations; Korean legal terms stay inline even in English.`;

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      },
      { status: 400 },
    );
  }

  // 1. Always compute the structural diff (fast, free, no LLM).
  const diff = compareDocuments(parsed.data.original, parsed.data.modified);

  if (!parsed.data.analyzeLegalSignificance) {
    return NextResponse.json({ diff });
  }

  // 2. Optional LLM pass: analyze legal meaning of the changes.
  const diffText = diffToTextForLlm(diff);
  if (!diffText.trim()) {
    return NextResponse.json({
      diff,
      analysis: {
        overallAssessment:
          parsed.data.locale === "ko"
            ? "두 문서가 동일합니다 — 변경 사항이 없습니다."
            : "The two documents are identical — no changes detected.",
        keyChanges: [],
      },
    });
  }

  try {
    const userPrompt = [
      `User locale: ${parsed.data.locale === "ko" ? "Korean (한국어)" : "English"}`,
      "",
      "Diff summary (-- removed, ++ added, ~~ replaced):",
      "---",
      diffText.slice(0, 20_000),
      "---",
      "",
      "Analyze the legal significance of each substantive change.",
    ].join("\n");

    const result = await generateObject({
      model: EXTRACTION_MODEL,
      schema: AnalysisSchema,
      system: ANALYSIS_SYSTEM_PROMPT,
      prompt: userPrompt,
      abortSignal: req.signal,
      maxOutputTokens: 4096,
      temperature: 0,
    });

    return NextResponse.json({ diff, analysis: result.object });
  } catch (err) {
    // Analysis failed but the diff itself is fine — return diff with an
    // explanatory error in the analysis field.
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({
      diff,
      analysisError: message,
    });
  }
}
