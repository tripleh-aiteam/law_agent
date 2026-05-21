import { loadCorpus } from "./retrieval";

/**
 * Process-lifetime cache for verification results. Keyed by caseNumber.
 * Note: this Map persists across requests within the same Node worker but
 * resets on cold starts — that's acceptable for a best-effort verifier.
 */
const verificationCache = new Map<string, boolean>();

/** Lazy-loaded set of caseNumbers known to be in our local corpus. */
let corpusCaseNumbersPromise: Promise<Set<string>> | null = null;
async function getCorpusCaseNumbers(): Promise<Set<string>> {
  if (!corpusCaseNumbersPromise) {
    corpusCaseNumbersPromise = loadCorpus().then((c) => new Set(c.map((p) => p.caseNumber)));
  }
  return corpusCaseNumbersPromise;
}

const VERIFY_TIMEOUT_MS = 8_000;

/**
 * Verifies that a 판례 caseNumber is real and retrievable.
 *
 * Behavior (corpus-first, since corpus came from law.go.kr):
 *  1. If the caseNumber is in our local 대법원 corpus → verified=true
 *     immediately. The 1,608-case corpus was ingested via the official
 *     law.go.kr Open API, so presence is sufficient proof. This is the
 *     overwhelmingly common case at query time — semantic search only
 *     returns matches that ARE in the corpus.
 *  2. If NOT in corpus AND LAW_GO_KR_API_KEY is set → try the live
 *     law.go.kr Open API. Often fails from Vercel's foreign edge IPs
 *     because the Korean Ministry of Justice firewall blocks them;
 *     that returns false (fail-closed).
 *  3. If NOT in corpus AND no API key → fail-closed.
 *
 * Previous behavior tried the live API FIRST whenever LAW_GO_KR_API_KEY
 * was set, which on Vercel meant every match got marked "unverified"
 * even when the case was sitting right there in our verified corpus.
 */
export async function verifyCitation(caseNumber: string): Promise<boolean> {
  const key = caseNumber.trim();
  if (!key) return false;
  const cached = verificationCache.get(key);
  if (cached !== undefined) return cached;

  // ── Step 1: corpus-presence check (cheap + reliable). ──────────────
  const corpusSet = await getCorpusCaseNumbers();
  if (corpusSet.has(key)) {
    verificationCache.set(key, true);
    return true;
  }

  const apiKey = process.env.LAW_GO_KR_API_KEY?.trim();
  if (!apiKey) {
    verificationCache.set(key, false);
    return false;
  }

  // ── Step 2: case is NOT in our snapshot — try law.go.kr live. ──────
  // Two routing options:
  //   (a) LAWGO_PROXY_URL + LAWGO_PROXY_TOKEN set → route through the
  //       user's Korean cloud proxy (AWS Seoul VM). Required for
  //       Vercel deployments because the Korean Ministry of Justice
  //       firewall blocks foreign IPs.
  //   (b) Neither proxy var set → call law.go.kr direct. Works only
  //       from a Korean IP (local dev in Korea, or a Vercel Static IP
  //       in icn1 region registered with open.law.go.kr).
  //
  // law.go.kr is HTTP-only (their HTTPS handshake is broken on many
  // clients) and the Open API uses `OC=<key>` as a public-ish
  // IP-bound credential, so HTTP is acceptable.
  //
  // Parameter notes:
  //   - `query=<text>`  : the actual search text (case number, title, etc.)
  //   - `search=<int>`  : search-mode code (1=title, 2=case number) — NOT the
  //                       search text! Sending the case number under `search`
  //                       returns law.go.kr's generic error page.
  const proxyUrl = process.env.LAWGO_PROXY_URL?.trim();
  const proxyToken = process.env.LAWGO_PROXY_TOKEN?.trim();

  const upstreamPath =
    `lawSearch.do?` +
    `OC=${encodeURIComponent(apiKey)}` +
    `&target=prec&type=JSON&query=${encodeURIComponent(key)}`;

  const url = proxyUrl
    ? // Hit the Korean-IP proxy. The proxy strips /lawgo/ and prepends
      // /DRF on its side, so we just append the path.
      `${proxyUrl.replace(/\/$/, "")}/lawgo/${upstreamPath}`
    : `http://www.law.go.kr/DRF/${upstreamPath}`;

  const headers: Record<string, string> = {};
  if (proxyUrl && proxyToken) {
    headers["Authorization"] = `Bearer ${proxyToken}`;
  }

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      verificationCache.set(key, false);
      return false;
    }
    // Some law.go.kr endpoints return JSON; others occasionally return XML
    // even when type=JSON is requested. Try JSON first, fall back to a
    // case-number substring match against the raw body.
    let found = false;
    const text = await resp.text();
    try {
      const data: unknown = JSON.parse(text);
      // Heuristic: search the JSON tree for the caseNumber string.
      const stringified = JSON.stringify(data);
      found = stringified.includes(key);
    } catch {
      found = text.includes(key);
    }
    verificationCache.set(key, found);
    return found;
  } catch {
    verificationCache.set(key, false);
    return false;
  }
}
