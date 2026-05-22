/**
 * Vision-LLM OCR for scanned PDFs and image files.
 *
 * Cascades through multiple providers so OCR works whether the user has
 * paid keys or only the free ones. On any provider failure (auth, rate
 * limit, model rejection, timeout), we move to the next.
 *
 * We call each provider's SDK DIRECTLY (not through the AI Gateway)
 * because direct provider keys are more commonly configured in Vercel
 * than the gateway key, and they bypass any gateway billing/balance
 * issues.
 *
 * Provider order is FREE-FIRST so OCR works on the free tier and only
 * burns paid credits when the free quota is exhausted:
 *
 *   1. Google Gemini Flash 2.5      — free 1,500 req/day, native PDF + image
 *   2. Groq Llama 4 Scout           — free 14,400 req/day, image-only
 *   3. Anthropic Claude Sonnet 4.6  — paid, native PDF + image
 *   4. OpenAI GPT-4o-mini           — paid, image (PDF support partial)
 *
 * Limits enforced before any provider call:
 *   - PDF: ≤ 32 MB / 100 pages (Claude's documented ceiling)
 *   - Image: ≤ 5 MB (Claude's documented ceiling)
 *   - 90-second hard timeout per provider attempt
 */
import { generateText, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";

const OCR_TIMEOUT_MS = 90_000;
const MAX_OCR_BYTES = 32 * 1024 * 1024; // 32 MB (PDF)
const MAX_OCR_PAGES = 100;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (per-image)

const OCR_PROMPT = `You are an OCR engine. Extract ALL textual content from the attached document — including handwritten notes, stamps, headers, footers, page numbers, signatures, and Korean court formatting. Preserve paragraph breaks; do NOT translate, summarize, or comment. Output ONLY the extracted text, exactly as it appears. If a page is blank, write "[빈 페이지 / blank page]" for that page. If you cannot read a region, write "[판독 불가 / unreadable]" inline.`;

export type OcrResult = {
  text: string;
  warnings: string[];
  /** Which provider actually produced the result (for debugging). */
  provider?: string;
};

type ProviderEntry = {
  label: string;
  /** Returns the model instance, or undefined if the required key isn't set. */
  resolve: () => LanguageModel | undefined;
};

function ifEnv<T>(name: string, get: () => T): T | undefined {
  const v = process.env[name];
  return v && v.trim() ? get() : undefined;
}

const PDF_CASCADE: ProviderEntry[] = [
  {
    label: "google/gemini-2.5-flash",
    resolve: () =>
      ifEnv("GOOGLE_GENERATIVE_AI_API_KEY", () => google("gemini-2.5-flash")),
  },
  {
    label: "anthropic/claude-sonnet-4-6",
    resolve: () =>
      ifEnv("ANTHROPIC_API_KEY", () => anthropic("claude-sonnet-4-6")),
  },
  {
    label: "openai/gpt-4o-mini",
    resolve: () => ifEnv("OPENAI_API_KEY", () => openai("gpt-4o-mini")),
  },
];

const IMAGE_CASCADE: ProviderEntry[] = [
  {
    label: "google/gemini-2.5-flash",
    resolve: () =>
      ifEnv("GOOGLE_GENERATIVE_AI_API_KEY", () => google("gemini-2.5-flash")),
  },
  {
    label: "groq/llama-4-scout",
    resolve: () =>
      ifEnv("GROQ_API_KEY", () =>
        groq("meta-llama/llama-4-scout-17b-16e-instruct"),
      ),
  },
  {
    label: "anthropic/claude-sonnet-4-6",
    resolve: () =>
      ifEnv("ANTHROPIC_API_KEY", () => anthropic("claude-sonnet-4-6")),
  },
  {
    label: "openai/gpt-4o-mini",
    resolve: () => ifEnv("OPENAI_API_KEY", () => openai("gpt-4o-mini")),
  },
];

type OcrAttempt = { provider: string; error: string };

async function tryOcrOnce(
  entry: ProviderEntry,
  buffer: Buffer,
  mediaType: string,
): Promise<{ text: string } | { error: string; skipped?: true }> {
  const model = entry.resolve();
  if (!model) {
    return {
      error: "skipped (API key not set)",
      skipped: true,
    };
  }
  try {
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
    return { error: m.length > 240 ? m.slice(0, 240) + "…" : m };
  }
}

async function runCascade(
  buffer: Buffer,
  mediaType: string,
  cascade: ProviderEntry[],
  successNotice?: string,
): Promise<OcrResult> {
  const attempts: OcrAttempt[] = [];
  for (const entry of cascade) {
    const result = await tryOcrOnce(entry, buffer, mediaType);
    if ("text" in result) {
      const warnings: string[] = [];
      if (successNotice) warnings.push(successNotice);
      const realAttempts = attempts.filter((a) => !a.error.startsWith("skipped"));
      if (realAttempts.length > 0) {
        warnings.push(
          `OCR fell through to ${entry.label} after ${realAttempts.length} provider(s) declined.`,
        );
      }
      return { text: result.text, warnings, provider: entry.label };
    }
    attempts.push({ provider: entry.label, error: result.error });
  }
  // None worked. If EVERY provider was skipped due to missing keys,
  // surface a cleaner setup message. Otherwise show the per-provider
  // breakdown.
  const allSkipped = attempts.every((a) => a.error.startsWith("skipped"));
  if (allSkipped) {
    return {
      text: "",
      warnings: [
        "OCR 불가: 어떤 OCR 제공자 키도 설정되어 있지 않습니다. Vercel 환경 변수에 GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY 중 최소 하나를 추가하세요. / No OCR provider keys configured. Add at least one of: GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY.",
      ],
    };
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

/** Run vision OCR over an image buffer. Never throws. */
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
    IMAGE_CASCADE,
    "이미지에서 OCR로 텍스트를 추출했습니다. 정확도 확인이 필요할 수 있습니다. / Text was OCR-extracted from an image — verify accuracy.",
  );
}

/** Run vision OCR over a scanned PDF buffer. Never throws. */
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
  return runCascade(buffer, "application/pdf", PDF_CASCADE);
}
