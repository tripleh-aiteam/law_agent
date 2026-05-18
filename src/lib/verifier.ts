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
 * Behavior:
 * - If LAW_GO_KR_API_KEY is set: queries law.go.kr's open API. Parses
 *   defensively; any HTTP or shape error → false (fail-closed for verification).
 * - If no API key: returns true iff the caseNumber is present in the local
 *   corpus. This is "fail-open for corpus presence" — we trust our curated
 *   corpus enough to treat in-corpus cases as verified — and fail-closed for
 *   anything else.
 */
export async function verifyCitation(caseNumber: string): Promise<boolean> {
  const key = caseNumber.trim();
  if (!key) return false;
  const cached = verificationCache.get(key);
  if (cached !== undefined) return cached;

  const apiKey = process.env.LAW_GO_KR_API_KEY?.trim();

  if (!apiKey) {
    const corpusSet = await getCorpusCaseNumbers();
    const present = corpusSet.has(key);
    verificationCache.set(key, present);
    return present;
  }

  // law.go.kr open API pattern. We use `prec` (판례) target with JSON output.
  const url =
    `https://www.law.go.kr/DRF/lawSearch.do?` +
    `OC=${encodeURIComponent(apiKey)}` +
    `&target=prec&type=JSON&search=${encodeURIComponent(key)}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      // Open API doesn't need credentials; avoid sending any.
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
