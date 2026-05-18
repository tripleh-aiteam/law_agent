"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, Search } from "lucide-react";

import type {
  ClarifyingQuestion,
  LegalElements,
  PrecedentMatch,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ClarifyingQuestionsPanel } from "@/components/clarifying-questions-panel";
import { ExtractedElementsCard } from "@/components/extracted-elements-card";
import { ResultsList } from "@/components/results-list";

type Phase = "idle" | "extracting" | "clarifying" | "searching" | "done";

interface ExtractResponse {
  elements: LegalElements;
  clarifyingQuestions: ClarifyingQuestion[];
}

interface SearchResponse {
  matches: PrecedentMatch[];
}

function ExtractingSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3 py-6">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}

function SearchingSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardContent className="space-y-3 py-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function buildFinalNarrative(
  narrative: string,
  questions: ClarifyingQuestion[],
  answers: Record<string, string>,
) {
  const answered = questions
    .map((q) => {
      const ans = (answers[q.id] ?? "").trim();
      if (!ans) return null;
      return `Q: ${q.question}\nA: ${ans}`;
    })
    .filter(Boolean);
  if (answered.length === 0) return narrative;
  return `${narrative.trim()}\n\n---\n${answered.join("\n\n")}`;
}

export function IntakeForm() {
  const tIntake = useTranslations("intake");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [narrative, setNarrative] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);

  const [elements, setElements] = React.useState<LegalElements | null>(null);
  const [questions, setQuestions] = React.useState<ClarifyingQuestion[]>([]);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [matches, setMatches] = React.useState<PrecedentMatch[] | null>(null);

  const narrativeId = React.useId();
  const helpId = `${narrativeId}-help`;
  const errorId = `${narrativeId}-error`;

  const isBusy = phase === "extracting" || phase === "searching";

  const runSearch = React.useCallback(
    async (finalNarrative: string, els: LegalElements) => {
      setPhase("searching");
      setError(null);
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            narrative: finalNarrative,
            elements: els,
            locale,
          }),
        });
        if (!res.ok) {
          throw new Error(`Search failed: ${res.status}`);
        }
        const data = (await res.json()) as SearchResponse;
        setMatches(data.matches ?? []);
        setPhase("done");
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
      }
    },
    [locale],
  );

  const onAnalyze = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = narrative.trim();
    if (!trimmed) return;

    setPhase("extracting");
    setError(null);
    setElements(null);
    setQuestions([]);
    setAnswers({});
    setMatches(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrative: trimmed, locale }),
      });
      if (!res.ok) {
        throw new Error(`Extract failed: ${res.status}`);
      }
      const data = (await res.json()) as ExtractResponse;
      setElements(data.elements);
      const qs = data.clarifyingQuestions ?? [];
      setQuestions(qs);

      if (qs.length > 0) {
        setPhase("clarifying");
      } else {
        await runSearch(trimmed, data.elements);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const onSubmitClarifications = async () => {
    if (!elements) return;
    const finalNarrative = buildFinalNarrative(narrative, questions, answers);
    await runSearch(finalNarrative, elements);
  };

  const onSkipClarifications = async () => {
    if (!elements) return;
    await runSearch(narrative.trim(), elements);
  };

  const onAnswerChange = (id: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={onAnalyze} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor={narrativeId} className="text-sm">
                {tIntake("narrativeLabel")}
              </Label>
              <Textarea
                id={narrativeId}
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
                placeholder={tIntake("narrativePlaceholder")}
                disabled={isBusy}
                rows={8}
                required
                aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
                aria-invalid={error ? true : undefined}
                className="min-h-[180px] resize-y leading-relaxed"
              />
              <p id={helpId} className="text-xs text-muted-foreground">
                {tIntake("narrativeHelp")}
              </p>
              {error && (
                <p
                  id={errorId}
                  role="alert"
                  className="flex items-start gap-1.5 text-xs text-destructive"
                >
                  <AlertCircle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                  <span>
                    {tCommon("error")}: {error}
                  </span>
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="submit"
                disabled={isBusy || narrative.trim().length === 0}
                className="gap-1.5"
              >
                <Search className="h-4 w-4" aria-hidden />
                {phase === "extracting" || phase === "searching"
                  ? tCommon("searching")
                  : tIntake("analyze")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {phase === "extracting" && <ExtractingSkeleton />}

      {elements && phase !== "extracting" && (
        <ExtractedElementsCard
          elements={elements}
          defaultOpen={phase === "clarifying"}
        />
      )}

      {phase === "clarifying" && questions.length > 0 && (
        <div className="space-y-3">
          <ClarifyingQuestionsPanel
            questions={questions}
            answers={answers}
            onChange={onAnswerChange}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onSkipClarifications}
            >
              {tIntake("skipClarification")}
            </Button>
            <Button
              type="button"
              onClick={onSubmitClarifications}
              className="gap-1.5"
            >
              <Search className="h-4 w-4" aria-hidden />
              {tCommon("search")}
            </Button>
          </div>
        </div>
      )}

      {phase === "searching" && <SearchingSkeleton />}

      {phase === "done" && matches && <ResultsList matches={matches} />}
    </div>
  );
}
