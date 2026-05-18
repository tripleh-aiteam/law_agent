import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyCitation } from "@/lib/verifier";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  caseNumber: z.string().min(1),
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

  try {
    const verified = await verifyCitation(parsed.data.caseNumber);
    return NextResponse.json({ verified });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
