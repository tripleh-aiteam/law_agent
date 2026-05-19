"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import type { PrecedentMatch } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

function ScoreChip({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  // value is assumed 0..1; render as percentage for readability.
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
      title={`${label}: ${pct}%`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{pct}%</span>
    </div>
  );
}

function ResultCard({ match }: { match: PrecedentMatch }) {
  const t = useTranslations("results");
  const [showWhy, setShowWhy] = React.useState(false);

  const { precedent, scores, verified } = match;
  // 3-tier citability with backward-compat fallback for old boolean-only data.
  const tier: "strong" | "supporting" | "weak" =
    match.citability ?? (match.citable ? "supporting" : "weak");
  const isStrong = tier === "strong";
  const isSupporting = tier === "supporting";
  const isWeak = tier === "weak";

  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="font-serif text-lg leading-snug">
              {precedent.caseTitle}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                <span className="text-muted-foreground/70">
                  {t("caseNumber")}:
                </span>{" "}
                <span className="font-mono">{precedent.caseNumber}</span>
              </span>
              <span aria-hidden>·</span>
              <span>
                <span className="text-muted-foreground/70">{t("court")}:</span>{" "}
                {precedent.court}
              </span>
              <span aria-hidden>·</span>
              <span>
                <span className="text-muted-foreground/70">
                  {t("decisionDate")}:
                </span>{" "}
                <span className="tabular-nums">{precedent.decisionDate}</span>
              </span>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
            <Badge
              variant={isStrong ? "success" : isSupporting ? "warning" : "secondary"}
              className="gap-1"
            >
              {isWeak ? (
                <ShieldAlert className="h-3 w-3" aria-hidden />
              ) : (
                <ShieldCheck className="h-3 w-3" aria-hidden />
              )}
              {isStrong
                ? t("citabilityStrong")
                : isSupporting
                  ? t("citabilitySupporting")
                  : t("citabilityWeak")}
            </Badge>
            <Badge
              variant={verified ? "success" : "warning"}
              className="gap-1"
            >
              {verified ? (
                <CheckCircle2 className="h-3 w-3" aria-hidden />
              ) : (
                <AlertTriangle className="h-3 w-3" aria-hidden />
              )}
              {verified ? t("verified") : t("unverified")}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ScoreChip label={t("embeddingScore")} value={scores.embedding} />
          <ScoreChip label={t("elementScore")} value={scores.elementOverlap} />
          <ScoreChip label={t("finalScore")} value={scores.final} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-0">
        <section className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("holding")}
          </h3>
          <p className="font-serif text-sm leading-relaxed text-foreground">
            {precedent.holding}
          </p>
        </section>

        <section className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("summary")}
          </h3>
          <p className="text-sm leading-relaxed text-foreground/90">
            {precedent.summary}
          </p>
        </section>

        {isWeak && match.citabilityReason && (
          <div className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
            <span className="font-medium">⚠ {t("citabilityWeak")}: </span>
            {match.citabilityReason}
          </div>
        )}
        {isSupporting && match.citabilityReason && (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-200">
            <span className="font-medium">📎 {t("citabilitySupporting")}: </span>
            {match.citabilityReason}
          </div>
        )}

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showWhy}
            aria-controls={`why-${precedent.caseNumber}`}
            onClick={() => setShowWhy((v) => !v)}
            className="-ml-2 gap-1.5"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                showWhy && "rotate-180",
              )}
              aria-hidden
            />
            {t("whyMatches")}
          </Button>
          {precedent.sourceUrl && (
            <a
              href={precedent.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t("viewSource")}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
        </div>

        {showWhy && (
          <div
            id={`why-${precedent.caseNumber}`}
            className="space-y-3 rounded-md border bg-muted/30 p-3"
          >
            {match.whyMatches && (
              <p className="text-sm leading-relaxed text-foreground">
                {match.whyMatches}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-md border bg-background p-3">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                  {t("matchingFacts")}
                </h4>
                {match.matchingFacts && match.matchingFacts.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-sm text-foreground/90">
                    {match.matchingFacts.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">—</p>
                )}
              </div>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-destructive">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  {t("distinguishingFacts")}
                </h4>
                {match.distinguishingFacts &&
                match.distinguishingFacts.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-sm text-foreground/90">
                    {match.distinguishingFacts.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">—</p>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ResultsList({ matches }: { matches: PrecedentMatch[] }) {
  const t = useTranslations("results");

  if (!matches || matches.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("noResults")}
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-4" aria-label={t("title")}>
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{t("title")}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {matches.length}
        </span>
      </header>
      <ol className="space-y-4">
        {matches.map((m, i) => (
          <li key={`${m.precedent.caseNumber}-${i}`}>
            <ResultCard match={m} />
          </li>
        ))}
      </ol>
    </section>
  );
}
