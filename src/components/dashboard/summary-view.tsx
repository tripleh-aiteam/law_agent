"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export interface SummaryPayload {
  summary: {
    overview: string;
    keyIssue: string;
    parties: string;
    claim: string;
    statutes: string[];
  };
}

export function SummaryView({ data }: { data: SummaryPayload }): React.ReactElement {
  const t = useTranslations("dashboard.summary");
  const { overview, keyIssue, parties, claim, statutes } = data.summary;

  return (
    <div className="space-y-4">
      {/* Overview — full width, light slate */}
      <Card className="border-slate-200 bg-slate-50/70 dark:bg-slate-900/40">
        <CardContent className="space-y-2 p-5">
          <FieldLabel>{t("overview")}</FieldLabel>
          <p className="text-sm leading-relaxed text-foreground">{overview}</p>
        </CardContent>
      </Card>

      {/* Key issue — large, bold, serif */}
      <Card>
        <CardContent className="space-y-2 p-5">
          <FieldLabel>{t("keyIssue")}</FieldLabel>
          <p className="font-serif text-xl font-bold leading-snug tracking-tight text-foreground">
            {keyIssue}
          </p>
        </CardContent>
      </Card>

      {/* Parties + Claim — two columns */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="space-y-2 p-5">
            <FieldLabel>{t("parties")}</FieldLabel>
            <p className="text-sm leading-relaxed text-foreground">{parties}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-5">
            <FieldLabel>{t("claim")}</FieldLabel>
            <p className="text-sm leading-relaxed text-foreground">{claim}</p>
          </CardContent>
        </Card>
      </div>

      {/* Statutes — chip row */}
      {statutes.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <FieldLabel>{t("statutes")}</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {statutes.map((s) => (
                <Badge
                  key={s}
                  variant="outline"
                  className="border-slate-300 bg-white font-medium dark:border-slate-700 dark:bg-slate-900"
                >
                  {s}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
