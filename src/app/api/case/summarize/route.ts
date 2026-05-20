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

const SummarySchema = z.object({
  summary: z.object({
    overview: z
      .string()
      .describe("2–3 sentence high-level case overview in the user's locale."),
    keyIssue: z
      .string()
      .describe("One sentence stating the controlling 쟁점 (preserve the Korean term)."),
    parties: z
      .string()
      .describe("One sentence identifying the parties and their roles."),
    claim: z
      .string()
      .describe("One sentence stating the claim / relief being sought."),
    statutes: z
      .array(z.string())
      .describe(
        "Deduplicated list of applicable Korean statute article citations (e.g. '민법 제618조'). Always Korean citations."
      ),
  }),
});

const SYSTEM_PROMPT = `You are a senior Korean litigation paralegal producing a concise 4-section case summary for a Korean attorney's case dashboard.

OUTPUT LANGUAGE
- Write in the user's locale (ko or en), provided in the user prompt.
- ALWAYS preserve canonical Korean legal terms inline even when locale=en: 쟁점, 법률관계, 청구원인, 당사자 지위, 손해, 원고/피고, 계약, 불법행위, 부당이득 등.
- Statute citations are ALWAYS Korean: "민법 제618조", "상법 제382조의3", "근로기준법 제23조". Never translate statute names.

LENGTH RULES (strict)
- overview: 2–3 sentences. Plain, factual, no editorializing.
- keyIssue: exactly ONE sentence stating the controlling 쟁점 as a question the court would answer.
- parties: exactly ONE sentence — who is suing whom, in what capacity (당사자 지위).
- claim: exactly ONE sentence — what relief / 청구원인 is being asserted.
- statutes: deduplicated array of statute citations only. No prose. Article-level when supported by the narrative; otherwise the bare statute.

CONTENT RULES
- Be concrete. No filler like "본 사건은 분쟁에 관한 것이다".
- Do not invent statutes the narrative does not support. If unclear, list only what is clearly supported.
- Do not cite specific case numbers — those come from a separate retrieval step.`;

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
    `User locale: ${locale === "ko" ? "Korean (한국어)" : "English"}`,
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
    "Produce the 5-field summary. Write prose in the user locale; keep Korean legal terms intact; keep statute citations Korean.",
  ].join("\n");

  try {
    const model = parsed.data.model
      ? (resolveModelForUse(parsed.data.model) ?? safeModelId(parsed.data.model))
      : EXTRACTION_MODEL;
    const result = await generateObject({
      model,
      schema: SummarySchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      abortSignal: AbortSignal.timeout(45_000),
      maxOutputTokens: 1024,
    });
    return NextResponse.json(result.object);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Summary generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
