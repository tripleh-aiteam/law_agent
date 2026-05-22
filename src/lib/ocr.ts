/**
 * Vision-LLM OCR for scanned PDFs and image files.
 *
 * Cascades through multiple providers so OCR works whether the user has
 * paid keys or only the free ones. On any provider failure (auth, rate
 * limit, model rejection, timeout), we move to the next.
 *
 * Provider order is FREE-FIRST so OCR works on the free tier and only
 * burns paid credits when the free quota is exhausted:
 *
 *   1. Google Gemini Flash 2.5      — free 1,500 req/day, native PDF + image
 *   2. Groq Llama 4 Scout           — free 14,400 req/day, image-only
 *   3. Anthropic Claude Sonnet 4.6  — paid, native PDF + image
 *   4. OpenAI GPT-5.5 / GPT-4o      — paid, image (PDF support partial)
 *
 * All routing is via the AI Gateway (plain "provider/model" strings) so
 * users don't need direct provider keys — one AI_GATEWAY_API_KEY covers
 * the whole cascade.
 *
 * Limits enforced before any provider call:
 *   - PDF: ≤ 32 MB / 100 pages (Claude's documented ceiling)
 *   - Image: ≤ 5 MB (Claude's documented ceiling)
 *   - 90-second hard timeout per provider attempt
 */
import { generateText } from "ai";
import { resolveModelForUse } from "./resolve-model";

const OCR_TIMEOUT_MS = 90_000;
const MAX_OCR_BYTES = 32 * 1024 * 1024; // 32 MB (PDF)
const MAX_OCR_PAGES = 100;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (per-image)

const OCR_PROMPT = `You are an OCR engine. Extract ALL textual content from the attached document — including handwritten notes, stamps, headers, footers, page numbers, signatures, and Korean court formatting. Preserve paragraph breaks; do NOT translate, summarize, or comment. Output ONLY the extracted text, exactly as it appears. If a page is blank, write "[빈 페이지 / blank page]" for that page. If you cannot read a region, write "[판독 불가 / unreadable]" inline.`;

export type OcrResult = {
  text: string;
  warnings: string[];
  /** Which provider actually produced the result (for debugging / observability). */
  provider?: string;
};

/**
 * Provider cascades. Each entry is a Vercel AI Gateway model id. Free
 * providers come first; paid providers are tried only if the free ones
 * are unavailable.
 */
const PDF_PROVIDER_CASCADE: string[] = [
  "google/gemini-2.5-flash",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-4o-mini",
];

const IMAGE_PROVIDER_CASCADE: string[] = [
  "google/gemini-2.5-flash",
  "groq/meta-llama/llama-4-scout-17b-16e-instruct",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-4o-mini",
];

type OcrAttempt = { provider: string; error: string };

/**
 * Try one provider. Returns text on success or an error description on
 * failure. Never throws — failures are returned so the cascade can move
 * on.
 */
async function tryOcrOnce(
  modelId: string,
  buffer: Buffer,
  mediaType: string,
): Promise<{ text: string } | { error: string }> {
  try {
    const model = resolveModelForUse(modelId) ?? modelId;
    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: buffer, mediaType },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      maxOutputTokens: 8192,
    });
    const text = (result.text ?? "").trim();
    if (!text) {
      return { error: "empty response (model couldn't read the document)" };
    }
    return { text };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // Truncate long upstream errors so the joined cascade summary stays
    // human-readable.
    return { error: m.length > 240 ? m.slice(0, 240) + "…" : m };
  }
}

/**
 * Walk the provider cascade and return on the first success. If every
 * provider fails, return empty text with a warning that lists what each
 * one said — that helps the user (or us) diagnose where the cascade is
 * breaking down.
 */
async function runCascade(
  buffer: Buffer,
  mediaType: string,
  providers: string[],
  successNotice?: string,
): Promise<OcrResult> {
  const attempts: OcrAttempt[] = [];
  for (const provider of providers) {
    const result = await tryOcrOnce(provider, buffer, mediaType);
    if ("text" in result) {
      const warnings: string[] = [];
      if (successNotice) warnings.push(successNotice);
      if (attempts.length > 0) {
        // Useful breadcrumb if the FIRST provider failed but a later one
        // succeeded — the user knows which path worked.
        warnings.push(
          `OCR fell through to ${provider} after ${attempts.length} provider(s) declined.`,
        );
      }
      return { text: result.text, warnings, provider };
    }
    attempts.push({ provider, error: result.error });
  }
  const summary = attempts
    .map((a) => `${a.provider}: ${a.error}`)
    .join(" | ");
  return {
    text: "",
    warnings: [
      `모든 OCR 제공자에 실패했습니다 / All OCR providers failed: ${summary}`,
    ],
  };
}

/**
 * Run vision OCR over an image buffer (JPG / PNG / WEBP / GIF).
 * Never throws.
 */
export async function ocrImageWithVision(
  buffer: Buffer,
  mediaType: string,
): Promise<OcrResult> {
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return {
      text: "",
      warnings: [
        `OCR skipped: image is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB which exceeds the 5 MB OCR ceiling.`,
      ],
    };
  }
  return runCascade(
    buffer,
    mediaType,
    IMAGE_PROVIDER_CASCADE,
    "이미지에서 OCR로 텍스트를 추출했습니다. 정확도 확인이 필요할 수 있습니다. / Text was OCR-extracted from an image — verify accuracy.",
  );
}

/**
 * Run vision OCR over a scanned PDF buffer.
 * Never throws.
 */
export async function ocrPdfWithVision(
  buffer: Buffer,
  pageCount: number | undefined,
): Promise<OcrResult> {
  if (buffer.byteLength > MAX_OCR_BYTES) {
    return {
      text: "",
      warnings: [
        `OCR skipped: PDF is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB which exceeds the ${MAX_OCR_BYTES / 1024 / 1024} MB OCR ceiling.`,
      ],
    };
  }
  if (typeof pageCount === "number" && pageCount > MAX_OCR_PAGES) {
    return {
      text: "",
      warnings: [
        `OCR skipped: PDF has ${pageCount} pages which exceeds the ${MAX_OCR_PAGES}-page OCR ceiling. Split the file and try again.`,
      ],
    };
  }
  return runCascade(buffer, "application/pdf", PDF_PROVIDER_CASCADE);
}
