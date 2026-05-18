"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, FileText } from "lucide-react";

import type { LegalElements } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed text-foreground">
        {value || <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  if (!items || items.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <li key={`${item}-${i}`}>
          <Badge variant="secondary" className="font-normal">
            {item}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function ExtractedElementsCard({
  elements,
  defaultOpen = false,
}: {
  elements: LegalElements;
  defaultOpen?: boolean;
}) {
  const t = useTranslations("elements");
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="extracted-elements-content"
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t("title")}
          </CardTitle>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </CardHeader>
      {open && (
        <CardContent id="extracted-elements-content" className="pt-0">
          <dl className="divide-y divide-border">
            <Row
              label={t("caseNature")}
              value={
                <Badge variant="outline" className="font-normal">
                  {elements.caseNature}
                </Badge>
              }
            />
            <Row
              label={t("parties")}
              value={
                <div className="space-y-1">
                  <div>
                    <span className="text-muted-foreground">
                      {t("plaintiff")}:
                    </span>{" "}
                    {elements.parties?.plaintiff || "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {t("defendant")}:
                    </span>{" "}
                    {elements.parties?.defendant || "—"}
                  </div>
                </div>
              }
            />
            <Row label={t("claimCause")} value={elements.claimCause} />
            <Row
              label={t("legalRelationship")}
              value={elements.legalRelationship}
            />
            <Row label={t("partyStatus")} value={elements.partyStatus} />
            <Row label={t("coreIssue")} value={elements.coreIssue} />
            <Row label={t("damageType")} value={elements.damageType} />
            <Row
              label={t("applicableStatutes")}
              value={<ChipList items={elements.applicableStatutes ?? []} />}
            />
            <Row
              label={t("keyFacts")}
              value={
                elements.keyFacts && elements.keyFacts.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4">
                    {elements.keyFacts.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )
              }
            />
            {elements.missingInfo && elements.missingInfo.length > 0 && (
              <>
                <Separator className="my-2" />
                <Row
                  label={t("missingInfo")}
                  value={
                    <ul className="list-disc space-y-1 pl-4 text-amber-900 dark:text-amber-200">
                      {elements.missingInfo.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  }
                />
              </>
            )}
          </dl>
        </CardContent>
      )}
    </Card>
  );
}
