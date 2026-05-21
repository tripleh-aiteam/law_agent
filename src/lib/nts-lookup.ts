/**
 * 사업자등록번호 (Korean business registration number) lookup via the
 * National Tax Service (국세청) open API at data.go.kr.
 *
 * Endpoint:  https://api.odcloud.kr/api/nts-businessman/v1/status
 * Provider:  Korean Government Public Data Portal (data.go.kr)
 * Cost:      FREE — requires a service key from data.go.kr (free signup)
 * Quota:     10,000 calls/day default, can be increased on request
 *
 * To activate this feature the user must:
 *   1. Sign up at https://data.go.kr/ (Korean ID required for some services
 *      but the NTS API is publicly available)
 *   2. Apply for "국세청_사업자등록정보 진위확인 및 상태조회 서비스"
 *   3. Wait ~1 day for approval
 *   4. Copy the encoded service key → add to .env.local as
 *      NTS_BUSINESS_API_KEY=...
 *
 * Without the key, lookupBusiness() throws a clean error pointing the
 * user at the signup page.
 */

const NTS_STATUS_URL =
  "https://api.odcloud.kr/api/nts-businessman/v1/status";

export type BusinessStatusCode = "01" | "02" | "03" | string;

/**
 * Decoded status field from the NTS response.
 *   01 = 계속사업자 (active)
 *   02 = 휴업자     (suspended)
 *   03 = 폐업자     (closed)
 */
export const BUSINESS_STATUS_LABEL: Record<string, { ko: string; en: string }> =
  {
    "01": { ko: "계속사업자 (영업 중)", en: "Active" },
    "02": { ko: "휴업자", en: "Suspended" },
    "03": { ko: "폐업자", en: "Closed" },
  };

/** Decoded 과세유형 (taxation type) from the NTS response. */
export const TAX_TYPE_LABEL: Record<string, { ko: string; en: string }> = {
  "01": { ko: "부가가치세 일반과세자", en: "VAT general taxpayer" },
  "02": { ko: "부가가치세 간이과세자", en: "VAT simplified taxpayer" },
  "03": { ko: "부가가치세 면세사업자", en: "VAT-exempt business" },
  "04": { ko: "비영리법인 또는 국가/지방자치단체", en: "Non-profit / govt" },
  "05": { ko: "고유번호가 부여된 단체", en: "Registered body" },
  "06": { ko: "부가가치세 일반과세자(간이과세 일부)", en: "VAT mixed" },
  "07": { ko: "부가가치세 간이과세자(세금계산서발급사업자)", en: "VAT simplified (invoiceable)" },
};

export interface BusinessLookupResult {
  /** Original input (10 digits, no hyphens). */
  bizNumber: string;
  /** Whether the API recognized this number at all. */
  found: boolean;
  /** Active / Suspended / Closed — see BUSINESS_STATUS_LABEL. */
  status?: { code: string; ko: string; en: string };
  /** 과세유형. */
  taxType?: { code: string; ko: string; en: string };
  /** Date the business closed (YYYYMMDD), if closed. */
  closedAt?: string;
  /** Raw upstream payload for transparency / debugging. */
  raw?: unknown;
}

interface NtsStatusItem {
  b_no?: string;
  b_stt_cd?: string;
  b_stt?: string;
  tax_type_cd?: string;
  tax_type?: string;
  end_dt?: string;
  utcc_yn?: string;
  invoice_apply_dt?: string;
}

/** Normalize a 사업자등록번호: strip everything that isn't a digit. */
export function normalizeBizNumber(input: string): string {
  return input.replace(/\D+/g, "");
}

/** Light syntactic check (not the full checksum). */
export function isValidBizNumberFormat(input: string): boolean {
  const digits = normalizeBizNumber(input);
  return /^\d{10}$/.test(digits);
}

/**
 * Calls the NTS Open API to look up the status of one or more business
 * registration numbers. Throws when NTS_BUSINESS_API_KEY is missing or
 * when the upstream returns a non-OK status; returns a structured
 * result otherwise.
 */
export async function lookupBusiness(
  bizNumberInput: string,
  signal?: AbortSignal,
): Promise<BusinessLookupResult> {
  const apiKey = process.env.NTS_BUSINESS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "NTS_BUSINESS_API_KEY is not set. To enable 사업자등록번호 lookup, " +
        "register at https://data.go.kr/, apply for the NTS 사업자등록정보 " +
        "진위확인 및 상태조회 API, then add NTS_BUSINESS_API_KEY=<encoded key> " +
        "to .env.local and the Vercel project env vars.",
    );
  }

  const bizNumber = normalizeBizNumber(bizNumberInput);
  if (!isValidBizNumberFormat(bizNumber)) {
    throw new Error(
      "Invalid 사업자등록번호 format. Expected 10 digits (e.g. 1234567890 or 123-45-67890).",
    );
  }

  const url = `${NTS_STATUS_URL}?serviceKey=${encodeURIComponent(apiKey)}&returnType=JSON`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ b_no: [bizNumber] }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `NTS API error: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as { data?: NtsStatusItem[]; match_cnt?: number };
  const item = json.data?.[0];

  if (!item || !item.b_no) {
    return { bizNumber, found: false, raw: json };
  }

  // Status — NTS returns b_stt_cd "01" / "02" / "03" or sometimes the
  // human-readable string in b_stt. Prefer the code; fall back to text.
  const statusCode = item.b_stt_cd ?? "";
  const statusLabel = BUSINESS_STATUS_LABEL[statusCode] ?? {
    ko: item.b_stt ?? "알 수 없음",
    en: item.b_stt ?? "Unknown",
  };

  const taxCode = item.tax_type_cd ?? "";
  const taxLabel = TAX_TYPE_LABEL[taxCode] ?? {
    ko: item.tax_type ?? "확인 불가",
    en: item.tax_type ?? "Unknown",
  };

  return {
    bizNumber,
    found: true,
    status: { code: statusCode, ...statusLabel },
    taxType: { code: taxCode, ...taxLabel },
    closedAt: item.end_dt,
    raw: json,
  };
}
