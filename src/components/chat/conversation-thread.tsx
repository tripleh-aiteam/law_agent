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
  User,
  XCircle,
} from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { ResultsList } from "@/components/results-list";
import { CaseDashboard } from "@/components/dashboard/case-dashboard";
import { cn } from "@/lib/utils";
import type { CaseTurn } from "@/lib/types";

/**
 * Renders the current case as a Q→A→Q→A conversation thread (Manus-style).
 *
 * Each `CaseTurn` is one exchange: the user's question on top, the agent's
 * answer directly underneath. Loading / cancelled / errored turns keep the
 * question visible so the user always sees what they asked, even if the
 * answer never arrived. Oldest turn first; newest turn lives at the bottom
 * right above the input.
 *
 * Backward compat: if the case has no `turns` but has legacy
 * `elements`/`matches`/`questions`, we synthesize ONE "legacy" turn so
 * existing localStorage data still renders something useful.
 */
export function ConversationThread(): React.ReactElement | null {
  const t = useTranslations("chat");
  const { currentCase } = useCases();

  const turns = useEffectiveTurns(currentCase);
  const endRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll the latest turn into view whenever turns change.
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
  if (turns.length === 0) {
    return null;
  }

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
/* One turn                                                                    */
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
      {/* Question bubble — right-aligned, slate background, Q# badge. */}
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

      {/* Answer bubble — left-aligned, white background, status-driven body. */}
      <div className="flex">
        <div className="flex max-w-[92%] gap-3">
          <div className="mt-5 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
            <Sparkles className="h-full w-full p-1.5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <span>{t("agentAnswer")}</span>
              {turn.modelId && (
                <span className="font-mono text-[10px] text-slate-400">
                  · {shortModelLabel(turn.modelId)}
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
/* Answer body — status-aware                                                  */
/* -------------------------------------------------------------------------- */

function AnswerBody({ turn }: { turn: CaseTurn }): React.ReactElement {
  const t = useTranslations("chat");

  if (turn.status === "pending") {
    // MoA pending turns get a live agent-progress visualization. Everything
    // else gets the generic "Thinking..." loader.
    if (turn.moaProgress) {
      return <MoaProgressView progress={turn.moaProgress} />;
    }
    return (
      <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
          <span>{t("thinking")}</span>
        </div>
      </div>
    );
  }

  if (turn.status === "cancelled") {
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

  if (turn.status === "error") {
    return (
      <div className="rounded-2xl rounded-tl-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 shadow-sm">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <span>{t("errorTurn")}</span>
        </div>
        {turn.error && (
          <p className="mt-1 whitespace-pre-wrap text-[12px] text-rose-800">
            {turn.error}
          </p>
        )}
      </div>
    );
  }

  // status === "complete"
  return <AnswerComplete turn={turn} />;
}

function AnswerComplete({ turn }: { turn: CaseTurn }): React.ReactElement {
  const t = useTranslations("chat");
  const locale = useLocale() as "ko" | "en";
  const [showDetails, setShowDetails] = React.useState(false);

  const matches = turn.matches ?? [];
  const topMatches = matches.slice(0, 3);

  return (
    <div className="space-y-3">
      {/* MoA audit badge — only present when Mixture-of-Agents was used. */}
      {turn.moaCandidates && turn.moaCandidates.length > 0 && (
        <MoaAuditBadge candidates={turn.moaCandidates} />
      )}

      {/* Summary card — always shown for completed turns. */}
      {turn.summary && (
        <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3.5 text-[14px] leading-relaxed text-slate-800 shadow-sm">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
            {t("answerSummary")}
          </div>
          <p className="whitespace-pre-wrap">{turn.summary}</p>
        </div>
      )}

      {/* Top-3 matches block — compact list. Empty state is fine since the
          summary still gives the user something to read. */}
      {topMatches.length > 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
              {t("topMatches")}
            </div>
            <span className="text-[11px] text-slate-400">
              {matches.length}
            </span>
          </div>
          <ResultsList matches={topMatches} />
        </div>
      ) : (
        matches.length === 0 &&
        turn.elements && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[13px] text-slate-600">
            {t("noMatchesForTurn")}
          </div>
        )
      )}

      {/* Expandable details — full dashboard for power users. */}
      {turn.elements && turn.narrative && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
              "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
            )}
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
                caseFileId={`${turn.id}:${locale}`}
                narrative={turn.narrative}
                elements={turn.elements}
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
/* MoA live progress (shown while an MoA turn is pending)                      */
/* -------------------------------------------------------------------------- */

function MoaProgressView({
  progress,
}: {
  progress: NonNullable<CaseTurn["moaProgress"]>;
}): React.ReactElement {
  const t = useTranslations("chat");
  const { stage, candidates, aggregator } = progress;

  return (
    <div className="space-y-3 rounded-2xl rounded-tl-md border border-indigo-200 bg-gradient-to-br from-indigo-50/60 via-white to-violet-50/40 px-4 py-3.5 shadow-sm">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-indigo-700">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>
          {stage === "fanning_out"
            ? t("moaStageFanning")
            : stage === "aggregating"
              ? t("moaStageAggregating")
              : t("moaStageDone")}
        </span>
      </div>

      {/* N candidate cards, responsive grid. 1 col on mobile, 2 on tablet,
          up to 4 on desktop — works for any roster size from 1 to 4. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {candidates.map((c) => (
          <CandidateCard key={c.modelId} candidate={c} />
        ))}
      </div>

      {/* Arrow + aggregator card. Aggregator only appears when stage advances. */}
      {(aggregator || stage !== "fanning_out") && (
        <div className="flex items-center gap-2 pt-1">
          <div className="h-px flex-1 bg-indigo-200" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500">
            {t("moaSynthesizing")}
          </span>
          <div className="h-px flex-1 bg-indigo-200" />
        </div>
      )}
      {aggregator && <AggregatorCard aggregator={aggregator} />}
    </div>
  );
}

function CandidateCard({
  candidate,
}: {
  candidate: NonNullable<CaseTurn["moaProgress"]>["candidates"][number];
}): React.ReactElement {
  const t = useTranslations("chat");
  const elapsed = useElapsed(
    candidate.status === "running" ? candidate.startedAt : undefined,
  );
  const isRunning = candidate.status === "running";
  const isOk = candidate.status === "ok";
  const isFailed = candidate.status === "failed";

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-white px-3 py-2 text-[12px] transition-colors",
        isRunning && "border-indigo-300 shadow-sm",
        isOk && "border-emerald-300 bg-emerald-50/60",
        isFailed && "border-rose-300 bg-rose-50/60",
      )}
    >
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500"
            aria-hidden
          />
        ) : isOk ? (
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-emerald-600"
            aria-hidden
          />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">
            {shortModelLabel(candidate.modelId)}
          </div>
          <div className="truncate text-[10px] text-slate-500">
            {isRunning
              ? t("moaRunning", { sec: elapsed })
              : isOk
                ? t("moaDone")
                : t("moaFailed")}
          </div>
        </div>
      </div>
      {/* Subtle progress bar while running. */}
      {isRunning && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-indigo-400/60" />
      )}
    </div>
  );
}

function AggregatorCard({
  aggregator,
}: {
  aggregator: NonNullable<NonNullable<CaseTurn["moaProgress"]>["aggregator"]>;
}): React.ReactElement {
  const t = useTranslations("chat");
  const elapsed = useElapsed(
    aggregator.status === "running" ? aggregator.startedAt : undefined,
  );
  const isRunning = aggregator.status === "running";
  const isOk = aggregator.status === "ok";
  return (
    <div
      className={cn(
        "rounded-lg border bg-gradient-to-r px-3 py-2 text-[12px] transition-colors",
        isRunning
          ? "border-violet-300 from-violet-50 to-indigo-50 shadow-sm"
          : isOk
            ? "border-emerald-300 from-emerald-50 to-emerald-50/40"
            : "border-rose-300 from-rose-50 to-rose-50/40",
      )}
    >
      <div className="flex items-center gap-2">
        {isRunning ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-500"
            aria-hidden
          />
        ) : isOk ? (
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-emerald-600"
            aria-hidden
          />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">
            {t("moaAggregator")} · {shortModelLabel(aggregator.modelId)}
          </div>
          <div className="truncate text-[10px] text-slate-500">
            {isRunning
              ? t("moaRunning", { sec: elapsed })
              : isOk
                ? t("moaSynthesized")
                : aggregator.error ?? t("moaFailed")}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Updates every 250ms while `startedAt` is set, so the candidate/aggregator
 * cards show a live elapsed-time counter. Returns the elapsed seconds as
 * an integer string.
 */
function useElapsed(startedAt: number | undefined): string {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return "0";
  return Math.max(0, Math.floor((now - startedAt) / 1000)).toString();
}

/* -------------------------------------------------------------------------- */
/* MoA audit badge                                                             */
/* -------------------------------------------------------------------------- */

function MoaAuditBadge({
  candidates,
}: {
  candidates: NonNullable<CaseTurn["moaCandidates"]>;
}): React.ReactElement {
  const t = useTranslations("chat");
  const [open, setOpen] = React.useState(false);
  const okCount = candidates.filter((c) => c.status === "ok").length;
  const total = candidates.length;
  return (
    <div className="rounded-2xl rounded-tl-md border border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 px-3.5 py-2.5 text-[12px] text-indigo-900 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2"
      >
        <Sparkles className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
        <span className="font-semibold">
          {t("moaBadge", { ok: okCount, total })}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 text-indigo-500 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="mt-2 space-y-1 border-t border-indigo-200/60 pt-2">
          {candidates.map((c) => (
            <li
              key={c.modelId + (c.error ?? "")}
              className="flex items-start gap-2 text-[11px]"
            >
              {c.status === "ok" ? (
                <CheckCircle2
                  className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600"
                  aria-hidden
                />
              ) : (
                <XCircle
                  className="mt-0.5 h-3 w-3 shrink-0 text-rose-600"
                  aria-hidden
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-indigo-900">
                  {c.modelId}
                </div>
                {c.error && (
                  <div className="truncate text-[10px] text-rose-700">
                    {c.error}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function shortModelLabel(id: string): string {
  // "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Returns the turns we should render. If the case has any turns, use them
 * verbatim. Otherwise, synthesize a single "legacy" turn from the older
 * `questions`/`elements`/`matches` fields so users with old localStorage
 * data don't see a blank thread.
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
    // Synthesize one "legacy" turn. We attach the latest elements+matches to
    // the most-recent question so old users see their last result.
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
    if (synthetic.length === 0 && (currentCase.elements || currentCase.matches)) {
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
