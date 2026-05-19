/**
 * DEBUG endpoint — shows what law.go.kr actually returns from a Vercel
 * function. Useful to diagnose why the verifier might be returning
 * unexpected results.
 *
 * GET /api/debug-lawgo?cn=2024도15728
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const cn = url.searchParams.get("cn") ?? "2024도15728";
  const apiKey = process.env.LAW_GO_KR_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "LAW_GO_KR_API_KEY not set" }, { status: 500 });
  }

  const lawgoUrl =
    `http://www.law.go.kr/DRF/lawSearch.do?` +
    `OC=${encodeURIComponent(apiKey)}` +
    `&target=prec&type=JSON&query=${encodeURIComponent(cn)}`;

  try {
    const t0 = Date.now();
    const resp = await fetch(lawgoUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    const elapsedMs = Date.now() - t0;
    const text = await resp.text();
    const bodyPreview = text.slice(0, 1500);
    const looksJson = text.trimStart().startsWith("{");
    let containsCaseNumber = false;
    try {
      const data: unknown = JSON.parse(text);
      containsCaseNumber = JSON.stringify(data).includes(cn);
    } catch {
      containsCaseNumber = text.includes(cn);
    }
    return NextResponse.json({
      url: lawgoUrl,
      caseNumber: cn,
      apiKeyPrefix: apiKey.slice(0, 4),
      status: resp.status,
      elapsedMs,
      bodyLength: text.length,
      looksJson,
      containsCaseNumber,
      bodyPreview,
    });
  } catch (err: unknown) {
    return NextResponse.json({
      url: lawgoUrl,
      caseNumber: cn,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
