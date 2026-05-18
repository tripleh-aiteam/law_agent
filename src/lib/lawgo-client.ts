/**
 * Typed client for the Korean Supreme Court (law.go.kr) Open API.
 *
 * Operates in two modes:
 *   1. **API mode** — when `process.env.LAW_GO_KR_API_KEY` is set, talks to the
 *      official JSON endpoints documented at
 *      https://open.law.go.kr/LSO/openApi/guideResult.do?htmlName=precListGuide
 *   2. **Scrape mode** (fallback) — when no key is present, scrapes the public
 *      search page at https://glaw.scourt.go.kr (slower, limited to ~200 cases).
 *
 * Korean government endpoints are sensitive to request volume. We hard-cap:
 *   - 5 req/sec in API mode
 *   - 1 req/sec in scrape mode
 * and retry transient 5xx errors with exponential backoff.
 */
import * as cheerio from "cheerio";

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface LawGoListItem {
  /** 판례일련번호 — internal numeric ID, used to fetch the detail record. */
  caseId: string;
  /** 사건번호 — canonical Korean case-number, e.g. "2017다220744". */
  caseNumber: string;
  /** 사건명 — case title. */
  caseTitle: string;
  /** 법원명 — court name, normalized (e.g. "대법원"). */
  court: string;
  /** 선고일 — ISO date YYYY-MM-DD. */
  decisionDate: string;
  /** 사건종류명 — coarse case nature (민사/형사/행정/특별). */
  caseNature: string;
}

export interface LawGoDetail {
  caseId: string;
  caseNumber: string;
  caseTitle: string;
  court: string;
  decisionDate: string;
  /** 판시사항 — holding(s). */
  holding: string;
  /** 판결요지 — summary. */
  summary: string;
  /** 참조조문 — referenced statutes (parsed list). */
  referencedStatutes: string[];
  /** 참조판례 — referenced precedents (case-number strings). */
  referencedPrecedents: string[];
  /** 판례내용 — full opinion text. */
  fullText: string;
  /** 사건종류명 — coarse case nature. */
  caseNature: string;
  /** 판결유형 — judgment type (확정, 환송 등). May be empty in scrape mode. */
  judgmentType: string;
  /** Canonical law.go.kr detail page URL. */
  sourceUrl: string;
}

export interface ListOpts {
  /** Inclusive start date (YYYY-MM-DD). */
  fromDate?: string;
  /** Inclusive end date (YYYY-MM-DD). */
  toDate?: string;
  /** 1-indexed page. */
  page?: number;
  /** Page size; max 100 in API mode, ~10 per scrape page. */
  display?: number;
}

export interface ListResult {
  total: number;
  items: LawGoListItem[];
}

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────

const USER_AGENT =
  "Law-Agent/0.1 (https://github.com/example/law-agent; korean-legal-research)";

const API_BASE = "https://www.law.go.kr/DRF";
const SCRAPE_BASE = "https://glaw.scourt.go.kr/wsjo/panre/sjo060.do";

const API_RPS = 5;
const SCRAPE_RPS = 1;

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;

// ────────────────────────────────────────────────────────────────────────────
// Rate limiter — simple monotonic-time gate, one slot per second per mode.
// ────────────────────────────────────────────────────────────────────────────

class RateLimiter {
  private windowStart = 0;
  private callsInWindow = 0;

  constructor(private readonly rps: number) {}

  async wait(): Promise<void> {
    while (true) {
      const now = Date.now();
      if (now - this.windowStart >= 1000) {
        this.windowStart = now;
        this.callsInWindow = 1;
        return;
      }
      if (this.callsInWindow < this.rps) {
        this.callsInWindow += 1;
        return;
      }
      const sleepMs = 1000 - (now - this.windowStart);
      await sleep(Math.max(sleepMs, 10));
    }
  }
}

const apiLimiter = new RateLimiter(API_RPS);
const scrapeLimiter = new RateLimiter(SCRAPE_RPS);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helper — retries 5xx with backoff, applies UA + timeout.
// ────────────────────────────────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  mode: "api" | "scrape"
): Promise<{ status: number; body: string }> {
  const limiter = mode === "api" ? apiLimiter : scrapeLimiter;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.wait();
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: mode === "api" ? "application/json" : "text/html,*/*",
          "Accept-Language": "ko,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const backoff = 500 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }

      const body = await res.text();
      return { status: res.status, body };
    } catch (err: unknown) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const backoff = 500 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
    }
  }
  throw new Error(`fetchWithRetry: gave up after ${MAX_RETRIES + 1} attempts for ${url}: ${String(lastErr)}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Parse Korean date "YYYY.MM.DD." or "YYYY-MM-DD" → ISO "YYYY-MM-DD". */
export function normalizeKoreanDate(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  // Already ISO-ish?
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // "YYYY.MM.DD." or "YYYY.MM.DD" or "YYYYMMDD"
  const dotMatch = trimmed.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?/);
  if (dotMatch) {
    const y = dotMatch[1];
    const m = dotMatch[2].padStart(2, "0");
    const d = dotMatch[3].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const compactMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }
  return trimmed;
}

/** YYYY-MM-DD → YYYYMMDD for the law.go.kr `prncYd` range param. */
function isoToCompact(iso: string): string {
  return iso.replace(/-/g, "");
}

/** Normalize court name. */
function normalizeCourt(input: string): string {
  const v = (input ?? "").trim();
  if (!v) return "";
  if (v.includes("대법원")) return "대법원";
  return v;
}

/** Split a "참조조문" blob into individual statute citations. */
function parseStatuteList(blob: string | null | undefined): string[] {
  if (!blob) return [];
  // Strip HTML tags law.go.kr sometimes embeds.
  const text = blob.replace(/<[^>]+>/g, " ");
  return Array.from(
    new Set(
      text
        .split(/[\/,;\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 200)
    )
  );
}

/** Split a "참조판례" blob into case-number strings. */
function parsePrecedentList(blob: string | null | undefined): string[] {
  if (!blob) return [];
  const text = blob.replace(/<[^>]+>/g, " ");
  return Array.from(
    new Set(
      text
        .split(/[\/,;\n]/)
        .map((s) => s.trim())
        .filter((s) => /\d{2,4}[가-힣]{1,3}\d+/.test(s))
    )
  );
}

function getEnvKey(): string | null {
  const k = process.env.LAW_GO_KR_API_KEY;
  return k && k.trim().length > 0 ? k.trim() : null;
}

export function getMode(): "api" | "scrape" {
  return getEnvKey() ? "api" : "scrape";
}

// ────────────────────────────────────────────────────────────────────────────
// API-mode implementations
// ────────────────────────────────────────────────────────────────────────────

interface RawListResponse {
  PrecSearch?: {
    totalCnt?: string | number;
    page?: string | number;
    prec?: RawListItem[] | RawListItem;
  };
}

interface RawListItem {
  판례일련번호?: string | number;
  사건번호?: string;
  사건명?: string;
  법원명?: string;
  선고일자?: string;
  사건종류명?: string;
  판결유형?: string;
  선고?: string;
  데이터구분?: string;
  판례상세링크?: string;
}

interface RawDetailResponse {
  PrecService?: {
    판례정보일련번호?: string | number;
    사건번호?: string;
    사건명?: string;
    법원명?: string;
    선고일자?: string;
    판시사항?: string;
    판결요지?: string;
    참조조문?: string;
    참조판례?: string;
    판례내용?: string;
    사건종류명?: string;
    판결유형?: string;
  };
}

async function listApi(opts: ListOpts): Promise<ListResult> {
  const key = getEnvKey();
  if (!key) throw new Error("listApi called without LAW_GO_KR_API_KEY");

  const page = opts.page ?? 1;
  const display = Math.min(opts.display ?? 100, 100);
  const params = new URLSearchParams({
    OC: key,
    target: "prec",
    type: "JSON",
    display: String(display),
    page: String(page),
    search: "2",
    org: "400201", // 대법원
  });
  if (opts.fromDate && opts.toDate) {
    params.set("prncYd", `${isoToCompact(opts.fromDate)}~${isoToCompact(opts.toDate)}`);
  }

  const url = `${API_BASE}/lawSearch.do?${params.toString()}`;
  const { status, body } = await fetchWithRetry(url, "api");
  if (status !== 200) {
    throw new Error(`law.go.kr lawSearch returned ${status}`);
  }
  let json: RawListResponse;
  try {
    json = JSON.parse(body) as RawListResponse;
  } catch {
    throw new Error(`law.go.kr lawSearch returned non-JSON (status ${status}). First 200 chars: ${body.slice(0, 200)}`);
  }
  const root = json.PrecSearch;
  if (!root) {
    return { total: 0, items: [] };
  }
  const total = Number(root.totalCnt ?? 0) || 0;
  const rawItems = Array.isArray(root.prec) ? root.prec : root.prec ? [root.prec] : [];
  const items: LawGoListItem[] = [];
  for (const r of rawItems) {
    try {
      const caseId = String(r.판례일련번호 ?? "").trim();
      const caseNumber = (r.사건번호 ?? "").trim();
      if (!caseId || !caseNumber) continue;
      items.push({
        caseId,
        caseNumber,
        caseTitle: (r.사건명 ?? "").trim(),
        court: normalizeCourt(r.법원명 ?? ""),
        decisionDate: normalizeKoreanDate(r.선고일자 ?? ""),
        caseNature: (r.사건종류명 ?? "").trim(),
      });
    } catch (err) {
      console.warn(`[lawgo-client] skip list item: ${(err as Error).message}`);
    }
  }
  return { total, items };
}

async function detailApi(caseId: string): Promise<LawGoDetail> {
  const key = getEnvKey();
  if (!key) throw new Error("detailApi called without LAW_GO_KR_API_KEY");

  const params = new URLSearchParams({
    OC: key,
    target: "prec",
    type: "JSON",
    ID: caseId,
  });
  const url = `${API_BASE}/lawService.do?${params.toString()}`;
  const { status, body } = await fetchWithRetry(url, "api");
  if (status !== 200) {
    throw new Error(`law.go.kr lawService returned ${status} for ${caseId}`);
  }
  let json: RawDetailResponse;
  try {
    json = JSON.parse(body) as RawDetailResponse;
  } catch {
    throw new Error(`law.go.kr lawService returned non-JSON for ${caseId}`);
  }
  const d = json.PrecService;
  if (!d) {
    throw new Error(`law.go.kr lawService returned empty body for ${caseId}`);
  }
  const caseNumber = (d.사건번호 ?? "").trim();
  if (!caseNumber) {
    throw new Error(`law.go.kr lawService missing 사건번호 for ${caseId}`);
  }
  return {
    caseId,
    caseNumber,
    caseTitle: (d.사건명 ?? "").trim(),
    court: normalizeCourt(d.법원명 ?? ""),
    decisionDate: normalizeKoreanDate(d.선고일자 ?? ""),
    holding: stripHtml(d.판시사항 ?? ""),
    summary: stripHtml(d.판결요지 ?? ""),
    referencedStatutes: parseStatuteList(d.참조조문),
    referencedPrecedents: parsePrecedentList(d.참조판례),
    fullText: stripHtml(d.판례내용 ?? ""),
    caseNature: (d.사건종류명 ?? "").trim(),
    judgmentType: (d.판결유형 ?? "").trim(),
    sourceUrl: `https://www.law.go.kr/판례/${encodeURIComponent(caseNumber)}`,
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>(\r?\n)?/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function checkApiKeyImpl(): Promise<boolean> {
  const key = getEnvKey();
  if (!key) return false;
  try {
    const res = await listApi({ page: 1, display: 1 });
    return res.items.length > 0 || res.total > 0;
  } catch (err) {
    console.warn(`[lawgo-client] API key probe failed: ${(err as Error).message}`);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Scrape-mode implementations (glaw.scourt.go.kr)
//
// The scrape mode targets the public 판례 search interface. The site uses
// classic server-rendered tables; we read the result-set <table> and follow
// the per-row detail link. Selectors are coded defensively: if the page
// shape shifts we log and skip rather than crash.
// ────────────────────────────────────────────────────────────────────────────

async function listScrape(opts: ListOpts): Promise<ListResult> {
  const page = opts.page ?? 1;
  const display = Math.min(opts.display ?? 20, 20);

  const params = new URLSearchParams({
    saNo: "",
    saNm: "",
    daeBeobWonYn: "Y", // 대법원 only
    pageIndex: String(page),
    listCount: String(display),
  });
  if (opts.fromDate) params.set("seonGoIljaFr", opts.fromDate.replace(/-/g, "."));
  if (opts.toDate) params.set("seonGoIljaTo", opts.toDate.replace(/-/g, "."));

  const url = `${SCRAPE_BASE}?${params.toString()}`;
  const { status, body } = await fetchWithRetry(url, "scrape");
  if (status !== 200) {
    throw new Error(`glaw scrape list returned ${status}`);
  }
  const $ = cheerio.load(body);
  const items: LawGoListItem[] = [];
  // The result table varies; we look for rows containing a 판례 detail link.
  $("a").each((_i, el) => {
    try {
      const href = $(el).attr("href") ?? "";
      const onclick = $(el).attr("onclick") ?? "";
      const idMatch =
        href.match(/seqNo=(\d+)/) ??
        onclick.match(/['"]?(\d{6,})['"]?/) ??
        href.match(/[?&]id=(\d+)/);
      if (!idMatch) return;
      const caseId = idMatch[1];

      const $row = $(el).closest("tr");
      if ($row.length === 0) return;
      const cells = $row.find("td").map((_j, td) => $(td).text().trim()).get();
      if (cells.length < 3) return;

      // Heuristics: find a cell with 사건번호 shape and a cell with a date.
      const caseNumber =
        cells.find((c) => /\d{2,4}\s*[가-힣]{1,3}\s*\d+/.test(c))?.replace(/\s+/g, "") ?? "";
      const dateCell = cells.find((c) => /\d{4}[.\-]\s*\d{1,2}[.\-]\s*\d{1,2}/.test(c)) ?? "";
      const title = $(el).text().trim();
      if (!caseNumber) return;

      items.push({
        caseId,
        caseNumber,
        caseTitle: title,
        court: "대법원",
        decisionDate: normalizeKoreanDate(dateCell),
        caseNature: "",
      });
    } catch (err) {
      console.warn(`[lawgo-client] skip scrape list row: ${(err as Error).message}`);
    }
  });

  // Try to read a total-count text (e.g. "총 12,345건"); fall back to items.length.
  let total = items.length;
  const totalText = $("body").text().match(/총\s*([\d,]+)\s*건/);
  if (totalText) {
    total = Number(totalText[1].replace(/,/g, "")) || total;
  }
  return { total, items: dedupeBy(items, (i) => i.caseId) };
}

async function detailScrape(caseId: string): Promise<LawGoDetail> {
  // glaw.scourt.go.kr exposes per-precedent pages via sjo070.do?seqNo=...
  // If we can't find structured fields we fall back to dumping the whole body.
  const url = `https://glaw.scourt.go.kr/wsjo/panre/sjo070.do?seqNo=${encodeURIComponent(caseId)}`;
  const { status, body } = await fetchWithRetry(url, "scrape");
  if (status !== 200) {
    throw new Error(`glaw scrape detail returned ${status} for ${caseId}`);
  }
  const $ = cheerio.load(body);

  const pickByLabel = (labels: string[]): string => {
    for (const label of labels) {
      const $th = $(`th:contains("${label}"), dt:contains("${label}"), strong:contains("${label}")`).first();
      if ($th.length > 0) {
        const $next = $th.next();
        const text = $next.text().trim();
        if (text) return text;
      }
    }
    return "";
  };

  const caseNumber = pickByLabel(["사건번호"]) || caseId;
  const caseTitle = pickByLabel(["사건명", "사건이름"]);
  const courtRaw = pickByLabel(["법원명", "선고법원"]);
  const decisionDate = normalizeKoreanDate(pickByLabel(["선고일자", "선고일"]));
  const holding = pickByLabel(["판시사항"]);
  const summary = pickByLabel(["판결요지"]);
  const referencedStatutes = parseStatuteList(pickByLabel(["참조조문"]));
  const referencedPrecedents = parsePrecedentList(pickByLabel(["참조판례"]));
  const fullText = pickByLabel(["판례내용", "판결문", "전문"]) || $("body").text().trim();
  const caseNature = pickByLabel(["사건종류", "사건종류명"]);
  const judgmentType = pickByLabel(["판결유형"]);

  return {
    caseId,
    caseNumber,
    caseTitle,
    court: normalizeCourt(courtRaw || "대법원"),
    decisionDate,
    holding,
    summary,
    referencedStatutes,
    referencedPrecedents,
    fullText: fullText.slice(0, 50_000), // cap to keep memory bounded
    caseNature,
    judgmentType,
    sourceUrl: url,
  };
}

function dedupeBy<T, K>(arr: T[], key: (t: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export async function listPrecedents(opts: ListOpts): Promise<ListResult> {
  if (getMode() === "api") return listApi(opts);
  return listScrape(opts);
}

export async function getPrecedentDetail(caseId: string): Promise<LawGoDetail> {
  if (getMode() === "api") return detailApi(caseId);
  return detailScrape(caseId);
}

export async function checkApiKey(): Promise<boolean> {
  return checkApiKeyImpl();
}
