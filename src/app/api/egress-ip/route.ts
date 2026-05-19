/**
 * One-time helper: tells you what IP this function's outbound requests
 * appear to come from. Useful when registering Vercel's egress IP at
 * Korean government APIs (e.g. law.go.kr) that require IP allowlisting.
 *
 * GET /api/egress-ip → { egressIP: "76.76.21.xxx" }
 *
 * Safe to leave in the codebase — non-sensitive, no auth needed.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const r = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(10_000),
    });
    const ip = (await r.text()).trim();
    return NextResponse.json({
      egressIP: ip,
      note: "Register this IP at open.law.go.kr (마이페이지 → OPEN API 신청·관리 → IP 등록) to unlock detail-level law.go.kr API access from this Vercel deployment.",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
