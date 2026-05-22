/**
 * PII redaction for Korean legal documents.
 *
 * Two-layer approach:
 *   1. Regex layer — fast, deterministic, catches structured Korean PII:
 *        • 주민등록번호 (RRN)            : 6-digit + 7-digit pair
 *        • 전화번호 (phone)             : Korean mobile + landline formats
 *        • 사업자등록번호 (biz RRN)     : XXX-XX-XXXXX
 *        • 법인등록번호 (corp RRN)      : XXXXXX-XXXXXXX
 *        • Bank account                : 3-3-6 / 3-6-2 / 4-3-4-3 patterns
 *        • Email
 *        • 외국인등록번호               : 6-digit + 7-digit (same shape as RRN)
 *        • Korean dates / addresses    : (left to LLM layer — too varied)
 *   2. LLM layer (optional, when 'thorough' mode) — sweeps the regex output
 *      for remaining names, addresses, and other contextual PII that
 *      pattern-matching can't catch.
 *
 * Each redacted span is replaced with a stable token like [주민등록번호]
 * (Korean) or [RRN] (English) so the document still reads naturally.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { EXTRACTION_MODEL } from "./ai";

export type PiiCategory =
  | "rrn" // 주민등록번호
  | "foreigner_rrn" // 외국인등록번호 (same shape as RRN but flagged differently for clarity)
  | "biz_rrn" // 사업자등록번호
  | "corp_rrn" // 법인등록번호
  | "passport" // 여권번호 (Korean: M12345678, foreign: 2-3 letters + 7 digits)
  | "phone"
  | "bank_account"
  | "card_number" // 신용카드 번호
  | "email"
  | "document_id" // 등기번호, 발행번호, 발급확인번호, license plates, etc.
  | "verification_code" // AAOU-GNQY-3886 type codes
  | "url" // personal blog URLs etc.
  | "ip_address"
  | "name" // detected by LLM layer
  | "address" // detected by LLM layer
  | "other"; // LLM-detected misc

export interface PiiHit {
  category: PiiCategory;
  /** The exact substring removed. */
  original: string;
  /** The replacement token written into the redacted output. */
  replacement: string;
  /** Byte offset of `original` in the ORIGINAL input string. */
  index: number;
}

export interface RedactResult {
  redactedText: string;
  hits: PiiHit[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Regex layer                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const TOKEN: Record<PiiCategory, string> = {
  rrn: "[주민등록번호]",
  foreigner_rrn: "[외국인등록번호]",
  biz_rrn: "[사업자등록번호]",
  corp_rrn: "[법인등록번호]",
  passport: "[여권번호]",
  phone: "[전화번호]",
  bank_account: "[계좌번호]",
  card_number: "[카드번호]",
  email: "[이메일]",
  document_id: "[문서번호]",
  verification_code: "[발급확인번호]",
  url: "[URL]",
  ip_address: "[IP주소]",
  name: "[성명]",
  address: "[주소]",
  other: "[개인정보]",
};

/**
 * Korean PII regexes. Order matters — more-specific patterns first so
 * generic patterns (bank account) don't swallow RRN-shaped strings.
 */
const REGEX_RULES: Array<{ category: PiiCategory; re: RegExp }> = [
  // RRN: 13 digits with optional hyphen, e.g. 950101-1234567.
  // 7th digit 1-4 = Korean national; 5-8 = foreigner. We map to
  // foreigner_rrn when 5-8 so the redaction token tells the user
  // which kind it was.
  { category: "foreigner_rrn", re: /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\s]?[5-8]\d{6}\b/g },
  { category: "rrn", re: /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-\s]?[1-4]\d{6}\b/g },
  // 법인등록번호 (13 digits): NNNNNN-NNNNNNN
  { category: "corp_rrn", re: /\b\d{6}-\d{7}\b/g },
  // 사업자등록번호 (10 digits): NNN-NN-NNNNN
  { category: "biz_rrn", re: /\b\d{3}-\d{2}-\d{5}\b/g },
  // 여권번호: Korean passport = 1 uppercase letter + 8 digits (e.g. M12345678).
  // Foreign passport = 1-2 uppercase letters + 6-9 digits (e.g. FA4665913).
  { category: "passport", re: /\b[A-Z]{1,2}\d{6,9}\b/g },
  // Verification code: blocks of 4-letter / 4-letter / 4-digit
  // (e.g. AAOU-GNQY-3886) — common on Korean gov/court certificates.
  { category: "verification_code", re: /\b[A-Z]{3,5}-[A-Z0-9]{3,5}-[A-Z0-9]{3,8}\b/g },
  // Credit card: 13-19 digits in 4-digit groups separated by - or space.
  { category: "card_number", re: /\b(?:\d{4}[-\s]){3}\d{4}(?:[-\s]\d{3})?\b/g },
  // Phone — Korean mobile 010-XXXX-XXXX, 011-XXX-XXXX, 02-XXX-XXXX etc
  { category: "phone", re: /\b0(?:10|11|16|17|18|19|2|3[1-9]|4[1-9]|5[1-9]|6[1-4]|70)[-\s]?\d{3,4}[-\s]?\d{4}\b/g },
  // Bank account — common Korean patterns (3-3-6, 3-6-2, 4-3-4-3, etc)
  { category: "bank_account", re: /\b\d{2,4}[-\s]\d{2,6}[-\s]\d{2,7}(?:[-\s]\d{2,7})?\b/g },
  // Email
  { category: "email", re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  // URL — http(s)://...
  { category: "url", re: /\bhttps?:\/\/[^\s<>"'\)]+/g },
  // IPv4 address
  { category: "ip_address", re: /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g },
  // Document ID — long unbroken digit strings (≥10 digits) that aren't
  // already redacted by more-specific rules. Catches 등기번호 / 발행번호 /
  // 사건번호 (when written as one long string), license plates, etc.
  // Runs LAST so it doesn't swallow RRNs, phones, or bank accounts.
  { category: "document_id", re: /\b\d{10,}\b/g },
];

/** Run all regex rules over the input. Returns hits + redacted string. */
function redactWithRegex(input: string): RedactResult {
  // Collect hits with absolute indices, then replace in reverse-index order so
  // earlier replacements don't shift the indices of later ones.
  const allHits: Array<PiiHit & { len: number }> = [];
  for (const { category, re } of REGEX_RULES) {
    for (const match of input.matchAll(re)) {
      if (match.index === undefined) continue;
      const original = match[0];
      // Skip if this span overlaps a hit already recorded (more-specific rule
      // wins because we list them in priority order).
      const overlaps = allHits.some(
        (h) =>
          match.index! < h.index + h.len &&
          match.index! + original.length > h.index,
      );
      if (overlaps) continue;
      allHits.push({
        category,
        original,
        replacement: TOKEN[category],
        index: match.index,
        len: original.length,
      });
    }
  }

  // Sort by index descending, then splice.
  allHits.sort((a, b) => b.index - a.index);
  let out = input;
  for (const h of allHits) {
    out = out.slice(0, h.index) + h.replacement + out.slice(h.index + h.len);
  }

  return {
    redactedText: out,
    hits: allHits
      .map(({ category, original, replacement, index }) => ({
        category,
        original,
        replacement,
        index,
      }))
      .sort((a, b) => a.index - b.index),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* LLM layer — catches Korean names, addresses, other contextual PII          */
/* ────────────────────────────────────────────────────────────────────────── */

const LlmFindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "The exact substring from the input that contains PII (a name, full address, etc.). Must be present verbatim in the input.",
          ),
        category: z
          .enum(["name", "address", "other"])
          .describe("Kind of PII this is."),
      }),
    )
    .max(80),
});

const LLM_SYSTEM_PROMPT = `You are a Korean PII redaction assistant for legal documents. Read the document and identify EVERY personally-identifying span that pure regex misses. Be AGGRESSIVE — when in doubt, flag it. False negatives leak personal data; false positives only redact a court name.

FLAG these:

1. PERSONAL NAMES, all scripts:
   - Korean names: 2-4 character Korean names (홍길동, 김 변호사, 박OO 등). Preceded/followed by 씨/군/양/님/변호사/대표/원장/외 etc., OR appearing as a party/witness/signatory.
   - Latin-script foreign names: e.g. "MALIKOV DAVRONBEK", "John Smith", "Davronbek Malikov". Common in immigration / business contexts.
   - Names attached to roles: 담당공무원: 양현지, 위임인: 김OO. Flag the name (NOT the role label).

2. ADDRESSES (full street addresses):
   - Korean: anything with 시·도 + 구/군 + 동/로/길 + number, e.g. "경기도 의정부시 의정부동 369-2", "서울특별시 강남구 테헤란로 508, 10층".
   - Foreign: full street addresses with country/city/street/number.

3. PASSPORT / VISA / ID NUMBERS not already redacted (e.g., visa codes like D10, K9, but be careful — a bare "D10" might be context-only).

4. OTHER:
   - Driver's license / national ID numbers
   - Customer / membership / order IDs that contain personal info
   - Bank names + account holder name pairs

DO NOT flag:
- Spans already containing [주민등록번호], [전화번호], [여권번호], [외국인등록번호] etc. — those are placeholders
- Statute citations (민법 제750조, 출입국관리법 etc.)
- Case numbers (2019다12345, SU-AB-26-001166 — these are gov reference codes, will be flagged by regex if needed)
- Court / agency / company / organization names (법무부, 서울출입국·외국인청, 코리아신탁주식회사, 강북새마을금고)
- Generic role words (원고, 피고, 변호사, 신청인, 위임인) when NOT followed by a specific person name
- Building names alone ("의정부역한양수자인파크뷰") — only flag when combined with street address

Output JSON: {findings: [{text, category}]}. category ∈ {name, address, other}. text MUST appear verbatim in the input.

Aim for thoroughness — typical immigration/property documents have 5-20 findings. Returning 0 is almost always wrong.`;

async function redactWithLlm(
  input: string,
  signal?: AbortSignal,
): Promise<PiiHit[]> {
  // EXTRACTION_MODEL is already a LanguageModel instance — pass as-is to
  // generateObject (it's a fast Groq/Llama for the PII detection task,
  // which is shorter and simpler than the legal-analysis extractor).
  const model = EXTRACTION_MODEL;
  // Cap input to ~12000 chars; very long documents are scanned regex-only
  // (the LLM call would be too expensive and slow for 100-page contracts).
  const truncated =
    input.length > 12_000 ? input.slice(0, 12_000) + "\n\n...[truncated]" : input;

  const result = await generateObject({
    model,
    schema: LlmFindingsSchema,
    system: LLM_SYSTEM_PROMPT,
    prompt: `Document:\n---\n${truncated}\n---\n\nList every Korean name, full address, or contextual PII you find.`,
    abortSignal: signal,
    maxOutputTokens: 4096,
    temperature: 0,
  });

  const hits: PiiHit[] = [];
  for (const f of result.object.findings) {
    if (!f.text || !f.text.trim()) continue;
    // Find every occurrence in the original input (LLM only sees truncated).
    let from = 0;
    while (from < input.length) {
      const idx = input.indexOf(f.text, from);
      if (idx === -1) break;
      hits.push({
        category: f.category,
        original: f.text,
        replacement: TOKEN[f.category],
        index: idx,
      });
      from = idx + f.text.length;
    }
  }
  return hits;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public entry point                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Redact PII from a text document.
 *
 * @param input Raw document text.
 * @param opts.thorough When true, also runs the LLM layer to catch names +
 *   addresses. When false (default), regex-only — much faster and free.
 * @param opts.signal AbortSignal for cancellation.
 */
export async function redactPii(
  input: string,
  opts: { thorough?: boolean; signal?: AbortSignal } = {},
): Promise<RedactResult> {
  const regexResult = redactWithRegex(input);
  if (!opts.thorough) return regexResult;

  // LLM sees the ORIGINAL document (with PII still in place) so it can
  // identify names/addresses. We apply the LLM findings to the
  // already-regex-redacted text to produce the final output.
  const llmHits = await redactWithLlm(input, opts.signal);

  // Merge: deduplicate against regex hits, splice into the regex output.
  // We need to translate LLM hit indices (which are in the ORIGINAL input)
  // to indices in the regex-redacted output. Easiest way: apply LLM hits
  // to the original first, then re-run regex — but that re-runs work.
  // Cleaner: just splice both sets of hits into the original in
  // reverse-index order.
  const allHits = [...regexResult.hits, ...llmHits].sort(
    (a, b) => b.index - a.index,
  );
  // Dedupe by overlap
  const filtered: PiiHit[] = [];
  for (const h of allHits) {
    const overlaps = filtered.some(
      (f) =>
        h.index < f.index + f.original.length &&
        h.index + h.original.length > f.index,
    );
    if (!overlaps) filtered.push(h);
  }

  let out = input;
  for (const h of filtered) {
    out = out.slice(0, h.index) + h.replacement + out.slice(h.index + h.original.length);
  }

  return {
    redactedText: out,
    hits: filtered.sort((a, b) => a.index - b.index),
  };
}
