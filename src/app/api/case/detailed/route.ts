import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { LegalElementsSchema } from "@/lib/types";
import { EXTRACTION_MODEL } from "@/lib/ai";
import { safeModelId } from "@/lib/models";
import { resolveModelForUse } from "@/lib/resolve-model";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  narrative: z.string().min(10, "narrative must be at least 10 characters"),
  elements: LegalElementsSchema,
  locale: z.enum(["ko", "en"]),
  model: z.string().optional(),
});

const DetailedSchema = z.object({
  detailed: z.object({
    factPattern: z
      .string()
      .describe(
        "Single paragraph rewrite of the user's narrative in formal legal Korean. Always Korean prose, regardless of locale."
      ),
    legalAnalysis: z
      .string()
      .describe(
        "2–4 paragraphs analyzing the 쟁점 and 법률관계 with citations to expected lines of authority (general doctrines, not specific case numbers). In user locale."
      ),
    applicableStatutes: z
      .array(
        z.object({
          citation: z
            .string()
            .describe("Korean statute citation, e.g. '민법 제750조'."),
          why: z
            .string()
            .describe(
              "ONE sentence explaining why this statute applies to the fact pattern. In user locale, preserving Korean legal terms."
            ),
        })
      )
      .describe(
        "Deduplicated list of applicable statutes, each with a one-sentence 'why each applies'."
      ),
    strategicNotes: z
      .string()
      .describe(
        "2–3 sentences of pre-court strategic advice — what to emphasize and what to avoid. In user locale."
      ),
    openQuestions: z
      .array(z.string())
      .describe(
        "Unresolved factual / legal questions the attorney should address before court. In user locale."
      ),
  }),
});

const SYSTEM_PROMPT = `You are a senior Korean litigation paralegal preparing the "Detailed" tab of a case dashboard for a Korean attorney about to enter court.

OUTPUT LANGUAGE
- factPattern: ALWAYS formal legal Korean (한국어), regardless of locale. This is the canonical record-style fact statement.
- legalAnalysis, applicableStatutes[].why, strategicNotes, openQuestions: user locale (ko or en). Preserve Korean legal terms inline even when locale=en (쟁점, 법률관계, 청구원인, 당사자 지위, 손해 등).
- Statute citations are ALWAYS Korean ("민법 제750조", "상법 제382조의3").

CONTENT RULES
- factPattern: ONE paragraph. Strip narrative color. Use formal legal register (e.g. "원고는 ... 하였고, 피고는 ... 하였다"). Preserve every load-bearing fact.
- legalAnalysis: 2–4 paragraphs. Analyze the 쟁점, identify the 법률관계, and reference general lines of authority by doctrine name — DO NOT cite specific case numbers (e.g. "대법원 2019다12345"). Specific case numbers come from a separate retrieval step.
- applicableStatutes: deduplicate. For each, exactly ONE sentence explaining why it applies to the fact pattern.
- strategicNotes: 2–3 sentences. Tactical advice for trial prep — what arguments to emphasize, what counter-arguments to anticipate, what to avoid raising.
- openQuestions: unresolved questions that would shift the analysis. Concrete, addressable items — not generic "더 조사 필요".

DO NOT
- Invent statutes or doctrines unsupported by the narrative.
- Cite specific case numbers — leave those for the retrieval layer.`;

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
      { status: 400 }
    );
  }

  const { narrative, elements, locale } = parsed.data;

  const userPrompt = [
    `User locale (for legalAnalysis, strategicNotes, openQuestions, applicableStatutes.why): ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    `factPattern MUST be in Korean (한국어) regardless of locale.`,
    "",
    "Narrative:",
    "---",
    narrative.trim(),
    "---",
    "",
    "Already-extracted legal elements (Korean, authoritative):",
    "```json",
    JSON.stringify(elements, null, 2),
    "```",
    "",
    "Produce the 5-field detailed analysis. Follow language and length rules exactly.",
  ].join("\n");

  try {
    const model = parsed.data.model
      ? (resolveModelForUse(parsed.data.model) ?? safeModelId(parsed.data.model))
      : EXTRACTION_MODEL;
    const result = await generateObject({
      model,
      schema: DetailedSchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      abortSignal: AbortSignal.timeout(55_000),
      maxOutputTokens: 3072,
    });
    return NextResponse.json(result.object);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Detailed analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
