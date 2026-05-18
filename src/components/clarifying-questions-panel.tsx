"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { HelpCircle } from "lucide-react";

import type { ClarifyingQuestion } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ClarifyingQuestionsPanelProps {
  questions: ClarifyingQuestion[];
  answers: Record<string, string>;
  onChange: (id: string, value: string) => void;
  disabled?: boolean;
}

export function ClarifyingQuestionsPanel({
  questions,
  answers,
  onChange,
  disabled,
}: ClarifyingQuestionsPanelProps) {
  const t = useTranslations("intake");

  if (questions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t("clarifyHeader")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {questions.map((q, idx) => {
          const inputId = `clarify-${q.id}`;
          const whyId = `clarify-why-${q.id}`;
          return (
            <div key={q.id} className="space-y-2">
              <div className="space-y-1">
                <Label
                  htmlFor={inputId}
                  className="flex items-baseline gap-2 text-sm"
                >
                  <span className="text-muted-foreground tabular-nums">
                    {idx + 1}.
                  </span>
                  <span>{q.question}</span>
                </Label>
                {q.why && (
                  <p
                    id={whyId}
                    className="pl-5 text-xs leading-relaxed text-muted-foreground"
                  >
                    {q.why}
                  </p>
                )}
              </div>
              <Textarea
                id={inputId}
                aria-describedby={q.why ? whyId : undefined}
                rows={2}
                disabled={disabled}
                value={answers[q.id] ?? ""}
                onChange={(e) => onChange(q.id, e.target.value)}
                className="ml-5"
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
