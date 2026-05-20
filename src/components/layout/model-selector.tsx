"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { Brain, ChevronDown, Sparkles } from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { cn } from "@/lib/utils";
import {
  FAMILY_LABELS,
  MODEL_OPTIONS,
  TIER_LABELS,
  resolveModel,
  type ModelFamily,
  type ModelOption,
} from "@/lib/models";

/* -------------------------------------------------------------------------- */
/* Family glyph                                                                */
/* -------------------------------------------------------------------------- */

// Brand-aligned single-character glyphs. Letters match the displayed brand
// name (Claude → C, ChatGPT → G as in GPT, Gemini → ♊ zodiac sign to avoid
// collision with ChatGPT's G).
const FAMILY_GLYPH: Record<
  ModelFamily,
  { letter: string; classes: string }
> = {
  anthropic: { letter: "C", classes: "bg-orange-100 text-orange-700" },
  openai: { letter: "G", classes: "bg-emerald-100 text-emerald-700" },
  // Free-tier Groq models — lightning bolt for Groq's "fast inference"
  // brand identity, teal/green to signal "free / open" visually.
  groq: {
    letter: "⚡",
    classes: "bg-gradient-to-br from-teal-400 to-emerald-600 text-white",
  },
  google: { letter: "♊", classes: "bg-blue-100 text-blue-700" },
  // Manus uses a hand symbol — the brand mark on manus.im is literally a
  // hand. Purple gradient matches their site's primary accent color.
  manus: {
    letter: "✋",
    classes: "bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white",
  },
};

function FamilyGlyph({
  family,
  size = "sm",
}: {
  family: ModelFamily;
  size?: "sm" | "md";
}) {
  const g = FAMILY_GLYPH[family];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded font-bold",
        size === "md" ? "h-6 w-6 text-sm" : "h-5 w-5 text-[10px]",
        g.classes,
      )}
      aria-hidden
    >
      {g.letter}
    </span>
  );
}

function TierBadge({
  tier,
  locale,
}: {
  tier: ModelOption["tier"];
  locale: "ko" | "en";
}) {
  const label = TIER_LABELS[tier][locale];
  const color =
    tier === "premium"
      ? "bg-violet-100 text-violet-700"
      : tier === "balanced"
        ? "bg-sky-100 text-sky-700"
        : "bg-slate-100 text-slate-600";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        color,
      )}
    >
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Selector — multi-select checkbox panel                                      */
/* -------------------------------------------------------------------------- */

const DROPDOWN_WIDTH = 320;

export function ModelSelector(): React.ReactElement {
  const tHeader = useTranslations("header");
  const locale = useLocale() as "ko" | "en";
  const { selectedModelIds, toggleSelectedModel } = useCases();
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(false);

  const selectedSet = React.useMemo(
    () => new Set(selectedModelIds),
    [selectedModelIds],
  );

  // Group models by family for the menu sections.
  const grouped = React.useMemo(() => {
    const m = new Map<ModelFamily, ModelOption[]>();
    for (const opt of MODEL_OPTIONS) {
      const arr = m.get(opt.family) ?? [];
      arr.push(opt);
      m.set(opt.family, arr);
    }
    return Array.from(m.entries());
  }, []);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const recomputePosition = React.useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    const top = rect.bottom + 6;
    const right = Math.max(margin, window.innerWidth - rect.right);
    const maxHeight = Math.max(220, window.innerHeight - top - margin);
    setPos({ top, right, maxHeight });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    recomputePosition();
    const onScrollOrResize = () => recomputePosition();
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, recomputePosition]);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // Label for the button — show selection count + summary.
  const labelText = React.useMemo(() => {
    if (selectedModelIds.length === 1) {
      return resolveModel(selectedModelIds[0]).displayName;
    }
    return tHeader("modelSelectorMultiLabel", {
      count: selectedModelIds.length,
    });
  }, [selectedModelIds, tHeader]);

  const isMulti = selectedModelIds.length >= 2;

  const menu = open && pos && (
    <div
      ref={menuRef}
      role="listbox"
      aria-multiselectable
      aria-label={tHeader("modelSelector")}
      style={{
        position: "fixed",
        top: pos.top,
        right: pos.right,
        width: DROPDOWN_WIDTH,
        maxHeight: pos.maxHeight,
      }}
      className="z-[100] flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
    >
      <div className="shrink-0 border-b border-slate-100 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {tHeader("modelSelector")}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
          {tHeader("modelSelectorMultiHint")}
        </p>
        <p className="mt-1 text-[11px] font-medium text-indigo-700">
          {tHeader("modelSelectorSelected", { count: selectedModelIds.length })}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {grouped.map(([family, options]) => (
          <div key={family} className="py-1">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <FamilyGlyph family={family} size="md" />
              <span className="text-base font-bold tracking-tight text-slate-900">
                {FAMILY_LABELS[family][locale]}
              </span>
            </div>
            {options.map((opt) => {
              const selected = selectedSet.has(opt.id);
              const isLastSelected =
                selected && selectedModelIds.length === 1;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => toggleSelectedModel(opt.id)}
                  disabled={isLastSelected}
                  title={
                    isLastSelected
                      ? "At least one model must be selected"
                      : opt.description
                  }
                  className={cn(
                    "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors",
                    selected
                      ? "bg-indigo-50/70 hover:bg-indigo-50"
                      : "hover:bg-slate-50",
                    isLastSelected && "cursor-not-allowed opacity-80",
                  )}
                >
                  {/* Checkbox */}
                  <span
                    className={cn(
                      "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                      selected
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-slate-300 bg-white",
                    )}
                  >
                    {selected && (
                      <svg
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-3 w-3"
                        aria-hidden
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4L9 11.6l6.3-6.3a1 1 0 011.4 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-slate-900">
                        {opt.displayName}
                      </span>
                      {opt.experimental && (
                        <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-800">
                          beta
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-500">
                      {opt.description}
                    </p>
                  </div>
                  <TierBadge tier={opt.tier} locale={locale} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
          isMulti
            ? "border-indigo-300 bg-gradient-to-r from-indigo-50 to-violet-50 text-indigo-900 hover:from-indigo-100 hover:to-violet-100"
            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tHeader("modelSelector")}
      >
        {isMulti ? (
          <Sparkles className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
        ) : (
          <Brain className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        )}
        <span className="max-w-[180px] truncate">{labelText}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform",
            isMulti ? "text-indigo-500" : "text-slate-500",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {mounted && menu && createPortal(menu, document.body)}
    </div>
  );
}
