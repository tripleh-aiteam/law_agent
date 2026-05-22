import { NextResponse } from "next/server";
import { z } from "zod";
import { draftCivilDocument } from "@/lib/court-draft";

export const runtime = "nodejs";
export const maxDuration = 800;

const PartyInputSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다 / name required"),
  idLabel: z.string().min(1),
  idNumber: z.string().min(1),
  address: z.string().min(1, "주소는 필수입니다 / address required"),
  contact: z.string().optional(),
  representative: z.string().optional(),
});

const BodySchema = z.object({
  documentType: z.enum(["complaint", "answer"]),
  claimCategory: z
    .string()
    .min(1, "청구 유형은 필수입니다 / claim category required"),
  plaintiff: PartyInputSchema,
  defendant: PartyInputSchema,
  claimAmountKrw: z.number().nonnegative().optional(),
  caseFacts: z
    .string()
    .min(50, "사실관계는 최소 50자 이상 작성해주세요 / case facts must be at least 50 characters."),
  legalBasis: z.string().optional(),
  caseNumber: z.string().optional(),
  preferredCourt: z.string().optional(),
  citedPrecedents: z.string().optional(),
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
        error: `Invalid request: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const draft = await draftCivilDocument(
      parsed.data,
      parsed.data.model,
      req.signal,
    );
    return NextResponse.json({ draft });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Drafting failed";
    console.error("[api/draft/civil] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
