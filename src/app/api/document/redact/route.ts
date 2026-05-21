import { NextResponse } from "next/server";
import { z } from "zod";
import { redactPii } from "@/lib/pii-redact";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  text: z.string().min(1, "text is required"),
  /** When true, also runs the LLM layer to catch names + addresses
   * (slower + uses a Claude API call). Default false = regex-only. */
  thorough: z.boolean().optional().default(false),
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
      {
        error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await redactPii(parsed.data.text, {
      thorough: parsed.data.thorough,
      signal: req.signal,
    });
    return NextResponse.json({
      redactedText: result.redactedText,
      hitCount: result.hits.length,
      // Summary of what was redacted, grouped by category.
      hitsByCategory: groupBy(result.hits, (h) => h.category),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Redact failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function groupBy<T, K extends string>(
  items: T[],
  keyFn: (item: T) => K,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
