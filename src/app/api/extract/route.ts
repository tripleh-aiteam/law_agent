import { NextResponse } from "next/server";
import { z } from "zod";
import { extractLegalElements } from "@/lib/extractor";
import { resolveModel } from "@/lib/models";
import { runManusAgent } from "@/lib/manus";
import type { LegalElements } from "@/lib/types";

export const runtime = "nodejs";
// Most models finish in <60s, but Manus tasks can take 5-25 minutes —
// we poll inside the function until the task completes. 800s is the Pro-
// plan Fluid-Compute ceiling at the time of writing.
export const maxDuration = 800;

const BodySchema = z.object({
  narrative: z.string().min(10, "narrative must be at least 10 characters"),
  locale: z.enum(["ko", "en"]),
  /** Optional gateway model ID (e.g. "anthropic/claude-opus-4.7"). */
  model: z.string().optional(),
});

/**
 * Manus returns free-form prose + optional artifacts, NOT our strict
 * LegalElementsSchema. To keep the UI consistent, we wrap Manus output
 * into the same ExtractResponse shape but only populate `summary` —
 * `elements` and `matches` are intentionally empty placeholders. The
 * conversation thread renders the summary card and skips the structured
 * sections gracefully.
 */
const EMPTY_ELEMENTS: LegalElements = {
  caseNature: "unknown",
  parties: { plaintiff: "", defendant: "" },
  claimCause: "",
  legalRelationship: "",
  partyStatus: "",
  coreIssue: "",
  damageType: "",
  applicableStatutes: [],
  keyFacts: [],
  missingInfo: [],
};

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

  const requestedModel = parsed.data.model;
  const family = requestedModel
    ? resolveModel(requestedModel).family
    : undefined;

  // ── Manus branch: run as autonomous agent task instead of a single LLM call.
  if (family === "manus") {
    try {
      const manusPrompt = buildManusPrompt(
        parsed.data.narrative,
        parsed.data.locale,
      );
      const { text } = await runManusAgent(manusPrompt, req.signal);
      // Manus's prose IS the summary — no structured elements to extract.
      return NextResponse.json({
        elements: EMPTY_ELEMENTS,
        summary: text,
        clarifyingQuestions: [],
      });
    } catch (err: unknown) {
      console.error("[api/extract manus] failed:", {
        message: err instanceof Error ? err.message : String(err),
        narrativeLen: parsed.data.narrative.length,
        locale: parsed.data.locale,
      });
      const message =
        err instanceof Error ? err.message : "Manus task failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // ── Single-LLM branch (Claude / ChatGPT / Gemini).
  try {
    const { elements, summary, clarifyingQuestions } = await extractLegalElements(
      parsed.data.narrative,
      parsed.data.locale,
      parsed.data.model,
      req.signal,
    );
    return NextResponse.json({ elements, summary, clarifyingQuestions });
  } catch (err: unknown) {
    console.error("[api/extract] failed:", {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
      modelRequested: parsed.data.model ?? "(default)",
      narrativeLen: parsed.data.narrative.length,
      locale: parsed.data.locale,
      cause:
        err && typeof err === "object" && "cause" in err
          ? String((err as { cause: unknown }).cause).slice(0, 500)
          : undefined,
    });
    const rawMessage =
      err instanceof Error ? err.message : "Extraction failed";
    const message = rawMessage.includes("did not match schema")
      ? "분석할 수 없는 형식입니다. 학술 자료가 아닌, 실제 사건의 사실관계(당사자, 청구원인, 일시 등)를 포함하여 입력해 주세요. / The input doesn't look like a case — please include real party facts, claims, and dates."
      : rawMessage.includes("could not parse")
        ? "모델이 유효한 JSON을 반환하지 못했습니다. 다른 모델로 다시 시도해 주세요. / Model returned unparseable output — try a different model."
        : rawMessage;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Compose the prompt we hand to Manus. Manus accepts free-form natural
 * language, so we phrase the request as a high-value research task it can
 * actually plan and execute against — not as "extract these JSON fields".
 */
function buildManusPrompt(narrative: string, locale: "ko" | "en"): string {
  const isKo = locale === "ko";
  return [
    isKo
      ? "당신은 한국 법률 리서치 보조 에이전트입니다. 사용자가 제공한 사건의 사실관계와 첨부 문서를 검토하고, 인터넷에서 최근 대법원 판례와 관련 법령을 추가로 조사하여 다음을 한국어로 작성해 주세요:"
      : "You are a Korean legal research assistant agent. Review the user-provided case facts and any attached documents, supplement with up-to-date Korean Supreme Court (대법원) precedent and statute research from the web, and produce the following — preserve Korean legal terms inline:",
    "",
    isKo ? "1. 사건 요약 (2-3 단락)" : "1. Case summary (2-3 paragraphs)",
    isKo ? "2. 핵심 쟁점 (3-5개, 한국어 법률 용어 사용)" : "2. Core issues (3-5, using Korean legal terms)",
    isKo
      ? "3. 적용 가능한 대법원 판례 (사건번호 + 인용 가능성 평가 포함, 최소 3건)"
      : "3. Applicable Supreme Court precedents (with case numbers + citability assessment, at least 3)",
    isKo ? "4. 상대방이 제기할 예상 반박 논거" : "4. Anticipated counter-arguments from opposing counsel",
    isKo ? "5. 변호사의 다음 단계 권고 사항" : "5. Recommended next steps for counsel",
    "",
    "---",
    isKo ? "사건 자료:" : "Case material:",
    "---",
    narrative,
  ].join("\n");
}
