"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Brain, Check, ChevronDown, Zap } from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MODEL_ID,
  FAMILY_LABELS,
  MODEL_OPTIONS,
  TIER_LABELS,
  resolveModel,
  type ModelFamily,
  type ModelOption,
} from "@/lib/models";

/** Small icon used as a brand glyph next to each option. */
function FamilyGlyph({ family }: { family: ModelFamily }) {
  const letter =
    family === "anthropic" ? "A" : family === "openai" ? "O" : "G";
  const color =
    family === "anthropic"
      ? "bg-orange-100 text-orange-700"
      : family === "openai"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-blue-100 text-blue-700";
  return (
    <span
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold",
        color,
      )}
      aria-hidden
    >
      {letter}
    </span>
  );
}

function TierBadge({ tier, locale }: { tier: ModelOption["tier"]; locale: "ko" | "en" }) {
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
        "ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        color,
      )}
    >
      {label}
    </span>
  );
}

export function ModelSelector(): React.ReactElement {
  const tHeader = useTranslations("header");
  const locale = useLocale() as "ko" | "en";
  const { selectedModelId, setSelectedModelId } = useCases();
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const currentId = selectedModelId ?? DEFAULT_MODEL_ID;
  const current = resolveModel(currentId);

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

  // Close on outside click.
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

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tHeader("modelSelector")}
        title={current.description}
      >
        <Brain className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        <FamilyGlyph family={current.family} />
        <span className="max-w-[160px] truncate">{current.displayName}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 text-slate-500 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={tHeader("modelSelector")}
          className="absolute right-0 z-50 mt-1.5 w-[280px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          <div className="border-b border-slate-100 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {tHeader("modelSelector")}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {tHeader("modelSelectorHint")}
            </p>
          </div>
          <div className="max-h-[440px] overflow-y-auto py-1">
            {grouped.map(([family, options]) => (
              <div key={family} className="py-1">
                <div className="flex items-center gap-1.5 px-3 py-1">
                  <FamilyGlyph family={family} />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {FAMILY_LABELS[family][locale]}
                  </span>
                </div>
                {options.map((opt) => {
                  const selected = opt.id === currentId;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        setSelectedModelId(opt.id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-slate-50",
                        selected && "bg-slate-100/80",
                      )}
                      title={opt.description}
                    >
                      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        {selected ? (
                          <Check className="h-3.5 w-3.5 text-slate-900" aria-hidden />
                        ) : opt.tier === "premium" ? (
                          <Brain className="h-3 w-3 text-violet-400" aria-hidden />
                        ) : (
                          <Zap className="h-3 w-3 text-slate-400" aria-hidden />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                        {opt.displayName}
                      </span>
                      <TierBadge tier={opt.tier} locale={locale} />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
