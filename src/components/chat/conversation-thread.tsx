"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Loader2,
  Paperclip,
  Sparkles,
  Star,
  User,
  XCircle,
} from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { ResultsList } from "@/components/results-list";
import { CaseDashboard } from "@/components/dashboard/case-dashboard";
import { resolveModel } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { CaseTurn, TurnBranch } from "@/lib/types";

/**
 * Renders the current case as a Q→A→Q→A conversation thread (Manus-style),
 * where each A may have N parallel branches (one per model the user picked).
 * The user can switch between branches via tabs and star their preferred one.
 */
export function ConversationThread(): React.ReactElement | null {
  const t = useTranslations("chat");
  const { currentCase } = useCases();

  const turns = useEffectiveTurns(currentCase);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!turns.length) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, turns[turns.length - 1]?.status]);

  if (!currentCase) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 px-6 py-12 text-center text-sm text-slate-500">
        {t("emptyThread")}
      </div>
    );
  }
  if (turns.length === 0) return null;

  return (
    <ol className="space-y-6" aria-label={t("yourQuestion")}>
      {turns.map((turn, i) => (
        <li key={turn.id}>
          <TurnView turn={turn} index={i} />
        </li>
      ))}
      <div ref={endRef} aria-hidden />
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* One turn — Q on the right, A on the left                                    */
/* -------------------------------------------------------------------------- */

function TurnView({
  turn,
  index,
}: {
  turn: CaseTurn;
  index: number;
}): React.ReactElement {
  const t = useTranslations("chat");
  return (
    <div className="space-y-3">
      {/* Question bubble */}
      <div className="flex justify-end">
        <div className="flex max-w-[85%] gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-end gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <span>{t("yourQuestion")}</span>
              <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[11px] font-bold text-white">
                Q{index + 1}
              </span>
            </div>
            <div className="rounded-2xl rounded-tr-md border border-slate-200 bg-slate-50 px-4 py-3 text-[15px] font-semibold leading-snug text-slate-900 shadow-sm">
              {turn.question || (
                <span className="italic text-slate-500">
                  (
                  {turn.attachmentNames?.length
                    ? turn.attachmentNames.join(", ")
                    : "—"}
                  )
                </span>
              )}
              {turn.attachmentNames && turn.attachmentNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {turn.attachmentNames.map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700"
                    >
                      <Paperclip className="h-3 w-3" aria-hidden />
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="mt-5 h-7 w-7 shrink-0 rounded-full bg-slate-900 text-white">
            <User className="h-full w-full p-1.5" aria-hidden />
          </div>
        </div>
      </div>

      {/* Answer bubble */}
      <div className="flex">
        <div className="flex w-full max-w-[92%] gap-3">
          <div className="mt-5 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
            <Sparkles className="h-full w-full p-1.5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <span>{t("agentAnswer")}</span>
              {turn.branches && turn.branches.length > 1 && (
                <span className="text-[10px] text-indigo-600">
                  · {t("nModelsComparing", { count: turn.branches.length })}
                </span>
              )}
            </div>
            <AnswerBody turn={turn} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Answer body — branched (tabs) when multi-model, else single                 */
/* -------------------------------------------------------------------------- */

function AnswerBody({ turn }: { turn: CaseTurn }): React.ReactElement {
  const branches = turn.branches ?? [];

  // Empty branches (legacy turn or unexpected state) — render flat error.
  if (branches.length === 0) {
    return <LegacyAnswerBody turn={turn} />;
  }
  return <BranchedAnswerBody turn={turn} branches={branches} />;
}

function BranchedAnswerBody({
  turn,
  branches,
}: {
  turn: CaseTurn;
  branches: TurnBranch[];
}): React.ReactElement {
  // Default selected tab = best-marked branch, or first complete one, or
  // first branch (e.g. while everything is still pending).
  const [activeId, setActiveId] = React.useState<string>(() => {
    const best = turn.bestBranchModelId
      ? branches.find((b) => b.modelId === turn.bestBranchModelId)
      : undefined;
    const firstComplete = branches.find((b) => b.status === "complete");
    return (best ?? firstComplete ?? branches[0]).modelId;
  });

  // If branches list changes (e.g. a branch finishes), keep the current
  // selection if still present; otherwise re-pick.
  React.useEffect(() => {
    if (!branches.some((b) => b.modelId === activeId)) {
      const best = turn.bestBranchModelId
        ? branches.find((b) => b.modelId === turn.bestBranchModelId)
        : undefined;
      const firstComplete = branches.find((b) => b.status === "complete");
      setActiveId((best ?? firstComplete ?? branches[0]).modelId);
    }
  }, [branches, turn.bestBranchModelId, activeId]);

  const active = branches.find((b) => b.modelId === activeId) ?? branches[0];

  return (
    <div className="space-y-3">
      {/* Tab strip — one tab per branch with status icon + elapsed counter */}
      {branches.length > 1 && (
        <BranchTabs
          branches={branches}
          activeId={activeId}
          onSelect={setActiveId}
          bestBranchModelId={turn.bestBranchModelId}
        />
      )}

      {/* Body for the active branch */}
      <BranchBody turn={turn} branch={active} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tab strip                                                                   */
/* -------------------------------------------------------------------------- */

function BranchTabs({
  branches,
  activeId,
  onSelect,
  bestBranchModelId,
}: {
  branches: TurnBranch[];
  activeId: string;
  onSelect: (id: string) => void;
  bestBranchModelId?: string;
}): React.ReactElement {
  return (
    <div
      role="tablist"
      className="flex flex-wrap items-stretch gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm"
    >
      {branches.map((b) => {
        const isActive = b.modelId === activeId;
        const isBest = b.modelId === bestBranchModelId;
        return (
          <button
            key={b.modelId}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(b.modelId)}
            className={cn(
              "group inline-flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors",
              isActive
                ? "bg-slate-900 text-white"
                : "text-slate-700 hover:bg-slate-100",
            )}
          >
            <BranchStatusIcon branch={b} active={isActive} />
            <span className="max-w-[140px] truncate">
              {modelShortName(b.modelId)}
            </span>
            {isBest && (
              <Star
                className={cn(
                  "h-3 w-3 shrink-0 fill-current",
                  isActive ? "text-amber-300" : "text-amber-500",
                )}
                aria-hidden
              />
            )}
            {b.status === "pending" && (
              <ElapsedCounter startedAt={b.startedAt} small />
            )}
          </button>
        );
      })}
    </div>
  );
}

function BranchStatusIcon({
  branch,
  active,
}: {
  branch: TurnBranch;
  active: boolean;
}): React.ReactElement {
  const cls = active ? "text-white" : "";
  if (branch.status === "pending") {
    return (
      <Loader2
        className={cn("h-3 w-3 shrink-0 animate-spin", cls || "text-indigo-500")}
        aria-hidden
      />
    );
  }
  if (branch.status === "complete") {
    return (
      <CheckCircle2
        className={cn("h-3 w-3 shrink-0", cls || "text-emerald-600")}
        aria-hidden
      />
    );
  }
  if (branch.status === "cancelled") {
    return (
      <XCircle
        className={cn("h-3 w-3 shrink-0", cls || "text-amber-600")}
        aria-hidden
      />
    );
  }
  return (
    <AlertTriangle
      className={cn("h-3 w-3 shrink-0", cls || "text-rose-600")}
      aria-hidden
    />
  );
}

function ElapsedCounter({
  startedAt,
  small,
}: {
  startedAt: number | undefined;
  small?: boolean;
}): React.ReactElement | null {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className={cn("opacity-75", small ? "text-[10px]" : "text-[11px]")}>
      {s}s
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Branch body — single branch's full answer                                   */
/* -------------------------------------------------------------------------- */

function BranchBody({
  turn,
  branch,
}: {
  turn: CaseTurn;
  branch: TurnBranch;
}): React.ReactElement {
  const t = useTranslations("chat");
  const locale = useLocale() as "ko" | "en";
  const { setBestBranch, currentCaseId, currentCase } = useCases();
  const [downloadOpen, setDownloadOpen] = React.useState(false);
  const downloadMenuRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!downloadOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!downloadMenuRef.current?.contains(e.target as Node)) {
        setDownloadOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [downloadOpen]);

  if (branch.status === "pending") {
    // Manus is an autonomous agent — its tasks take MINUTES, not seconds.
    // Surface that expectation so users don't think the app froze.
    const isManusBranch = resolveModel(branch.modelId).family === "manus";
    return (
      <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
          <span>
            {modelShortName(branch.modelId)} · {t("thinking")}
          </span>
          <ElapsedCounter startedAt={branch.startedAt} />
        </div>
        {isManusBranch && (
          <p className="mt-1.5 text-[12px] text-purple-700">
            {t("manusSlowHint")}
          </p>
        )}
      </div>
    );
  }

  if (branch.status === "cancelled") {
    return (
      <div className="rounded-2xl rounded-tl-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-sm">
        <div className="flex items-center gap-2 font-medium">
          <XCircle className="h-4 w-4" aria-hidden />
          <span>{t("stopped")}</span>
        </div>
        <p className="mt-1 text-[13px] text-amber-800">{t("stopExplain")}</p>
      </div>
    );
  }

  if (branch.status === "error") {
    return (
      <div className="rounded-2xl rounded-tl-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 shadow-sm">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <span>
            {modelShortName(branch.modelId)} · {t("errorTurn")}
          </span>
        </div>
        {branch.error && (
          <p className="mt-1 whitespace-pre-wrap text-[12px] text-rose-800">
            {branch.error}
          </p>
        )}
      </div>
    );
  }

  // status === "complete"
  const matches = branch.matches ?? [];
  const topMatches = matches.slice(0, 3);
  const isBest = turn.bestBranchModelId === branch.modelId;

  return (
    <div className="space-y-3">
      {/* Summary card with "mark best" + "download" buttons */}
      {branch.summary && (
        <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3.5 text-[14px] leading-relaxed text-slate-800 shadow-sm">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
              {modelShortName(branch.modelId)} · {t("answerSummary")}
            </div>
            <div className="flex items-center gap-1">
              <div className="relative" ref={downloadMenuRef}>
                <button
                  type="button"
                  onClick={() => setDownloadOpen((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-indigo-700"
                  title={t("downloadTooltip")}
                >
                  <Download className="h-3 w-3" aria-hidden />
                  {t("download")}
                  <ChevronDown className="h-3 w-3" aria-hidden />
                </button>
                {downloadOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 min-w-[260px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
                    <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      {modelShortName(branch.modelId)} —
                      모든 답변 (요약·상세·반대 측 논거 포함)
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setDownloadOpen(false);
                        downloadCaseAsWord(
                          currentCase,
                          turn,
                          branch,
                          branch.modelId,
                        );
                      }}
                      className="block w-full px-3 py-2 text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      📄 Word (.doc) — {modelShortName(branch.modelId)} only
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDownloadOpen(false);
                        downloadCaseAsPdf(
                          currentCase,
                          turn,
                          branch,
                          branch.modelId,
                        );
                      }}
                      className="block w-full px-3 py-2 text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      📕 PDF — {modelShortName(branch.modelId)} only
                    </button>
                    <div className="border-t border-slate-100" />
                    <button
                      type="button"
                      onClick={() => {
                        setDownloadOpen(false);
                        downloadCaseAsWord(currentCase, turn, branch, null);
                      }}
                      className="block w-full px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"
                    >
                      📄 Word — 모든 LLM 비교 / All models
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDownloadOpen(false);
                        downloadCaseAsPdf(currentCase, turn, branch, null);
                      }}
                      className="block w-full px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"
                    >
                      📕 PDF — 모든 LLM 비교 / All models
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  currentCaseId &&
                  setBestBranch(currentCaseId, turn.id, branch.modelId)
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                  isBest
                    ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                    : "text-slate-500 hover:bg-slate-100 hover:text-amber-700",
                )}
                title={isBest ? t("unmarkBest") : t("markBest")}
              >
                <Star
                  className={cn("h-3 w-3", isBest && "fill-amber-500")}
                  aria-hidden
                />
                {isBest ? t("bestAnswer") : t("markBest")}
              </button>
            </div>
          </div>
          <p className="whitespace-pre-wrap">{branch.summary}</p>
        </div>
      )}

      {/* Top-3 matches */}
      {topMatches.length > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
              {t("topMatches")}
            </div>
            <span className="text-[11px] text-slate-400">{matches.length}</span>
          </div>
          <ResultsList matches={topMatches} />
        </div>
      ) : (
        branch.elements && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[13px] text-slate-600">
            {t("noMatchesForTurn")}
          </div>
        )
      )}

      {/* Detailed analysis — always visible. The Hide/View toggle and
          Summary/Why tabs were removed at the user's request: the team
          wants the full long-form detailed analysis to be the default
          response shape. Summary / counter-args are still reachable via
          the action chips below the chat input. */}
      {branch.elements && turn.narrative && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <CaseDashboard
            caseFileId={`${turn.id}:${branch.modelId}:${locale}`}
            narrative={turn.narrative}
            elements={branch.elements}
            matches={matches}
          />
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Legacy fallback                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Renders a turn that has no `branches` field (predates the multi-model
 * refactor) using its legacy direct fields. Synthesizes a single branch
 * on the fly so the rendering code path stays consistent.
 */
function LegacyAnswerBody({ turn }: { turn: CaseTurn }): React.ReactElement {
  const legacyBranch: TurnBranch = {
    modelId: turn.modelId ?? "anthropic/claude-sonnet-4.6",
    status: turn.status,
    elements: turn.elements,
    summary: turn.summary,
    matches: turn.matches,
    error: turn.error,
  };
  return <BranchBody turn={turn} branch={legacyBranch} />;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function modelShortName(modelId: string): string {
  // Use the registry's displayName so the tab matches the selector.
  return resolveModel(modelId).displayName;
}

/** Minimal HTML escape so user-supplied text (model output, precedent
 *  fields, attachment names) can't break the document structure. */
function esc(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert newlines in plain text into <br> for Word rendering. */
function nl2br(s: string | undefined | null): string {
  return esc(s).replace(/\n/g, "<br>");
}

/**
 * Build a Microsoft Word document from a single branch's answer and
 * trigger a browser download. Uses the "HTML-as-Word" approach: we
 * emit an HTML body with MSO-compatible markup and serve it as
 * `application/msword` with a `.doc` extension. Word, 한컴 오피스, and
 * Google Docs all open it natively as a rich-text document the user
 * can edit and save-as-.docx if they want.
 *
 * No new dependencies — pure client-side blob, no docx library
 * required (would add ~600KB to the bundle for marginal quality gain).
 *
 * Filename pattern:
 *   law-agent_{model}_{YYYY-MM-DD}_{HH-MM}.doc
 */
/**
 * Bundle the case conversation into a Word .doc.
 *
 * `modelFilter`:
 *   - When set to a modelId, ONLY that model's branch from each turn is
 *     included — so a Llama 4 Scout download contains every Q + Llama's
 *     answer for every chip follow-up (사례 요약 · 상세 분석 · 반대 측
 *     예상 논거), and nothing from Sonnet / GPT.
 *   - When null, every branch from every model is included (the "All
 *     models" comparison export).
 */
function downloadCaseAsWord(
  caseObj: ReturnType<typeof useCases>["currentCase"],
  triggerTurn: CaseTurn,
  triggerBranch: TurnBranch,
  modelFilter: string | null,
): void {
  if (!caseObj) {
    downloadBranchAnswer(triggerTurn, triggerBranch);
    return;
  }
  const { html, filename } = buildFullConversationHtml(
    caseObj,
    ".doc",
    modelFilter,
  );
  const blob = new Blob([html], {
    type: "application/msword;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Open a printable rendering of the full case conversation in a new
 * window and trigger the browser's print dialog. The user picks
 * "Save as PDF" as the destination. No PDF library needed — every
 * modern browser exposes high-quality PDF rendering through its print
 * pipeline.
 *
 * Implementation note: we serve the HTML via a Blob URL rather than
 * `document.write` so the new window has a real document origin and
 * doesn't trip XSS/CSP heuristics.
 */
function downloadCaseAsPdf(
  caseObj: ReturnType<typeof useCases>["currentCase"],
  triggerTurn: CaseTurn,
  triggerBranch: TurnBranch,
  modelFilter: string | null,
): void {
  if (!caseObj) {
    downloadBranchAnswer(triggerTurn, triggerBranch);
    return;
  }
  const { html } = buildFullConversationHtml(caseObj, ".pdf", modelFilter);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "width=900,height=1100");
  if (!win) {
    alert(
      "팝업이 차단되었습니다. PDF 인쇄 창을 열기 위해 이 사이트의 팝업을 허용해 주세요. / Pop-ups blocked. Allow pop-ups for this site to use PDF export, or use Word download instead.",
    );
    URL.revokeObjectURL(url);
    return;
  }
  // Revoke the blob URL after the new window has had time to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Build the HTML for either a Word .doc download or a browser-print PDF
 * window. Both render the same content: every turn (Q + every branch's
 * answer + precedent matches), grouped per turn, oldest at top.
 */
function buildFullConversationHtml(
  caseObj: NonNullable<ReturnType<typeof useCases>["currentCase"]>,
  ext: ".doc" | ".pdf",
  modelFilter: string | null,
): { html: string; filename: string } {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const caseName = caseObj.nameKey ?? caseObj.name ?? "case";
  const sanitized = caseName.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60);
  const modelLabel = modelFilter ? resolveModel(modelFilter).displayName : null;
  const modelSlug = modelLabel
    ? modelLabel.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 30)
    : "all-models";
  const filename = `law-agent_${sanitized || "case"}_${modelSlug}_${stamp}${ext}`;

  const allTurns = caseObj.turns ?? [];

  const turnBlocks = allTurns
    .map((turn, idx) => {
      const rawBranches = turn.branches ?? [];
      // When the user picked one model, drop branches from other models so
      // the export is single-model (e.g. only Llama answers across every
      // Q + chip follow-up). Otherwise keep all branches for a side-by-side
      // comparison export.
      const branches = modelFilter
        ? rawBranches.filter((b) => b.modelId === modelFilter)
        : rawBranches;
      // If filtering and this turn has nothing for the chosen model, drop
      // the whole turn block — we don't want orphan Q's with no A.
      if (modelFilter && branches.length === 0) return "";
      const branchBlocks = branches
        .map((branch) => {
          const modelName = resolveModel(branch.modelId).displayName;
          const isBest = turn.bestBranchModelId === branch.modelId;
          const bestBadge = isBest
            ? `<span class="best-badge">⭐ Best</span>`
            : "";
          if (branch.status === "error") {
            return `
              <div class="branch error-branch">
                <div class="branch-head">${esc(modelName)} ${bestBadge}<span class="status-pill status-error">Error</span></div>
                <p class="error">${esc(branch.error ?? "")}</p>
              </div>`;
          }
          if (branch.status === "pending") {
            return `
              <div class="branch">
                <div class="branch-head">${esc(modelName)} ${bestBadge}<span class="status-pill status-pending">In progress</span></div>
              </div>`;
          }
          const matches = branch.matches ?? [];
          const matchBlocks =
            matches.length > 0
              ? `<h4>Precedents (${matches.length})</h4>` +
                matches
                  .map((m, i) => {
                    const p = m.precedent;
                    const tier = m.citability ?? (m.citable ? "supporting" : "weak");
                    const tierLabel =
                      tier === "strong"
                        ? "강한 권위 / Strong"
                        : tier === "supporting"
                          ? "참고 자료 / Supporting"
                          : "제한 적용 / Limited";
                    return `
                      <div class="precedent">
                        <div class="precedent-head">${i + 1}. ${esc(p.caseTitle)} <span class="citability citability-${tier}">${tierLabel}</span></div>
                        <div class="meta-row"><b>Case number:</b> ${esc(p.caseNumber)}</div>
                        <div class="meta-row"><b>Court:</b> ${esc(p.court)}</div>
                        <div class="meta-row"><b>Decision:</b> ${esc(p.decisionDate)}</div>
                        <p><b>Holding (판시사항):</b><br>${nl2br(p.holding)}</p>
                        <p><b>Summary (판결요지):</b><br>${nl2br(p.summary)}</p>
                        <p><b>Why it matches:</b><br>${nl2br(m.whyMatches)}</p>
                      </div>`;
                  })
                  .join("")
              : "";
          return `
            <div class="branch">
              <div class="branch-head">${esc(modelName)} ${bestBadge}</div>
              <div class="answer">${nl2br(branch.summary ?? "")}</div>
              ${matchBlocks}
            </div>`;
        })
        .join("");
      return `
        <section class="turn">
          <div class="q-head">Q${idx + 1} · ${esc(new Date(turn.createdAt).toLocaleString())}</div>
          <div class="q-text">${nl2br(turn.question)}</div>
          ${
            turn.attachmentNames && turn.attachmentNames.length > 0
              ? `<div class="attachments"><b>Attachments:</b> ${esc(turn.attachmentNames.join(", "))}</div>`
              : ""
          }
          ${branchBlocks}
        </section>`;
    })
    .join("");

  const printAutoTrigger =
    ext === ".pdf"
      ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},300)});</script>`
      : "";

  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>Law Agent — ${esc(caseName)}</title>
<style>
  @page { size: A4; margin: 0.9in; }
  body { font-family: "Calibri", "Malgun Gothic", "맑은 고딕", sans-serif; font-size: 11pt; color: #1a1a1a; }
  h1 { font-size: 22pt; margin: 0 0 4pt; color: #111; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt; color: #4f46e5; border-bottom: 1pt solid #ddd; padding-bottom: 4pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; color: #333; }
  h4 { font-size: 11pt; margin: 10pt 0 3pt; color: #555; }
  p { margin: 0 0 6pt; line-height: 1.55; }
  .doc-meta { color: #6b7280; font-size: 10pt; margin-bottom: 18pt; padding-bottom: 8pt; border-bottom: 1pt solid #e5e7eb; }
  .turn { margin-top: 22pt; padding-top: 10pt; border-top: 2pt solid #e5e7eb; page-break-inside: avoid; }
  .q-head { color: #6b7280; font-size: 10pt; margin-bottom: 4pt; }
  .q-text { font-size: 13pt; font-weight: 600; color: #0f172a; background: #f1f5f9; padding: 8pt 10pt; border-left: 3pt solid #4f46e5; margin-bottom: 12pt; white-space: pre-wrap; }
  .attachments { color: #475569; font-size: 10pt; margin-bottom: 8pt; }
  .branch { margin-bottom: 14pt; padding: 10pt 12pt; border: 1pt solid #e5e7eb; border-radius: 4pt; background: #fafbfc; page-break-inside: avoid; }
  .branch-head { color: #4f46e5; font-weight: 600; font-size: 11pt; margin-bottom: 6pt; }
  .best-badge { background: #fef3c7; color: #92400e; padding: 1pt 6pt; border-radius: 4pt; font-size: 9pt; margin-left: 6pt; }
  .status-pill { display: inline-block; padding: 1pt 6pt; border-radius: 999px; font-size: 9pt; margin-left: 6pt; }
  .status-error { background: #fee2e2; color: #991b1b; }
  .status-pending { background: #e0e7ff; color: #3730a3; }
  .answer { white-space: pre-wrap; line-height: 1.6; margin-bottom: 8pt; }
  .error { color: #991b1b; background: #fef2f2; padding: 6pt; border-radius: 4pt; }
  .precedent { margin: 8pt 0; padding: 8pt; border-left: 2pt solid #d1d5db; background: #ffffff; }
  .precedent-head { font-weight: 600; margin-bottom: 4pt; }
  .meta-row { font-size: 10pt; color: #475569; margin-bottom: 2pt; }
  .citability { display: inline-block; padding: 1pt 6pt; border-radius: 999px; font-size: 9pt; font-weight: bold; margin-left: 4pt; }
  .citability-strong { background: #d1fae5; color: #065f46; }
  .citability-supporting { background: #fef3c7; color: #92400e; }
  .citability-weak { background: #f3f4f6; color: #6b7280; }
</style>
</head>
<body>
  <h1>Law Agent — ${esc(caseName)}</h1>
  <div class="doc-meta">
    <div><b>Generated:</b> ${esc(now.toLocaleString())}</div>
    <div><b>Total questions:</b> ${allTurns.length}</div>
    <div><b>Model scope:</b> ${esc(modelLabel ?? "All models (comparison)")}</div>
    <div><b>Includes:</b> 사례 요약 / 상세 분석 / 반대 측 예상 논거 / 적용 법령 — every Q + the selected model's answer.</div>
  </div>
  ${turnBlocks}
  ${printAutoTrigger}
</body>
</html>`;

  return { html, filename };
}

function downloadBranchAnswer(turn: CaseTurn, branch: TurnBranch): void {
  const modelName = resolveModel(branch.modelId).displayName;
  const sanitizedModel = modelName
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const filename = `law-agent_${sanitizedModel}_${stamp}.doc`;

  const matches = branch.matches ?? [];

  const matchBlocks = matches
    .map((m, i) => {
      const p = m.precedent;
      const tier = m.citability ?? (m.citable ? "supporting" : "weak");
      const tierClass = `citability-${tier}`;
      const tierLabel =
        tier === "strong"
          ? "강한 권위 / Strong authority"
          : tier === "supporting"
            ? "참고 자료 / Supporting"
            : "제한 적용 / Limited";
      return `
        <h3>${i + 1}. ${esc(p.caseTitle)}</h3>
        <table>
          <tr><th>Case number</th><td>${esc(p.caseNumber)}</td></tr>
          <tr><th>Court</th><td>${esc(p.court)}</td></tr>
          <tr><th>Decision date</th><td>${esc(p.decisionDate)}</td></tr>
          <tr><th>Citability</th><td><span class="citability ${tierClass}">${tierLabel}</span></td></tr>
          <tr><th>Final score</th><td>${Math.round(m.scores.final * 100)}%</td></tr>
        </table>
        <p><b>Holding (판시사항):</b><br>${nl2br(p.holding)}</p>
        <p><b>Summary (판결요지):</b><br>${nl2br(p.summary)}</p>
        <p><b>Why it matches:</b><br>${nl2br(m.whyMatches)}</p>
      `;
    })
    .join("");

  // MSO namespace declarations + a small set of styles that Word
  // (and 한컴) renders cleanly. Korean font fallback is included so
  // CJK characters render correctly in Word on Windows / Mac.
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>Law Agent — ${esc(modelName)}</title>
<style>
  @page { size: A4; margin: 1in; }
  body { font-family: "Calibri", "Malgun Gothic", "맑은 고딕", sans-serif; font-size: 11pt; color: #1a1a1a; }
  h1 { font-size: 22pt; margin: 0 0 6pt; color: #111; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt; color: #4f46e5; border-bottom: 1pt solid #ddd; padding-bottom: 4pt; }
  h3 { font-size: 12pt; margin: 12pt 0 4pt; color: #333; }
  p { margin: 0 0 8pt; line-height: 1.55; }
  pre { background: #f8fafc; border: 1pt solid #e5e7eb; padding: 8pt; font-family: "Consolas", "맑은 고딕", monospace; font-size: 9.5pt; white-space: pre-wrap; }
  .meta { color: #6b7280; font-size: 10pt; margin-bottom: 12pt; }
  .meta-row { margin: 0 0 2pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; }
  th, td { border: 1pt solid #d1d5db; padding: 5pt 8pt; text-align: left; vertical-align: top; font-size: 10.5pt; }
  th { background: #f3f4f6; font-weight: bold; width: 28%; }
  .citability { display: inline-block; padding: 2pt 8pt; border-radius: 999px; font-size: 9pt; font-weight: bold; }
  .citability-strong { background: #d1fae5; color: #065f46; }
  .citability-supporting { background: #fef3c7; color: #92400e; }
  .citability-weak { background: #f3f4f6; color: #6b7280; }
</style>
</head>
<body>
  <h1>Law Agent — ${esc(modelName)}</h1>
  <div class="meta">
    <p class="meta-row"><b>Generated:</b> ${esc(now.toLocaleString())}</p>
    <p class="meta-row"><b>Question:</b> ${esc(turn.question || "(none)")}</p>
    ${
      turn.attachmentNames && turn.attachmentNames.length > 0
        ? `<p class="meta-row"><b>Attachments:</b> ${esc(turn.attachmentNames.join(", "))}</p>`
        : ""
    }
  </div>

  <h2>Summary</h2>
  <p>${nl2br(branch.summary ?? "(no summary)")}</p>

  ${
    matches.length > 0
      ? `<h2>Similar Precedents (${matches.length})</h2>${matchBlocks}`
      : ""
  }
</body>
</html>`;

  // Word recognises this MIME + .doc extension as a Word document and
  // opens it directly. The user can Save As .docx from Word's menu
  // for the modern format.
  const blob = new Blob([html], {
    type: "application/msword;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Returns the turns we should render. If the case has any turns, use them.
 * Otherwise synthesize one "legacy" turn from older fields so old
 * localStorage data still renders something.
 */
function useEffectiveTurns(
  currentCase: ReturnType<typeof useCases>["currentCase"],
): CaseTurn[] {
  return React.useMemo(() => {
    if (!currentCase) return [];
    if (currentCase.turns && currentCase.turns.length > 0) {
      return currentCase.turns;
    }
    const legacyQuestions = currentCase.questions ?? [];
    if (
      legacyQuestions.length === 0 &&
      !currentCase.elements &&
      !currentCase.matches
    ) {
      return [];
    }
    const synthetic: CaseTurn[] = legacyQuestions.map((q, i) => ({
      id: q.id,
      question: q.text,
      createdAt: q.createdAt,
      modelId: q.modelId,
      attachmentNames: q.attachmentNames,
      status: "complete",
      ...(i === legacyQuestions.length - 1
        ? {
            elements: currentCase.elements,
            matches: currentCase.matches,
            narrative: currentCase.narrative,
          }
        : {}),
    }));
    if (
      synthetic.length === 0 &&
      (currentCase.elements || currentCase.matches)
    ) {
      synthetic.push({
        id: `legacy-${currentCase.id}`,
        question: "",
        createdAt: currentCase.updatedAt,
        status: "complete",
        elements: currentCase.elements,
        matches: currentCase.matches,
        narrative: currentCase.narrative,
      });
    }
    return synthetic;
  }, [currentCase]);
}
