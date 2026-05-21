import { NextResponse } from "next/server";
import { z } from "zod";
import { lookupBusiness } from "@/lib/nts-lookup";

export const runtime = "nodejs";
export const maxDuration = 30;

const BodySchema = z.object({
  bizNumber: z
    .string()
    .min(10, "bizNumber must be 10 digits (with or without hyphens)"),
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
    const result = await lookupBusiness(parsed.data.bizNumber, req.signal);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lookup failed";
    // Surface the "no API key configured" case as a clean 400 so the
    // frontend can show a setup-instructions message rather than a
    // generic 500.
    const isSetupIssue = /NTS_BUSINESS_API_KEY is not set/.test(message);
    return NextResponse.json(
      { error: message },
      { status: isSetupIssue ? 400 : 500 },
    );
  }
}
