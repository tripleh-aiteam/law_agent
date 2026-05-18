"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDown } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import type { LegalElements, PrecedentMatch } from "@/lib/types";
import { useCases } from "@/components/cases/cases-context";

import { SummaryView, type SummaryPayload } from "./summary-view";
import { DetailedView, type DetailedPayload } from "./detailed-view";
import { WhyView } from "./why-view";

export interface CaseDashboardProps {
  /** Stable id used as cache key. When omitted, the dashboard reads it from useCases(). */
  caseFileId?: string;
  /** Raw narrative the user submitted. Falls back to useCases().currentCase.narrative. */
  narrative?: string;
  /** Extracted Korean legal elements. Falls back to currentCase.elements. */
  elements?: LegalElements;
  /** Reranked + verified precedent matches. Falls back to currentCase.matches. */
  matches?: PrecedentMatch[];
}

/**
 * Top-level dashboard.
 *
 * Two integration paths:
 * 1. Inside <CasesProvider> with no props (Agent A's app shell): reads the
 *    currently-selected case from context.
 * 2. As a standalone component with explicit props: pass narrative + elements
 *    + matches directly. Useful for embedded previews / tests / pages not
 *    wrapped in <CasesProvider>.
 *
 * The branch is decided once by props presence so the React hooks rule is
 * preserved (no conditional hook calls inside a single function).
 */
export function CaseDashboard(props: CaseDashboardProps = {}): React.ReactElement {
  const hasExplicitProps = props.narrative !== undefined && props.elements !== undefined;
  return hasExplicitProps ? (
    <CaseDashboardFromProps {...props} />
  ) : (
    <CaseDashboardFromContext fallback={props} />
  );
}

export default CaseDashboard;

/* -------------------------------------------------------------------------- */
/* Context-driven path                                                         */
/* -------------------------------------------------------------------------- */

function CaseDashboardFromContext({ fallback }: { fallback: CaseDashboardProps }): React.ReactElement {
  const { currentCase } = useCases();
  return (
    <CaseDashboardBody
      caseFileId={currentCase?.id ?? fallback.caseFileId}
      narrative={currentCase?.narrative ?? fallback.narrative}
      elements={currentCase?.elements ?? fallback.elements}
      matches={currentCase?.matches ?? fallback.matches}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Props-driven path                                                           */
/* -------------------------------------------------------------------------- */

function CaseDashboardFromProps(props: CaseDashboardProps): React.ReactElement {
  return <CaseDashboardBody {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Body                                                                        */
/* -------------------------------------------------------------------------- */

type Locale = "ko" | "en";
type TabValue = "summary" | "detailed" | "why";

type FetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "success"; data: T };

/** In-memory cache so re-renders don't refetch and locale/case changes invalidate cleanly. */
const summaryCache = new Map<string, SummaryPayload>();
const detailedCache = new Map<string, DetailedPayload>();

function makeCacheKey(
  caseFileId: string | undefined,
  narrative: string | undefined,
  elements: LegalElements | undefined,
  locale: Locale
): string {
  const idPart = caseFileId ?? hashShort(`${narrative ?? ""}|${JSON.stringify(elements ?? {})}`);
  return `${idPart}:${locale}`;
}

/** Cheap non-cryptographic 32-bit hash so we don't pull in a dep. */
function hashShort(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function CaseDashboardBody({
  caseFileId,
  narrative,
  elements,
  matches,
}: CaseDashboardProps): React.ReactElement {
  const locale = useLocale() as Locale;
  const t = useTranslations("dashboard");

  const [tab, setTab] = React.useState<TabValue>("summary");
  const [summary, setSummary] = React.useState<FetchState<SummaryPayload>>({ status: "idle" });
  const [detailed, setDetailed] = React.useState<FetchState<DetailedPayload>>({ status: "idle" });

  const cacheKey = React.useMemo(
    () => makeCacheKey(caseFileId, narrative, elements, locale),
    [caseFileId, narrative, elements, locale]
  );

  // When the case identity (or locale) changes, restore cache or reset to idle.
  React.useEffect(() => {
    const cachedSummary = summaryCache.get(cacheKey);
    setSummary(cachedSummary ? { status: "success", data: cachedSummary } : { status: "idle" });
    const cachedDetailed = detailedCache.get(cacheKey);
    setDetailed(cachedDetailed ? { status: "success", data: cachedDetailed } : { status: "idle" });
  }, [cacheKey]);

  const hasCase = Boolean(
    narrative && narrative.trim().length >= 10 && elements
  );

  const fetchSummary = React.useCallback(async (): Promise<void> => {
    if (!narrative || !elements) return;
    setSummary({ status: "loading" });
    try {
      const res = await fetch("/api/case/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ narrative, elements, locale }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "Request failed" }))) as {
          error?: string;
        };
        throw new Error(error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as SummaryPayload;
      summaryCache.set(cacheKey, json);
      setSummary({ status: "success", data: json });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setSummary({ status: "error", error: message });
    }
  }, [narrative, elements, locale, cacheKey]);

  const fetchDetailed = React.useCallback(async (): Promise<void> => {
    if (!narrative || !elements) return;
    setDetailed({ status: "loading" });
    try {
      const res = await fetch("/api/case/detailed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ narrative, elements, locale }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "Request failed" }))) as {
          error?: string;
        };
        throw new Error(error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as DetailedPayload;
      detailedCache.set(cacheKey, json);
      setDetailed({ status: "success", data: json });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDetailed({ status: "error", error: message });
    }
  }, [narrative, elements, locale, cacheKey]);

  // Lazy-load: fire the network call the first time a tab is opened with data ready.
  React.useEffect(() => {
    if (!hasCase) return;
    if (tab === "summary" && summary.status === "idle") {
      void fetchSummary();
    }
    if (tab === "detailed" && detailed.status === "idle") {
      void fetchDetailed();
    }
  }, [tab, hasCase, summary.status, detailed.status, fetchSummary, fetchDetailed]);

  if (!hasCase) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">
            {t("empty.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{t("empty.body")}</span>
          <ArrowDown className="h-4 w-4 shrink-0" aria-hidden />
        </CardContent>
      </Card>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="summary">📊 {t("tabs.summary")}</TabsTrigger>
        <TabsTrigger value="detailed">📑 {t("tabs.detailed")}</TabsTrigger>
        <TabsTrigger value="why">💡 {t("tabs.why")}</TabsTrigger>
      </TabsList>

      <TabsContent value="summary" className="mt-4">
        {summary.status === "loading" || summary.status === "idle" ? (
          <SummarySkeleton />
        ) : summary.status === "error" ? (
          <ErrorCard message={summary.error} onRetry={fetchSummary} />
        ) : (
          <SummaryView data={summary.data} />
        )}
      </TabsContent>

      <TabsContent value="detailed" className="mt-4">
        {detailed.status === "loading" || detailed.status === "idle" ? (
          <DetailedSkeleton />
        ) : detailed.status === "error" ? (
          <ErrorCard message={detailed.error} onRetry={fetchDetailed} />
        ) : (
          <DetailedView data={detailed.data} />
        )}
      </TabsContent>

      <TabsContent value="why" className="mt-4">
        <WhyView
          narrative={narrative!}
          elements={elements!}
          matches={matches ?? []}
          locale={locale}
          cacheKey={cacheKey}
        />
      </TabsContent>
    </Tabs>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading / error subviews                                                    */
/* -------------------------------------------------------------------------- */

function SummarySkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-3/4" />
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function DetailedSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  const t = useTranslations("dashboard");
  return (
    <Card className="border-red-300 bg-red-50/40 dark:border-red-900/60 dark:bg-red-950/20">
      <CardHeader>
        <CardTitle className="text-base text-red-700 dark:text-red-300">
          {t("error.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("error.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
