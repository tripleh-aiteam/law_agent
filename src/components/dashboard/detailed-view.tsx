"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Lightbulb } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export interface DetailedPayload {
  detailed: {
    factPattern: string;
    legalAnalysis: string;
    applicableStatutes: Array<{ citation: string; why: string }>;
    strategicNotes: string;
    openQuestions: string[];
  };
}

export function DetailedView({ data }: { data: DetailedPayload }): React.ReactElement {
  const t = useTranslations("dashboard.detailed");
  const { factPattern, legalAnalysis, applicableStatutes, strategicNotes, openQuestions } =
    data.detailed;

  return (
    <div className="space-y-4">
      {/* Fact pattern — formal serif paragraph */}
      <Card className="border-slate-200">
        <CardContent className="space-y-2 p-5">
          <FieldLabel>{t("factPattern")}</FieldLabel>
          <p className="font-serif text-base leading-relaxed text-foreground">
            {factPattern}
          </p>
        </CardContent>
      </Card>

      {/* Legal analysis — prose, whitespace preserved */}
      <Card>
        <CardContent className="space-y-2 p-5">
          <FieldLabel>{t("legalAnalysis")}</FieldLabel>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {legalAnalysis}
          </p>
        </CardContent>
      </Card>

      {/* Applicable statutes — table */}
      {applicableStatutes.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <FieldLabel>{t("applicableStatutes")}</FieldLabel>
            <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-muted-foreground dark:bg-slate-900/60">
                  <tr>
                    <th className="w-1/3 px-3 py-2 font-medium">{t("statuteCitation")}</th>
                    <th className="px-3 py-2 font-medium">{t("statuteWhy")}</th>
                  </tr>
                </thead>
                <tbody>
                  {applicableStatutes.map((s, idx) => (
                    <tr
                      key={`${s.citation}-${idx}`}
                      className="border-t border-slate-200 align-top dark:border-slate-800"
                    >
                      <td className="px-3 py-3">
                        <Badge
                          variant="outline"
                          className="border-slate-300 bg-white font-medium dark:border-slate-700 dark:bg-slate-900"
                        >
                          {s.citation}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 leading-relaxed text-foreground">{s.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Strategic notes — highlighted callout */}
      <Card className="border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/20">
        <CardContent className="flex items-start gap-3 p-5">
          <Lightbulb
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300"
            aria-hidden
          />
          <div className="space-y-1">
            <FieldLabel className="text-amber-700 dark:text-amber-300">
              {t("strategicNotes")}
            </FieldLabel>
            <p className="text-sm leading-relaxed text-amber-900 dark:text-amber-100">
              {strategicNotes}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Open questions — bullet list */}
      {openQuestions.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <FieldLabel>{t("openQuestions")}</FieldLabel>
            <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground">
              {openQuestions.map((q, idx) => (
                <li key={idx}>{q}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
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
