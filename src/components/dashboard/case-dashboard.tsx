"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import type { LegalElements, PrecedentMatch } from "@/lib/types";
import { useCases } from "@/components/cases/cases-context";

import { DetailedView, type DetailedPayload } from "./detailed-view";

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
 * Top-level dashboard — Detailed analysis only.
 *
 * The Summary / Why? tabs were removed at the user's request: their
 * team wants the long-form detailed analysis as the default response,
 * not a short summary. Summary can still be obtained explicitly by
 * clicking the "사례 요약" action chip (which fires a new turn).
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

function CaseDashboardFromContext({ fallback }: { fallback: CaseDashboardProps }): React.ReactElement {
  const { currentCase, selectedModelIds } = useCases();
  const modelId = selectedModelIds[0];
  return (
    <CaseDashboardBody
      caseFileId={currentCase?.id ?? fallback.caseFileId}
      narrative={currentCase?.narrative ?? fallback.narrative}
      elements={currentCase?.elements ?? fallback.elements}
      matches={currentCase?.matches ?? fallback.matches}
      modelId={modelId ?? undefined}
    />
  );
}

function CaseDashboardFromProps(props: CaseDashboardProps): React.ReactElement {
  return <CaseDashboardBody {...props} />;
}

type Locale = "ko" | "en";

type FetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "success"; data: T };

/** In-memory cache so re-renders don't refetch and locale changes invalidate cleanly. */
const detailedCache = new Map<string, DetailedPayload>();

function makeCacheKey(
  caseFileId: string | undefined,
  narrative: string | undefined,
  elements: LegalElements | undefined,
  locale: Locale,
): string {
  const idPart =
    caseFileId ?? hashShort(`${narrative ?? ""}|${JSON.stringify(elements ?? {})}`);
  return `${idPart}:${locale}`;
}

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
  modelId,
}: CaseDashboardProps & { modelId?: string }): React.ReactElement {
  const selectedModelId = modelId;
  const locale = useLocale() as Locale;
  const t = useTranslations("dashboard");

  const [detailed, setDetailed] = React.useState<FetchState<DetailedPayload>>({
    status: "idle",
  });

  const cacheKey = React.useMemo(
    () => makeCacheKey(caseFileId, narrative, elements, locale),
    [caseFileId, narrative, elements, locale],
  );

  React.useEffect(() => {
    const cached = detailedCache.get(cacheKey);
    setDetailed(cached ? { status: "success", data: cached } : { status: "idle" });
  }, [cacheKey]);

  const hasCase = Boolean(
    narrative && narrative.trim().length >= 10 && elements,
  );

  const fetchDetailed = React.useCallback(async (): Promise<void> => {
    if (!narrative || !elements) return;
    setDetailed({ status: "loading" });
    try {
      const res = await fetch("/api/case/detailed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          narrative,
          elements,
          locale,
          model: selectedModelId ?? undefined,
        }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({
          error: "Request failed",
        }))) as { error?: string };
        throw new Error(error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as DetailedPayload;
      detailedCache.set(cacheKey, json);
      setDetailed({ status: "success", data: json });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setDetailed({ status: "error", error: message });
    }
  }, [narrative, elements, locale, cacheKey, selectedModelId]);

  // Auto-fetch on mount + whenever the case/locale identity changes.
  // (Summary/Why tabs were removed so there's no lazy-load condition.)
  React.useEffect(() => {
    if (!hasCase) return;
    if (detailed.status === "idle") {
      void fetchDetailed();
    }
  }, [hasCase, detailed.status, fetchDetailed]);

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

  if (detailed.status === "loading" || detailed.status === "idle") {
    return <DetailedSkeleton />;
  }
  if (detailed.status === "error") {
    return <ErrorCard message={detailed.error} onRetry={fetchDetailed} />;
  }
  return <DetailedView data={detailed.data} />;
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
