"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
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
  const { setBestBranch, currentCaseId } = useCases();
  const [showDetails, setShowDetails] = React.useState(false);

  if (branch.status === "pending") {
    return (
      <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
          <span>
            {modelShortName(branch.modelId)} · {t("thinking")}
          </span>
          <ElapsedCounter startedAt={branch.startedAt} />
        </div>
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
      {/* Summary card with "mark best" button */}
      {branch.summary && (
        <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3.5 text-[14px] leading-relaxed text-slate-800 shadow-sm">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
              {modelShortName(branch.modelId)} · {t("answerSummary")}
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

      {/* Expandable full details */}
      {branch.elements && turn.narrative && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            {showDetails ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                {t("hideDetails")}
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                {t("viewDetails")}
              </>
            )}
          </button>
          {showDetails && (
            <div className="mt-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <CaseDashboard
                caseFileId={`${turn.id}:${branch.modelId}:${locale}`}
                narrative={turn.narrative}
                elements={branch.elements}
                matches={matches}
              />
            </div>
          )}
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
