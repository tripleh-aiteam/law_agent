import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { LegalElementsSchema, PrecedentSchema } from "@/lib/types";
import { EXTRACTION_MODEL } from "@/lib/ai";
import { safeModelId } from "@/lib/models";
import { resolveModelForUse } from "@/lib/resolve-model";

export const runtime = "nodejs";
export const maxDuration = 800;

/** zod mirror of the TypeScript PrecedentMatch interface in src/lib/types.ts. */
const PrecedentMatchSchema = z.object({
  precedent: PrecedentSchema,
  scores: z.object({
    embedding: z.number(),
    elementOverlap: z.number(),
    final: z.number(),
  }),
  matchingFacts: z.array(z.string()),
  distinguishingFacts: z.array(z.string()),
  whyMatches: z.string(),
  citable: z.boolean(),
  citabilityReason: z.string(),
  verified: z.boolean(),
});

const BodySchema = z.object({
  narrative: z.string().min(10, "narrative must be at least 10 characters"),
  elements: LegalElementsSchema,
  match: PrecedentMatchSchema,
  locale: z.enum(["ko", "en"]),
  model: z.string().optional(),
});

const WhySchema = z.object({
  why: z.object({
    reasoning: z
      .string()
      .describe(
        "One paragraph explaining the legal rationale for the match — 쟁점 alignment + 법률관계 alignment. User locale; preserve Korean legal terms."
      ),
    pairedMappings: z
      .array(
        z.object({
          userFact: z
            .string()
            .describe("A load-bearing fact from the user's case (user locale)."),
          precedentFact: z
            .string()
            .describe("The corresponding fact from the precedent (user locale)."),
          sameBecause: z
            .string()
            .describe(
              "Short reason these facts function the same legally (user locale, preserve Korean legal terms)."
            ),
        })
      )
      .min(3)
      .max(5)
      .describe(
        "3–5 explicit one-to-one mappings between user facts and precedent facts, with a reason each pair is legally equivalent."
      ),
    citationStrategy: z
      .string()
      .describe(
        "Exactly 2 sentences: how to use this case in the attorney's brief. User locale."
      ),
    distinguishingRisk: z
      .string()
      .describe(
        "Exactly 2 sentences: how opposing counsel might distinguish this precedent based on match.distinguishingFacts. User locale."
      ),
  }),
});

const SYSTEM_PROMPT = `You are a senior Korean litigation paralegal preparing the "왜?" (Why) tab of a case dashboard. The attorney needs to see — explicitly — why a retrieved 판례 matches their case, AND how opposing counsel will try to distinguish it.

OUTPUT LANGUAGE
- All output in the user's locale (ko or en).
- ALWAYS preserve Korean legal terms inline even when locale=en: 쟁점, 법률관계, 청구원인, 당사자 지위, 손해, 원고/피고 등.
- Statute citations and case numbers stay in Korean form.

CONTENT RULES
- reasoning: ONE paragraph. Explicitly tie the user's 쟁점 to the precedent's 쟁점, and the user's 법률관계 to the precedent's 법률관계. No hedging.
- pairedMappings: 3–5 triples. Each triple maps ONE concrete user fact to ONE concrete precedent fact, with a short legal reason (sameBecause) that names the legal concept making them equivalent (e.g. "둘 다 임차인의 부속물매수청구권 행사 요건을 충족", "둘 다 사용자 책임의 사무집행 관련성 요건을 충족"). Pull facts from match.matchingFacts and the precedent's facts/holding. Do NOT fabricate facts.
- citationStrategy: EXACTLY 2 sentences. Concrete instruction on how to deploy this case in a brief (which holding to cite, which paragraph to draw the rule from, where in the brief to place it).
- distinguishingRisk: EXACTLY 2 sentences. Warn how opposing counsel will leverage match.distinguishingFacts to argue the precedent is not controlling — and the one-line response the attorney should prepare.

DO NOT
- Repeat the same paired mapping twice.
- Invent facts not present in either the user's narrative/elements or the precedent.
- Hedge ("could possibly" / "might"). The attorney needs commitments.`;

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

  const { narrative, elements, match, locale } = parsed.data;

  const userPrompt = [
    `User locale: ${locale === "ko" ? "Korean (한국어)" : "English"}`,
    "",
    "User's narrative:",
    "---",
    narrative.trim(),
    "---",
    "",
    "User's extracted legal elements (Korean):",
    "```json",
    JSON.stringify(elements, null, 2),
    "```",
    "",
    "Retrieved precedent + match metadata (authoritative — do not invent facts beyond this):",
    "```json",
    JSON.stringify(match, null, 2),
    "```",
    "",
    "Produce the 4-field 'why' analysis. Use ONLY facts present above. Follow length rules exactly (paragraph counts, sentence counts, 3–5 mappings).",
  ].join("\n");

  try {
    const model = parsed.data.model
      ? (resolveModelForUse(parsed.data.model) ?? safeModelId(parsed.data.model))
      : EXTRACTION_MODEL;
    const result = await generateObject({
      model,
      schema: WhySchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      abortSignal: AbortSignal.timeout(800_000),
      maxOutputTokens: 2048,
    });
    return NextResponse.json(result.object);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Why analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
