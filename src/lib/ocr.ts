/**
 * Vision-LLM OCR fallback for scanned (image-based) PDFs.
 *
 * Claude 4.x can read native PDF bytes — including pages that are just
 * scanned images — and return the embedded text. We use this as a fallback
 * when `pdf-parse` extracts nothing meaningful (no embedded text layer).
 *
 * Why Sonnet 4.6 (not Opus): OCR is bulk extraction, not nuanced reasoning.
 * Sonnet handles it well at ~5× lower cost. Routed through the Vercel AI
 * Gateway so it bills against the Pro AI credit.
 *
 * Limits:
 *   - Claude's native PDF limit is 100 pages / 32 MB. We refuse anything
 *     bigger and let the caller surface a helpful warning instead of
 *     burning credits on a doomed call.
 *   - Hard timeout of 90s so a slow OCR doesn't hang the upload route.
 */
import { generateText } from "ai";
import { resolveModelForUse } from "./resolve-model";

const OCR_MODEL_ID = "anthropic/claude-sonnet-4-6";
const OCR_TIMEOUT_MS = 90_000;

/** Claude's documented native-PDF input ceiling. */
const MAX_OCR_BYTES = 32 * 1024 * 1024; // 32 MB
const MAX_OCR_PAGES = 100;

const OCR_PROMPT = `You are an OCR engine. Extract ALL textual content from the attached PDF — including handwritten notes, stamps, headers, footers, page numbers, signatures, and Korean court formatting. Preserve paragraph breaks; do NOT translate, summarize, or comment. Output ONLY the extracted text, exactly as it appears. If a page is blank, write "[빈 페이지 / blank page]" for that page. If you cannot read a region, write "[판독 불가 / unreadable]" inline.`;

export type OcrResult = {
  text: string;
  warnings: string[];
};

/**
 * Run vision OCR over a scanned PDF buffer. Returns the extracted text or
 * empty text + an explanatory warning on failure (never throws — failed OCR
 * should degrade gracefully to the existing "scanned PDF" warning path).
 */
export async function ocrPdfWithVision(
  buffer: Buffer,
  pageCount: number | undefined,
): Promise<OcrResult> {
  const warnings: string[] = [];

  if (buffer.byteLength > MAX_OCR_BYTES) {
    warnings.push(
      `OCR skipped: PDF is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB which exceeds the ${MAX_OCR_BYTES / 1024 / 1024} MB OCR ceiling.`,
    );
    return { text: "", warnings };
  }
  if (typeof pageCount === "number" && pageCount > MAX_OCR_PAGES) {
    warnings.push(
      `OCR skipped: PDF has ${pageCount} pages which exceeds the ${MAX_OCR_PAGES}-page OCR ceiling. Split the file and try again.`,
    );
    return { text: "", warnings };
  }

  // resolveModelForUse returns either a gateway-form string (preferred) or
  // a direct provider instance when only ANTHROPIC_API_KEY is set. Either
  // is callable by the AI SDK's generateText.
  const model = resolveModelForUse(OCR_MODEL_ID) ?? OCR_MODEL_ID;

  try {
    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: buffer,
              mediaType: "application/pdf",
            },
            {
              type: "text",
              text: OCR_PROMPT,
            },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(OCR_TIMEOUT_MS),
      maxOutputTokens: 8192,
    });

    const text = (result.text ?? "").trim();
    if (!text) {
      warnings.push("OCR returned empty text — the model could not extract anything readable from the PDF.");
    }
    return { text, warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`OCR failed: ${message}`);
    return { text: "", warnings };
  }
}
