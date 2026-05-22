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

const SCANNED_PDF_WARNING_OCR_TRIED =
  "스캔 PDF로 보여 LLM 비전 OCR로 추출했습니다. 오타가 있을 수 있습니다. / PDF appeared to be image-based (scanned). Text was extracted via vision OCR — verify accuracy.";

const SCANNED_PDF_WARNING_OCR_FAILED =
  "PDF appears to be image-based (scanned) and OCR failed. Please re-scan with selectable text or paste the content manually.";

/** Strip ASCII control characters from filenames so they're safe to log. */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim() || "unnamed";
}

function getExt(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

type FileKind =
  | "pdf"
  | "docx"
  | "text"
  | "hwp"
  | "image"
  | "xlsx"
  | "rtf"
  | "unsupported";

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
  if (
    mt.startsWith("image/") ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "png" ||
    ext === "webp" ||
    ext === "gif"
  ) {
    return "image";
  }
  if (
    mt ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    return "xlsx";
  }
  if (mt === "application/rtf" || mt === "text/rtf" || ext === "rtf") {
    return "rtf";
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

  // Tiny ratio of (extracted chars per page). Below this we treat the PDF
  // as effectively scanned and trigger vision OCR. 50 chars/page is well
  // below any meaningful prose density (a court ruling averages > 800/page).
  const SCANNED_THRESHOLD_CHARS_PER_PAGE = 50;

  try {
    const result = await pdfParse(buffer);
    const rawText = result.text ?? "";
    const trimmed = rawText.trim();
    const pages = result.numpages ?? 0;
    const isScanned =
      pages > 0 && trimmed.length < SCANNED_THRESHOLD_CHARS_PER_PAGE * pages;

    if (!isScanned) {
      return { text: rawText, pages, warnings };
    }

    // OCR fallback — dynamic import so the AI SDK isn't loaded on every
    // upload (only when we actually need it).
    const { ocrPdfWithVision } = await import("./ocr");
    const ocr = await ocrPdfWithVision(buffer, pages);
    if (ocr.text) {
      warnings.push(SCANNED_PDF_WARNING_OCR_TRIED);
      warnings.push(...ocr.warnings);
      return { text: ocr.text, pages, warnings };
    }
    // OCR didn't produce text — surface both the original "scanned" notice
    // and whatever OCR's own warning was.
    warnings.push(SCANNED_PDF_WARNING_OCR_FAILED);
    warnings.push(...ocr.warnings);
    return { text: "", pages, warnings };
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

/**
 * Excel (.xlsx / .xls) → CSV-style plain text. Each sheet is prefixed with
 * its name. Works well for contract appendices, payment schedules, party
 * lists, etc. that legal teams commonly receive as spreadsheets.
 */
async function extractXlsx(
  buffer: Buffer,
): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- xlsx is CJS
    const mod: any = await import("xlsx");
    const XLSX = mod.default ?? mod;
    const wb = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) {
        parts.push(`### ${sheetName}\n${csv.trim()}`);
      }
    }
    return { text: parts.join("\n\n"), warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "XLSX parsing failed";
    warnings.push(`Excel could not be parsed: ${msg}`);
    return { text: "", warnings };
  }
}

/**
 * RTF (Rich Text Format) → plain text. RTF is a markup format where each
 * paragraph is wrapped in control words. A lightweight strip is enough for
 * legal-doc use cases (we don't need to preserve formatting — only the
 * text content that goes to the LLM).
 */
function extractRtf(buffer: Buffer): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  try {
    const raw = buffer.toString("utf8");
    // Strip groups like {\fonttbl ... }, control words like \par, \rtf1, etc.
    const text = raw
      .replace(/\\par[d]?/g, "\n") // paragraph break
      .replace(/\\tab/g, "\t")
      .replace(/\{\\\*[^}]*\}/g, "") // {\* ... } extension groups
      .replace(/\{\\[a-zA-Z]+[^}]*?\}/g, "") // {\fonttbl ... } etc.
      .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/\\u(-?\d+)\??/g, (_, code) =>
        String.fromCharCode(parseInt(code, 10)),
      )
      .replace(/\\[a-zA-Z]+-?\d*\s?/g, "") // remaining control words
      .replace(/[{}]/g, "")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "RTF parsing failed";
    warnings.push(`RTF could not be parsed: ${msg}`);
    return { text: "", warnings };
  }
}

/**
 * Image (JPG / PNG / WEBP / GIF) → OCR text via Claude vision. Same
 * pipeline used by the scanned-PDF fallback, but called directly when the
 * upload IS an image.
 */
async function extractImage(
  buffer: Buffer,
  mimeType: string,
  ext: string,
): Promise<{ text: string; warnings: string[] }> {
  const { ocrImageWithVision } = await import("./ocr");
  // Normalize media type — some browsers send "image/jpg" instead of
  // "image/jpeg", and PNG/GIF/WEBP need the canonical form.
  let mt = mimeType.toLowerCase();
  if (!mt.startsWith("image/")) {
    mt =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/jpeg";
  }
  if (mt === "image/jpg") mt = "image/jpeg";
  const ocr = await ocrImageWithVision(buffer, mt);
  return { text: ocr.text, warnings: ocr.warnings };
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
    case "image": {
      const { text, warnings } = await extractImage(buffer, mimeType, ext);
      return {
        filename: safeName,
        mimeType: mimeType || `image/${ext || "jpeg"}`,
        byteSize,
        text,
        warnings,
      };
    }
    case "xlsx": {
      const { text, warnings } = await extractXlsx(buffer);
      return {
        filename: safeName,
        mimeType:
          mimeType ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        byteSize,
        text,
        warnings,
      };
    }
    case "rtf": {
      const { text, warnings } = extractRtf(buffer);
      return {
        filename: safeName,
        mimeType: mimeType || "application/rtf",
        byteSize,
        text,
        warnings,
      };
    }
    case "unsupported":
    default:
      throw new Error(
        `Unsupported file type: ${mimeType || ext || "unknown"}. Supported: PDF, DOCX, TXT, MD, RTF, XLSX, JPG, PNG, WEBP, GIF. HWP files must be converted to PDF first. / 지원 형식: PDF, DOCX, TXT, MD, RTF, XLSX, 이미지(JPG/PNG/WEBP/GIF). HWP는 PDF로 변환 후 업로드.`,
      );
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
