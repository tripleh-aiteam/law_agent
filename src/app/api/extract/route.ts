import { NextResponse } from "next/server";
import { z } from "zod";
import { extractLegalElements } from "@/lib/extractor";
import { isMoaModelId } from "@/lib/models";
import { moaExtract, type MoaProgressEvent } from "@/lib/moa";

export const runtime = "nodejs";
// MoA fans out to 3 models + 1 aggregator. The slowest path can take ~75s,
// so we bump maxDuration above the previous 60s to give MoA headroom.
export const maxDuration = 120;

const BodySchema = z.object({
  narrative: z.string().min(10, "narrative must be at least 10 characters"),
  locale: z.enum(["ko", "en"]),
  /** Optional gateway model ID (e.g. "anthropic/claude-opus-4-7"). Validated downstream. */
  model: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* MoA streaming response                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Stream the MoA pipeline as NDJSON so the UI can render each stage in real
 * time (3 candidates fanning out → aggregator → final result). One JSON
 * object per line, terminated by \n. The very last line is either
 * { type: "final", elements, summary, clarifyingQuestions, candidates }
 * or { type: "error", message } so the client knows when to stop reading.
 */
function streamMoa(
  narrative: string,
  locale: "ko" | "en",
  clientSignal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // Controller already closed (client aborted) — swallow.
        }
      };

      const onProgress = (event: MoaProgressEvent) => send(event);

      try {
        const result = await moaExtract(
          narrative,
          locale,
          clientSignal,
          onProgress,
        );
        send({
          type: "final",
          elements: result.elements,
          summary: result.summary,
          clarifyingQuestions: result.clarifyingQuestions,
          candidates: result.candidates,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Don't log AbortError — it's expected when the user hits Stop.
        if (!(err instanceof DOMException) || err.name !== "AbortError") {
          console.error("[api/extract MoA] failed:", message);
        }
        send({ type: "error", message });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // Disable nginx/Vercel buffering so events ship to the browser as
      // soon as they're emitted (otherwise the user sees nothing until
      // the whole stream completes).
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
      { status: 400 }
    );
  }

  // Mixture-of-Agents: stream stage-by-stage so the UI can show the agents
  // working in parallel. Single-model path stays as a one-shot JSON response.
  if (isMoaModelId(parsed.data.model)) {
    return streamMoa(parsed.data.narrative, parsed.data.locale, req.signal);
  }

  try {
    const { elements, summary, clarifyingQuestions } = await extractLegalElements(
      parsed.data.narrative,
      parsed.data.locale,
      parsed.data.model,
      // Forward the client's abort signal so the Stop button truly cancels
      // the upstream LLM call instead of just dropping the response.
      req.signal,
    );
    return NextResponse.json({ elements, summary, clarifyingQuestions });
  } catch (err: unknown) {
    // Log the full error to Vercel function logs so we can diagnose 500s.
    console.error("[api/extract] failed:", {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
      modelRequested: parsed.data.model ?? "(default)",
      narrativeLen: parsed.data.narrative.length,
      locale: parsed.data.locale,
      // AI SDK errors include a `cause` chain with the underlying API error.
      cause:
        err && typeof err === "object" && "cause" in err
          ? String((err as { cause: unknown }).cause).slice(0, 500)
          : undefined,
    });
    const rawMessage =
      err instanceof Error ? err.message : "Extraction failed";
    // Friendlier message for the most common case (schema mismatch on
    // non-case inputs like academic articles or random text).
    const message = rawMessage.includes("did not match schema")
      ? "분석할 수 없는 형식입니다. 학술 자료가 아닌, 실제 사건의 사실관계(당사자, 청구원인, 일시 등)를 포함하여 입력해 주세요. / The input doesn't look like a case — please include real party facts, claims, and dates."
      : rawMessage.includes("could not parse")
        ? "모델이 유효한 JSON을 반환하지 못했습니다. 다른 모델(예: Claude Opus 4.7)로 다시 시도해 주세요. / Model returned unparseable output — try a different model (e.g. Claude Opus 4.7)."
        : rawMessage;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
