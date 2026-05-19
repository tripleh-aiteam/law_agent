"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

import type { CitabilityTier, LegalElements, PrecedentMatch } from "@/lib/types";

/**
 * 3-tier citability badge.
 *   strong     → emerald "강한 권위 / Strong authority"
 *   supporting → amber   "참고 자료 / Supporting authority"
 *   weak       → slate   "제한 적용 / Limited applicability"
 * Falls back to the old boolean for any pre-tiered cached matches.
 */
function CitabilityBadge({
  match,
  tResults,
}: {
  match: PrecedentMatch;
  tResults: (key: string) => string;
}): React.ReactElement {
  const tier: CitabilityTier =
    match.citability ?? (match.citable ? "supporting" : "weak");
  if (tier === "strong") {
    return (
      <Badge variant="success">{tResults("citabilityStrong")}</Badge>
    );
  }
  if (tier === "supporting") {
    return (
      <Badge variant="warning">{tResults("citabilitySupporting")}</Badge>
    );
  }
  return <Badge variant="secondary">{tResults("citabilityWeak")}</Badge>;
}

interface WhyPayload {
  why: {
    reasoning: string;
    pairedMappings: Array<{ userFact: string; precedentFact: string; sameBecause: string }>;
    citationStrategy: string;
    distinguishingRisk: string;
  };
}

type Locale = "ko" | "en";

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "success"; data: WhyPayload };

interface WhyViewProps {
  narrative: string;
  elements: LegalElements;
  matches: PrecedentMatch[];
  locale: Locale;
  /** Stable cache key (caseId + locale) — used to scope the per-match cache. */
  cacheKey: string;
}

/** Per-match "why" cache: key = `${cacheKey}:${caseNumber}`. */
const whyCache = new Map<string, WhyPayload>();

export function WhyView({
  narrative,
  elements,
  matches,
  locale,
  cacheKey,
}: WhyViewProps): React.ReactElement | null {
  // Parent renders the empty state; here, nothing to show means nothing rendered.
  if (matches.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {matches.map((m, idx) => (
        <WhyAccordionItem
          key={`${m.precedent.caseNumber}-${idx}`}
          match={m}
          narrative={narrative}
          elements={elements}
          locale={locale}
          itemCacheKey={`${cacheKey}:${m.precedent.caseNumber}`}
          defaultOpen={idx === 0}
        />
      ))}
    </div>
  );
}

function WhyAccordionItem({
  match,
  narrative,
  elements,
  locale,
  itemCacheKey,
  defaultOpen,
}: {
  match: PrecedentMatch;
  narrative: string;
  elements: LegalElements;
  locale: Locale;
  itemCacheKey: string;
  defaultOpen: boolean;
}): React.ReactElement {
  const t = useTranslations("dashboard.why");
  const tResults = useTranslations("results");

  const [open, setOpen] = React.useState<boolean>(defaultOpen);
  const [state, setState] = React.useState<FetchState>(() => {
    const cached = whyCache.get(itemCacheKey);
    return cached ? { status: "success", data: cached } : { status: "idle" };
  });

  const fetchWhy = React.useCallback(async (): Promise<void> => {
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/case/why", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ narrative, elements, match, locale }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "Request failed" }))) as {
          error?: string;
        };
        throw new Error(error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as WhyPayload;
      whyCache.set(itemCacheKey, json);
      setState({ status: "success", data: json });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setState({ status: "error", error: message });
    }
  }, [narrative, elements, match, locale, itemCacheKey]);

  // Lazy-load when the item first opens.
  React.useEffect(() => {
    if (open && state.status === "idle") {
      void fetchWhy();
    }
  }, [open, state.status, fetchWhy]);

  const finalScorePct = Math.round((match.scores.final ?? 0) * 100);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/40"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm font-semibold text-foreground">
            {match.precedent.caseNumber}
          </span>
          <span className="text-xs text-muted-foreground">{match.precedent.court}</span>
          <span className="text-xs text-muted-foreground">{match.precedent.decisionDate}</span>
          <Badge variant="secondary" className="font-mono">
            {finalScorePct}
          </Badge>
          <CitabilityBadge match={match} tResults={tResults} />
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>

      {open && (
        <CardContent className="space-y-4 border-t bg-slate-50/40 p-5 dark:bg-slate-900/30">
          {state.status === "loading" || state.status === "idle" ? (
            <WhySkeleton />
          ) : state.status === "error" ? (
            <WhyError message={state.error} onRetry={fetchWhy} />
          ) : (
            <WhyBody data={state.data} t={t} />
          )}
        </CardContent>
      )}
    </Card>
  );
}

function WhyBody({
  data,
  t,
}: {
  data: WhyPayload;
  t: ReturnType<typeof useTranslations>;
}): React.ReactElement {
  const { reasoning, pairedMappings, citationStrategy, distinguishingRisk } = data.why;
  return (
    <div className="space-y-4">
      {/* Reasoning */}
      <section className="space-y-2">
        <FieldLabel>{t("reasoning")}</FieldLabel>
        <p className="text-sm leading-relaxed text-foreground">{reasoning}</p>
      </section>

      {/* Paired mappings — three-column grid, the headline visual */}
      <section className="space-y-2">
        <FieldLabel>{t("pairedMappings")}</FieldLabel>
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
          <div className="grid grid-cols-3 gap-0 border-b border-slate-200 bg-slate-100/70 text-xs font-medium uppercase tracking-wide text-muted-foreground dark:border-slate-800 dark:bg-slate-900/60">
            <div className="px-3 py-2">{t("userFactCol")}</div>
            <div className="border-l border-slate-200 px-3 py-2 dark:border-slate-800">
              {t("precedentFactCol")}
            </div>
            <div className="border-l border-slate-200 px-3 py-2 dark:border-slate-800">
              {t("sameBecauseCol")}
            </div>
          </div>
          {pairedMappings.map((p, idx) => (
            <div
              key={idx}
              className="grid grid-cols-3 gap-0 border-t border-slate-200 text-sm leading-relaxed first:border-t-0 dark:border-slate-800"
            >
              <div className="px-3 py-3 text-foreground">{p.userFact}</div>
              <div className="border-l border-slate-200 px-3 py-3 text-foreground dark:border-slate-800">
                {p.precedentFact}
              </div>
              <div className="border-l border-slate-200 px-3 py-3 text-muted-foreground dark:border-slate-800">
                {p.sameBecause}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Citation strategy — green callout */}
      <section className="space-y-2">
        <FieldLabel className="text-emerald-700 dark:text-emerald-300">
          {t("citationStrategy")}
        </FieldLabel>
        <div className="rounded-md border border-emerald-200 bg-emerald-50/70 p-3 text-sm leading-relaxed text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
          {citationStrategy}
        </div>
      </section>

      {/* Distinguishing risk — amber callout */}
      <section className="space-y-2">
        <FieldLabel className="text-amber-700 dark:text-amber-300">
          {t("distinguishingRisk")}
        </FieldLabel>
        <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-sm leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          {distinguishingRisk}
        </div>
      </section>
    </div>
  );
}

function WhySkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

function WhyError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  const td = useTranslations("dashboard");
  return (
    <div className="space-y-3 rounded-md border border-red-300 bg-red-50/40 p-3 dark:border-red-900/60 dark:bg-red-950/20">
      <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {td("error.retry")}
      </Button>
    </div>
  );
}

function FieldLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`text-xs font-medium uppercase tracking-wide text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
