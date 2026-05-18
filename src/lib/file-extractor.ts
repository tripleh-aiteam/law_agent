/**
 * File text extraction utilities for the Korean court-preparation AI agent.
 *
 * Supports PDF (via pdf-parse), DOCX (via mammoth), TXT/MD (UTF-8 decode).
 * HWP/HWPX is explicitly unsupported in v1 — caller receives a warning.
 *
 * Hard limits enforced here:
 *   - Per-file size: 20 MB
 * (The route layer enforces per-request file count and aggregate size.)
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

export type ExtractedFile = {
  filename: string;
  mimeType: string;
  byteSize: number;
  text: string;
  pages?: number;
  warnings: string[];
};

const HWP_UNSUPPORTED_WARNING =
  "한컴오피스(HWP) 파일은 v1에서 지원하지 않습니다. PDF로 변환 후 다시 업로드해 주세요. / HWP files are not supported in v1; please convert to PDF and re-upload.";

const SCANNED_PDF_WARNING =
  "PDF appears to be image-based (scanned). OCR was not performed in v1 — please paste the text manually.";

/** Strip ASCII control characters from filenames so they're safe to log. */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim() || "unnamed";
}

function getExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

type FileKind = "pdf" | "docx" | "text" | "hwp" | "unsupported";

function classify(mimeType: string, ext: string): FileKind {
  const mt = mimeType.toLowerCase();
  if (mt === "application/pdf" || ext === "pdf") return "pdf";
  if (
    mt ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return "docx";
  }
  if (mt === "text/plain" || mt === "text/markdown" || ext === "txt" || ext === "md") {
    return "text";
  }
  if (ext === "hwp" || ext === "hwpx" || mt === "application/x-hwp" || mt === "application/haansofthwp") {
    return "hwp";
  }
  return "unsupported";
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; pages: number; warnings: string[] }> {
  const warnings: string[] = [];
  // pdf-parse is CJS; dynamic import + default interop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf-parse has no first-class ESM types
  const mod: any = await import("pdf-parse");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime shape may be a function or { default: fn }
  const pdfParse: (b: Buffer) => Promise<{ text: string; numpages: number }> =
    typeof mod === "function" ? mod : mod.default;

  try {
    const result = await pdfParse(buffer);
    const text = (result.text ?? "").trim();
    const pages = result.numpages ?? 0;
    if (pages > 0 && text.length < 50) {
      warnings.push(SCANNED_PDF_WARNING);
    }
    // pdf-parse already joins pages; normalize whitespace minimally.
    return { text: result.text ?? "", pages, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF parsing failed";
    warnings.push(`PDF could not be parsed (encrypted or corrupted): ${msg}`);
    return { text: "", pages: 0, warnings };
  }
}

async function extractDocx(buffer: Buffer): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mammoth CJS interop
  const mod: any = await import("mammoth");
  const mammoth = mod.default ?? mod;
  try {
    const result = await mammoth.extractRawText({ buffer });
    if (Array.isArray(result.messages) && result.messages.length > 0) {
      for (const m of result.messages) {
        const text: string = typeof m === "string" ? m : m?.message ?? String(m);
        if (text) warnings.push(`DOCX: ${text}`);
      }
    }
    return { text: result.value ?? "", warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "DOCX parsing failed";
    warnings.push(`DOCX could not be parsed: ${msg}`);
    return { text: "", warnings };
  }
}

function extractText(buffer: Buffer): string {
  // UTF-8 decode; strip BOM if present.
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export async function extractFromBuffer(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<ExtractedFile> {
  const safeName = sanitizeFilename(filename);
  const byteSize = buffer.byteLength;

  if (byteSize > MAX_FILE_BYTES) {
    throw new Error(
      `File "${safeName}" is ${byteSize} bytes which exceeds the 20 MB per-file limit.`
    );
  }

  const ext = getExt(safeName);
  const kind = classify(mimeType, ext);

  switch (kind) {
    case "pdf": {
      const { text, pages, warnings } = await extractPdf(buffer);
      return {
        filename: safeName,
        mimeType: mimeType || "application/pdf",
        byteSize,
        text,
        pages,
        warnings,
      };
    }
    case "docx": {
      const { text, warnings } = await extractDocx(buffer);
      return {
        filename: safeName,
        mimeType:
          mimeType ||
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize,
        text,
        warnings,
      };
    }
    case "text": {
      const text = extractText(buffer);
      return {
        filename: safeName,
        mimeType: mimeType || "text/plain",
        byteSize,
        text,
        warnings: [],
      };
    }
    case "hwp": {
      return {
        filename: safeName,
        mimeType: mimeType || "application/x-hwp",
        byteSize,
        text: "",
        warnings: [HWP_UNSUPPORTED_WARNING],
      };
    }
    case "unsupported":
    default:
      throw new Error(`Unsupported file type: ${mimeType || ext || "unknown"}`);
  }
}

/**
 * Combine the extracted text from multiple files into a single narrative blob
 * suitable for seeding a textarea on the client.
 *
 * Each non-empty file becomes a header + body block separated by a horizontal rule.
 * Empty-text files contribute only their warnings, prefixed with "※ ".
 */
export function buildNarrativeFromFiles(files: ExtractedFile[]): string {
  const blocks: string[] = [];
  for (const f of files) {
    const trimmed = f.text.trim();
    if (trimmed.length === 0) {
      if (f.warnings.length > 0) {
        const lines = f.warnings.map((w) => `※ [${f.filename}] ${w}`);
        blocks.push(lines.join("\n"));
      }
      continue;
    }
    const pageInfo = typeof f.pages === "number" ? `${f.pages} pages, ` : "";
    const header = `[FILE: ${f.filename}] (${pageInfo}${f.byteSize} bytes)`;
    blocks.push(`${header}\n${f.text}\n\n---`);
  }
  return blocks.join("\n\n");
}
