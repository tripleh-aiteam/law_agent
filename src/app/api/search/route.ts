import { NextResponse } from "next/server";
import { z } from "zod";
import { LegalElementsSchema } from "@/lib/types";
import {
  loadCorpus,
  loadCorpusEmbeddings,
  embedQuery,
  buildQueryText,
  semanticSearch,
} from "@/lib/retrieval";
import { llmReranker } from "@/lib/rerank";
import { verifyCitation } from "@/lib/verifier";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  narrative: z.string().min(10),
  elements: LegalElementsSchema,
  locale: z.enum(["ko", "en"]),
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

  const { narrative, elements, locale } = parsed.data;

  try {
    const [corpus, embeddings] = await Promise.all([loadCorpus(), loadCorpusEmbeddings()]);
    if (corpus.length === 0 || embeddings.size === 0) {
      // Corpus or embeddings not yet built — return empty matches rather than 500.
      return NextResponse.json({ matches: [] });
    }

    const queryText = buildQueryText(elements, narrative);
    const queryEmbedding = await embedQuery(queryText);
    const top10 = semanticSearch(queryEmbedding, corpus, embeddings, 10);
    if (top10.length === 0) {
      return NextResponse.json({ matches: [] });
    }

    const reranked = await llmReranker(narrative, elements, top10, locale);

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
