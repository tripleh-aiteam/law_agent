import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewContract } from "@/lib/contract-redline";

export const runtime = "nodejs";
export const maxDuration = 180;

const BodySchema = z.object({
  text: z.string().min(50, "Contract text must be at least 50 characters."),
  locale: z.enum(["ko", "en"]),
  /** Optional model override (gateway-form id). Defaults to extractor model. */
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
      {
        error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await reviewContract(
      parsed.data.text,
      parsed.data.locale,
      parsed.data.model,
      req.signal,
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Redline failed";
    console.error("[api/contract/redline] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
