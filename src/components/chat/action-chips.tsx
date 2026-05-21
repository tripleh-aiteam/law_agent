"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

type ChipKey =
  | "summarize"
  | "analyze"
  | "precedents"
  | "counter"
  | "statutes";

const CHIPS: { key: ChipKey; emoji: string }[] = [
  { key: "summarize", emoji: "📊" },
  { key: "analyze", emoji: "📑" },
  { key: "precedents", emoji: "⚖" },
  { key: "counter", emoji: "⚠" },
  { key: "statutes", emoji: "📜" },
];

/**
 * Quick-action chip strip below the chat input. Each chip carries a
 * full natural-language prompt (in the user's locale) — clicking a chip
 * fires that prompt immediately when there's case context (an
 * attachment, a prior turn, or already-typed text). With no context
 * the parent falls back to inserting the prompt into the textarea so
 * the user can supply case facts first.
 */
export function ActionChips({
  onAction,
}: {
  onAction: (prompt: string) => void;
}) {
  const t = useTranslations("chips");
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-2">
      {CHIPS.map(({ key, emoji }) => (
        <button
          key={key}
          type="button"
          onClick={() => onAction(t(`${key}.prompt`))}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-100"
          title={t(`${key}.tooltip`)}
        >
          <span aria-hidden>{emoji}</span>
          <span>{t(`${key}.label`)}</span>
        </button>
      ))}
    </div>
  );
}
