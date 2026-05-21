/**
 * Civil court document drafter — generates 소장 (complaint) or 답변서
 * (answer) in proper Korean court format from case-fact inputs.
 *
 * The output is a STRUCTURED object (not a blob of text) so the UI can
 * render each section with the right layout and the Word exporter can
 * preserve court-style spacing / headings.
 *
 * Format references:
 *  - 민사소송규칙 § 2, § 65 (소장 형식)
 *  - 대법원 양식 — 소장 양식 (gov.kr)
 *  - 답변서: 민사소송법 § 256 — defendant must respond within 30 days
 */
import { generateObject } from "ai";
import { z } from "zod";
import { EXTRACTION_MODEL } from "./ai";
import { resolveModelForUse } from "./resolve-model";
import { safeModelId } from "./models";

const TIMEOUT_MS = 180_000;

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const PartySchema = z.object({
  role: z
    .enum(["원고", "피고"])
    .describe("Party role — 원고 (plaintiff) or 피고 (defendant)."),
  name: z.string().describe("Full legal name of the party."),
  idLabel: z
    .string()
    .describe(
      "주민등록번호 or 사업자등록번호 or 법인등록번호 — the ID type label.",
    ),
  idNumber: z
    .string()
    .describe("The ID number itself, or '비공개' if not provided."),
  address: z.string().describe("Full street address."),
  contact: z
    .string()
    .optional()
    .describe("Phone number or email (optional)."),
  representative: z
    .string()
    .optional()
    .describe(
      "대표자 / 대리인 name if the party is a corporation or represented by counsel.",
    ),
});

export const EvidenceItemSchema = z.object({
  label: z
    .string()
    .describe(
      "Evidence label per Korean court convention: '갑 제1호증' for plaintiff evidence in 소장; '을 제1호증' for defendant evidence in 답변서. Number incrementally.",
    ),
  title: z
    .string()
    .describe(
      "Short title of the evidence in Korean (예: '차용증', '입금내역', '카카오톡 대화 캡처', '내용증명').",
    ),
  purpose: z
    .string()
    .describe(
      "1 sentence in Korean explaining what this evidence proves (입증취지).",
    ),
});

export const CivilDraftSchema = z.object({
  documentType: z
    .enum(["complaint", "answer"])
    .describe("Document type: complaint = 소장, answer = 답변서."),
  caption: z
    .string()
    .describe(
      "사건명 in Korean — short claim title that follows 대법원 양식. Examples: '대여금', '손해배상(기)', '약정금', '부당이득반환', '건물명도', '임대차보증금'. NOT a full sentence — a 2-5 word claim category.",
    ),
  caseNumber: z
    .string()
    .optional()
    .describe(
      "사건번호 — only for 답변서 (assigned by court). Format: '2026가단12345' or '2026가합54321'. Empty string for 소장.",
    ),
  parties: z
    .array(PartySchema)
    .min(2)
    .describe("Exactly two parties: one 원고 and one 피고."),
  prayerForRelief: z
    .array(z.string())
    .min(1)
    .describe(
      "청구취지 (소장) OR 청구취지에 대한 답변 (답변서). Each item is one numbered demand sentence in formal Korean court style. \n\nFOR 소장: '피고는 원고에게 금 50,000,000원 및 이에 대하여 …부터 …까지 연 5%의, 그 다음날부터 다 갚는 날까지 연 12%의 각 비율로 계산한 금원을 지급하라.', '소송비용은 피고가 부담한다.', '제1항은 가집행할 수 있다.'. \n\nFOR 답변서: '원고의 청구를 기각한다.', '소송비용은 원고가 부담한다.'",
    ),
  factsAndLaw: z
    .string()
    .describe(
      "청구원인 (소장) OR 청구원인에 대한 답변 + 항변 (답변서). LONG prose in formal Korean court register (했다/한다 체, 다음과 같다, …에 의하면 등). \n\nMUST use numbered headings (1., 2., 3., 가., 나., 다.) to organize: \n  (1) 당사자 관계 / 사실관계 / facts \n  (2) 법적 근거 — cite specific 민법/상법/특별법 조항 \n  (3) 청구 산정 / damages calculation \nFor 답변서: respond to each plaintiff allegation with 인정/부인/부지 + raise affirmative defenses (시효, 변제, 상계 etc).\n\nMinimum 1,500 Korean characters. Be detailed and specific.",
    ),
  evidence: z
    .array(EvidenceItemSchema)
    .describe(
      "입증방법 — list every piece of evidence. 갑 제1호증, 갑 제2호증… for 소장; 을 제1호증… for 답변서. Aim for 3-8 items.",
    ),
  attachments: z
    .array(z.string())
    .describe(
      "첨부서류 — standard attachments. Always include: '소장 부본 1통' (or '답변서 부본 1통'), '송달료 납부서 1통', '인지 영수증 1통'. Add '법인등기사항증명서 1통' if party is corporation.",
    ),
  filingDate: z
    .string()
    .describe(
      "작성일 in Korean court format: 'YYYY. M. D.' (with trailing dot, spaces). Example: '2026. 5. 21.'",
    ),
  court: z
    .string()
    .describe(
      "관할법원 — full Korean name of the court with jurisdiction (예: '서울중앙지방법원', '인천지방법원', '부산지방법원 동부지원'). Determine from defendant's address + claim type + amount.",
    ),
  jurisdictionRationale: z
    .string()
    .describe(
      "1-2 sentences in Korean explaining WHY this court has jurisdiction (피고 주소지 / 의무이행지 / 부동산 소재지 / 합의관할 등) — references 민사소송법 §§ 2-25.",
    ),
  practicalNotes: z
    .array(z.string())
    .describe(
      "Practitioner notes for the user in Korean — 2-5 short items covering: 인지대 estimate, 송달료 estimate, 답변서 deadline (30일), 입증 priorities, weak points to strengthen. NOT in the court document itself, shown separately in the UI.",
    ),
});

export type CivilDraft = z.infer<typeof CivilDraftSchema>;
export type CivilDraftParty = z.infer<typeof PartySchema>;
export type CivilDraftEvidence = z.infer<typeof EvidenceItemSchema>;

/* -------------------------------------------------------------------------- */
/* Input — what the user fills out in the form                                 */
/* -------------------------------------------------------------------------- */

export interface CivilDraftInput {
  documentType: "complaint" | "answer";
  claimCategory: string;
  plaintiff: {
    name: string;
    idLabel: string;
    idNumber: string;
    address: string;
    contact?: string;
    representative?: string;
  };
  defendant: {
    name: string;
    idLabel: string;
    idNumber: string;
    address: string;
    contact?: string;
    representative?: string;
  };
  claimAmountKrw?: number;
  caseFacts: string;
  legalBasis?: string;
  caseNumber?: string;
  preferredCourt?: string;
  citedPrecedents?: string;
}

/* -------------------------------------------------------------------------- */
/* System prompts                                                              */
/* -------------------------------------------------------------------------- */

const COMPLAINT_SYSTEM_PROMPT = `당신은 30년 경력의 대한민국 민사 변호사입니다. 의뢰인의 사실관계를 바탕으로 법원에 제출할 정식 소장(訴狀)을 작성합니다.

대법원 양식과 민사소송법 § 249, § 250, 민사소송규칙 § 2, § 65를 엄격히 준수합니다.

# 작성 원칙

1. **법률문어 사용**: '~한다', '~하였다', '~함이 마땅하다', '~함에도 불구하고' 등 전형적인 법률 문어체로 작성합니다. '~해요', '~이에요' 등 구어체는 절대 사용 금지.

2. **사건명(caption)**: 사건의 본질에 부합하는 2-5단어의 한국어 청구 유형을 정확히 기재합니다 (예: '대여금', '손해배상(기)', '약정금', '부당이득반환', '건물명도', '계약금반환', '임금', '하자보수에 갈음하는 손해배상').

3. **청구취지(prayerForRelief)**: 반드시 구체적 금액과 이자율을 명시합니다.
   - 정형 문구: "피고는 원고에게 금 ○○○원 및 이에 대하여 ○년 ○월 ○일부터 이 사건 소장부본 송달일까지는 연 5%의, 그 다음 날부터 다 갚는 날까지는 연 12%의 각 비율로 계산한 금원을 지급하라."
   - 소송비용 부담 + 가집행 선고 항목 별도 기재.

4. **청구원인(factsAndLaw)**: 다음 구조로 작성하며, 최소 1,500자 이상:
   - **1. 당사자 관계** — 원고와 피고가 어떤 관계인지
   - **2. 사실관계** — 시간순으로 핵심 사실 (계약 체결, 이행, 불이행 등). 날짜·금액·장소를 구체적으로
   - **3. 법적 근거** — 적용 법령 조항을 명시 (민법 § 390 채무불이행, 민법 § 750 불법행위, 상법 § 64 상사시효, 민법 § 408 분할채무 등)
   - **4. 결론 및 청구금액 산정** — 원금·이자·지연손해금 계산

5. **법령·판례 인용 정확성**: 추측하지 말고, 사실관계에 명백히 부합하는 조항만 인용합니다. 판례가 있다면 사건번호(예: '대법원 2019다204876 판결')만 인용하고, 없다면 인용하지 마십시오.

6. **입증방법(evidence)**: 사실관계상 합리적으로 존재할 증거를 '갑 제1호증', '갑 제2호증' 순으로 나열합니다. 각 증거의 입증취지를 한 문장으로 명시.

7. **관할법원**: 민사소송법 §§ 2~25에 따라 정확히 판단합니다:
   - 원칙: 피고 주소지 관할법원 (§ 2)
   - 부동산: 부동산 소재지 (§ 20)
   - 의무이행지: 채권자 주소지 가능 (§ 8)
   - 소가에 따른 단독/합의 결정: 5억원 이하 → 단독, 초과 → 합의

8. **인지대·송달료 추정**(practicalNotes에): 인지대 = 소가 × 0.45% – 5,000원 (소가 1억 이하 기준), 송달료 = 당사자수 × 15회 × 5,200원 등 실무 기준.

# 출력 형식

JSON 스키마를 정확히 따릅니다. 모든 한국어 텍스트는 정식 문어체로 작성하고, 추측이나 가공된 정보는 포함하지 않습니다.`;

const ANSWER_SYSTEM_PROMPT = `당신은 30년 경력의 대한민국 민사 변호사입니다. 피고를 대리하여 법원에 제출할 정식 답변서(答辯書)를 작성합니다.

민사소송법 § 256(답변서 제출의무), § 257(무변론판결), 민사소송규칙 § 65를 엄격히 준수합니다.

# 작성 원칙

1. **30일 답변서 제출의무**: 답변서 미제출 시 무변론판결 위험이 있으므로 모든 청구원인에 대해 빠짐없이 인정/부인/부지를 명확히 합니다.

2. **법률문어 사용**: 정식 법률 문어체. 청구취지에 대한 답변은 "원고의 청구를 기각한다.", "소송비용은 원고가 부담한다." 형식.

3. **청구원인에 대한 답변(factsAndLaw)** — 최소 1,500자 이상, 다음 구조:
   - **1. 청구원인 사실에 대한 답변**: 원고가 주장하는 각 사실에 대해 항목별로 인정(자인) / 부인(부인) / 부지(알지 못함) / 침묵 명시
   - **2. 항변사항** — 가능한 항변을 빠짐없이 검토:
     - 소멸시효 (민법 § 162 일반시효 10년, 상법 § 64 상사시효 5년)
     - 변제·공탁·상계 (민법 §§ 460-498)
     - 동시이행항변 (민법 § 536)
     - 후발적 불능 (민법 § 537)
     - 불법행위 시효 — 안 날로부터 3년, 발생일로부터 10년 (민법 § 766)
     - 약관규제법상 무효 항변
   - **3. 결어**: "이상과 같은 이유로 원고의 청구는 이유 없으므로 기각되어야 합니다."

4. **사건번호(caseNumber)** 필수: 원고가 제기한 사건의 사건번호를 정확히 기재. 사용자가 입력한 값을 그대로 사용.

5. **입증방법**: 피고측 증거이므로 '을 제1호증', '을 제2호증' 형식.

6. **관할법원**: 답변서는 원고가 소를 제기한 법원에 제출하므로, 그 법원을 그대로 기재.

7. **실무 메모(practicalNotes)**: 답변서 제출기한, 추가 증거 확보 우선순위, 반소(反訴) 가능성, 조정·화해 검토 등.

# 출력 형식

JSON 스키마를 정확히 따릅니다.`;

const STRICT_JSON_SUFFIX = `\n\n중요: 반드시 스키마에 부합하는 유효한 JSON만 출력하십시오. 마크다운 코드 펜스 금지. 서두·후미 설명 금지. 첫 글자는 {, 마지막 글자는 }여야 합니다.`;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

function isParseFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("could not parse") ||
    m.includes("did not match schema") ||
    m.includes("no object generated") ||
    m.includes("validation failed") ||
    m.includes("failed to generate json")
  );
}

function formatPartyForPrompt(
  role: "원고" | "피고",
  p: CivilDraftInput["plaintiff"],
): string {
  const lines = [
    `[${role}]`,
    `  - 이름: ${p.name}`,
    `  - ${p.idLabel}: ${p.idNumber}`,
    `  - 주소: ${p.address}`,
  ];
  if (p.contact) lines.push(`  - 연락처: ${p.contact}`);
  if (p.representative) lines.push(`  - 대표자/대리인: ${p.representative}`);
  return lines.join("\n");
}

function buildUserPrompt(input: CivilDraftInput): string {
  const lines: string[] = [];
  lines.push(`# 사건 정보`);
  lines.push(`- 문서 유형: ${input.documentType === "complaint" ? "소장" : "답변서"}`);
  lines.push(`- 청구 유형: ${input.claimCategory}`);
  if (input.claimAmountKrw !== undefined) {
    lines.push(`- 청구 금액: ${input.claimAmountKrw.toLocaleString("ko-KR")}원`);
  }
  if (input.documentType === "answer" && input.caseNumber) {
    lines.push(`- 사건번호: ${input.caseNumber}`);
  }
  if (input.preferredCourt) {
    lines.push(`- 희망 관할법원: ${input.preferredCourt}`);
  }
  lines.push("");
  lines.push(formatPartyForPrompt("원고", input.plaintiff));
  lines.push("");
  lines.push(formatPartyForPrompt("피고", input.defendant));
  lines.push("");
  lines.push(`# 사실관계 (의뢰인 제공)`);
  lines.push(input.caseFacts);
  if (input.legalBasis) {
    lines.push("");
    lines.push(`# 법적 근거 / 적용 법령 (의뢰인 메모)`);
    lines.push(input.legalBasis);
  }
  if (input.citedPrecedents) {
    lines.push("");
    lines.push(`# 참고 판례 (의뢰인 메모)`);
    lines.push(input.citedPrecedents);
  }
  lines.push("");
  lines.push(
    input.documentType === "complaint"
      ? "위 사실관계를 바탕으로 정식 소장을 작성하십시오. 모든 필드를 누락 없이 채워야 합니다."
      : "위 정보를 바탕으로 피고를 대리한 답변서를 작성하십시오. 청구원인에 대한 답변과 항변을 빠짐없이 기재해야 합니다.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

export async function draftCivilDocument(
  input: CivilDraftInput,
  modelId?: string,
  clientSignal?: AbortSignal,
): Promise<CivilDraft> {
  const systemPrompt =
    input.documentType === "complaint"
      ? COMPLAINT_SYSTEM_PROMPT
      : ANSWER_SYSTEM_PROMPT;

  const userPrompt = buildUserPrompt(input);

  const model = modelId
    ? (resolveModelForUse(modelId) ?? safeModelId(modelId))
    : EXTRACTION_MODEL;

  const abortSignal = clientSignal
    ? anySignal([clientSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  const callOnce = (sys: string) =>
    generateObject({
      model,
      schema: CivilDraftSchema,
      system: sys,
      prompt: userPrompt,
      abortSignal,
      maxOutputTokens: 8192,
      temperature: 0,
    });

  try {
    const result = await callOnce(systemPrompt);
    return result.object as CivilDraft;
  } catch (err) {
    if (
      isParseFailure(err) &&
      !(err instanceof DOMException && err.name === "AbortError")
    ) {
      const result = await callOnce(systemPrompt + STRICT_JSON_SUFFIX);
      return result.object as CivilDraft;
    }
    throw err;
  }
}
