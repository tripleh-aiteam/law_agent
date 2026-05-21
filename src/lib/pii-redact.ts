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
  | "biz_rrn" // 사업자등록번호
  | "corp_rrn" // 법인등록번호
  | "phone"
  | "bank_account"
  | "email"
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
  biz_rrn: "[사업자등록번호]",
  corp_rrn: "[법인등록번호]",
  phone: "[전화번호]",
  bank_account: "[계좌번호]",
  email: "[이메일]",
  name: "[성명]",
  address: "[주소]",
  other: "[개인정보]",
};

/**
 * Korean PII regexes. Order matters — more-specific patterns first so
 * generic patterns (bank account) don't swallow RRN-shaped strings.
 */
const REGEX_RULES: Array<{ category: PiiCategory; re: RegExp }> = [
  // RRN: 13 digits with optional hyphen, e.g. 950101-1234567 or 9501011234567
  { category: "rrn", re: /\b\d{6}[-\s]?[1-8]\d{6}\b/g },
  // 사업자등록번호 (10 digits): NNN-NN-NNNNN
  { category: "biz_rrn", re: /\b\d{3}-\d{2}-\d{5}\b/g },
  // 법인등록번호 (13 digits): NNNNNN-NNNNNNN
  { category: "corp_rrn", re: /\b\d{6}-\d{7}\b/g },
  // Phone — Korean mobile 010-XXXX-XXXX, 011-XXX-XXXX, 02-XXX-XXXX etc
  { category: "phone", re: /\b0(?:10|11|16|17|18|19|2|3[1-9]|4[1-9]|5[1-9]|6[1-4]|70)[-\s]?\d{3,4}[-\s]?\d{4}\b/g },
  // Bank account — common Korean patterns (3-3-6, 3-6-2, 4-3-4-3, etc)
  { category: "bank_account", re: /\b\d{2,4}[-\s]\d{2,6}[-\s]\d{2,7}(?:[-\s]\d{2,7})?\b/g },
  // Email
  { category: "email", re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
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

const LLM_SYSTEM_PROMPT = `You are a Korean PII redaction assistant. Read the document and identify ONLY personally-identifying information that pure regex can miss:

- Korean personal names (성명) — 2-4 character Korean names usually preceded/followed by 씨, 군, 양, 님, 변호사, 대표, or in plaintext as a party in the document. DO NOT flag company names, court names, judge titles without name, or generic role labels.
- Full Korean street addresses — anything with 시/도, 구, 동, 로, 길, 번지, 호. Partial addresses (just "서울시") should NOT be flagged.
- Other clearly-identifying info NOT matching standard patterns (e.g., passport numbers, license plate, customer IDs that include personal data).

DO NOT flag:
- Numbers already redacted (e.g., text containing [주민등록번호], [전화번호] — those are placeholders)
- Statute citations (민법 제750조 etc.)
- Case numbers (2019다12345 etc.)
- Court names, judge titles without specific names
- Generic role words (원고, 피고, 변호사 when not followed by a name)
- Company names or organization names

Output a JSON array of findings. Each finding is {text, category}. Use category 'name' for personal names, 'address' for addresses, 'other' for anything else. The 'text' must appear verbatim in the input.`;

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
