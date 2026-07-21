import { NextResponse } from "next/server";
import { countPrecedents } from "@/lib/db";

export const runtime = "nodejs";
// Never cache — this is a liveness/readiness probe.
export const dynamic = "force-dynamic";

/**
 * Health endpoint for the container HEALTHCHECK and for operators.
 *
 * Reports three things an operator actually needs after a deploy:
 *   - is the process up
 *   - can it reach Postgres
 *   - has the corpus migration been run (embedded > 0)
 *
 * Returns 503 when the database is unreachable so Docker marks the
 * container unhealthy. A migrated-but-empty corpus is reported as
 * degraded rather than unhealthy: the app still answers legal questions,
 * it just can't cite precedents yet.
 */
export async function GET(): Promise<Response> {
  const providers = {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    google: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    manus: Boolean(process.env.MANUS_API_KEY),
  };

  try {
    const { total, embedded } = await countPrecedents();
    return NextResponse.json({
      status: embedded > 0 ? "ok" : "degraded",
      database: "connected",
      corpus: { total, embedded },
      corpusReady: embedded > 0,
      hint:
        embedded > 0
          ? undefined
          : "Corpus not migrated. Run: npm run migrate:corpus",
      providers,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        status: "unhealthy",
        database: "unreachable",
        error: err instanceof Error ? err.message : String(err),
        providers,
      },
      { status: 503 },
    );
  }
}
