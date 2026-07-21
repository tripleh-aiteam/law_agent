import { NextResponse } from "next/server";
import { z } from "zod";
import { LegalElementsSchema } from "@/lib/types";
import {
  embedQuery,
  buildQueryText,
  searchPrecedents,
  isCorpusReady,
} from "@/lib/retrieval";
import { llmReranker } from "@/lib/rerank";
import { verifyCitation } from "@/lib/verifier";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  narrative: z.string().min(10),
  elements: LegalElementsSchema,
  locale: z.enum(["ko", "en"]),
  /** Optional gateway model ID — passed through to the LLM rerank step. */
  model: z.string().optional(),
});

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
      { error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
      { status: 400 }
    );
  }

  const { narrative, elements, locale, model } = parsed.data;

  try {
    // Corpus not migrated yet (fresh database) — return empty matches rather
    // than a 500, so the extraction/analysis still renders for the user.
    if (!(await isCorpusReady())) {
      return NextResponse.json({ matches: [] });
    }

    const queryText = buildQueryText(elements, narrative);
    const queryEmbedding = await embedQuery(queryText);
    const top10 = await searchPrecedents(queryEmbedding, 10);
    if (top10.length === 0) {
      return NextResponse.json({ matches: [] });
    }

    const reranked = await llmReranker(narrative, elements, top10, locale, model);

    // Verify citations in parallel. Failures degrade to verified=false.
    const verified = await Promise.all(
      reranked.map(async (m) => {
        try {
          const ok = await verifyCitation(m.precedent.caseNumber);
          return { ...m, verified: ok };
        } catch {
          return { ...m, verified: false };
        }
      })
    );

    return NextResponse.json({ matches: verified });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
