import { NextResponse } from "next/server";
import {
  extractFromBuffer,
  MAX_FILE_BYTES,
  type ExtractedFile,
} from "@/lib/file-extractor";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILES_PER_REQUEST = 5;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024; // 40 MB

export async function POST(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Content-Type must be multipart/form-data" },
      { status: 400 }
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse form data";
    return NextResponse.json({ error: `Invalid form data: ${message}` }, { status: 400 });
  }

  const entries = formData.getAll("files");
  const files: File[] = entries.filter((e): e is File => e instanceof File);

  if (files.length === 0) {
    return NextResponse.json(
      { error: "No files provided. Attach one or more files under the 'files' field." },
      { status: 400 }
    );
  }

  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      {
        error: `Too many files: ${files.length}. Max ${MAX_FILES_PER_REQUEST} per request.`,
      },
      { status: 413 }
    );
  }

  let totalBytes = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        {
          error: `File "${f.name}" is ${f.size} bytes which exceeds the 20 MB per-file limit.`,
        },
        { status: 413 }
      );
    }
    totalBytes += f.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      {
        error: `Total upload size ${totalBytes} bytes exceeds the 40 MB per-request limit.`,
      },
      { status: 413 }
    );
  }

  const results: ExtractedFile[] = [];
  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    try {
      const extracted = await extractFromBuffer(
        buffer,
        file.name,
        file.type || ""
      );
      results.push(extracted);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extraction failed";
      results.push({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        byteSize: file.size,
        text: "",
        warnings: [message],
      });
    }
  }

  return NextResponse.json({ files: results });
}
