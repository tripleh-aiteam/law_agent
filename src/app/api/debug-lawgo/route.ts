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

  // Diagnostic endpoint — only enable in dev or when explicitly opted in via
  // an env flag. In production, we never expose law.go.kr URLs (the OC param
  // is the API key).
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_DEBUG_ENDPOINTS !== "1"
  ) {
    return NextResponse.json(
      { error: "Debug endpoint disabled in production" },
      { status: 404 },
    );
  }

  const proto = url.searchParams.get("proto") ?? "https";
  const lawgoUrl =
    `${proto}://www.law.go.kr/DRF/lawSearch.do?` +
    `OC=${encodeURIComponent(apiKey)}` +
    `&target=prec&type=JSON&query=${encodeURIComponent(cn)}`;
  // Redacted version that's safe to echo to the caller.
  const lawgoUrlRedacted = lawgoUrl.replace(
    /OC=[^&]+/,
    `OC=${apiKey.slice(0, 4)}***`,
  );

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
      url: lawgoUrlRedacted,
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
      url: lawgoUrlRedacted,
      caseNumber: cn,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
