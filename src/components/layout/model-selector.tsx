"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { Brain, Check, ChevronDown, Sparkles, Zap } from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MODEL_ID,
  FAMILY_LABELS,
  MODEL_OPTIONS,
  MOA_MODEL_ID,
  TIER_LABELS,
  resolveModel,
  type ModelFamily,
  type ModelOption,
} from "@/lib/models";

/* -------------------------------------------------------------------------- */
/* Family glyph                                                                */
/* -------------------------------------------------------------------------- */

const FAMILY_GLYPH: Record<
  ModelFamily,
  { letter: string; classes: string }
> = {
  auto: {
    letter: "✦",
    classes: "bg-gradient-to-br from-indigo-500 to-violet-600 text-white",
  },
  anthropic: { letter: "A", classes: "bg-orange-100 text-orange-700" },
  openai: { letter: "O", classes: "bg-emerald-100 text-emerald-700" },
  google: { letter: "G", classes: "bg-blue-100 text-blue-700" },
  xai: { letter: "X", classes: "bg-slate-900 text-white" },
  deepseek: { letter: "D", classes: "bg-cyan-100 text-cyan-700" },
  meta: { letter: "M", classes: "bg-sky-100 text-sky-700" },
  mistral: { letter: "Ⓜ", classes: "bg-amber-100 text-amber-700" },
};

function FamilyGlyph({ family }: { family: ModelFamily }) {
  const g = FAMILY_GLYPH[family] ?? FAMILY_GLYPH.anthropic;
  return (
    <span
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold",
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
        "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        color,
      )}
    >
      {label}
    </span>
  );
}

/**
 * Strip redundant brand prefixes from the displayed model name. The family
 * glyph + section header already tell the user which brand this is, so
 * "Claude Opus 4.7" → "Opus 4.7" and "GPT-4o mini" stays as-is (no redundant
 * prefix). Keeps each row short enough to fit comfortably in the dropdown.
 */
function shortLabel(opt: ModelOption): string {
  const prefixes: Array<{ family: ModelFamily; prefix: string }> = [
    { family: "anthropic", prefix: "Claude " },
    { family: "meta", prefix: "Llama " },
    { family: "mistral", prefix: "Mistral " },
    { family: "google", prefix: "Gemini " },
    { family: "xai", prefix: "Grok " },
    { family: "deepseek", prefix: "DeepSeek " },
  ];
  for (const { family, prefix } of prefixes) {
    if (
      opt.family === family &&
      opt.displayName.startsWith(prefix) &&
      // Keep "Llama 4 Scout" etc. — only strip when there's still a useful
      // suffix afterwards.
      opt.displayName.length > prefix.length
    ) {
      const trimmed = opt.displayName.slice(prefix.length);
      // Llama and Mistral cases: "Llama 4 Scout" → just "4 Scout" looks odd,
      // so keep those intact. Same for Mistral.
      if (opt.family === "meta" || opt.family === "mistral") {
        return opt.displayName;
      }
      return trimmed;
    }
  }
  return opt.displayName;
}

/* -------------------------------------------------------------------------- */
/* Selector                                                                    */
/* -------------------------------------------------------------------------- */

const DROPDOWN_WIDTH = 280;

export function ModelSelector(): React.ReactElement {
  const tHeader = useTranslations("header");
  const locale = useLocale() as "ko" | "en";
  const { selectedModelId, setSelectedModelId } = useCases();
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(false);

  const currentId = selectedModelId ?? DEFAULT_MODEL_ID;
  const current = resolveModel(currentId);
  const isMoaSelected = current.id === MOA_MODEL_ID;

  // Group models by family. We rely on MODEL_OPTIONS already being in the
  // intended display order (auto first, then anthropic, ...).
  const grouped = React.useMemo(() => {
    const m = new Map<ModelFamily, ModelOption[]>();
    for (const opt of MODEL_OPTIONS) {
      const arr = m.get(opt.family) ?? [];
      arr.push(opt);
      m.set(opt.family, arr);
    }
    return Array.from(m.entries());
  }, []);

  // Track when portals are safe (post-mount, client only).
  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Position the dropdown relative to the button using viewport coordinates.
  // We use position:fixed + portal so NO parent can clip it (the AppShell's
  // outer container has overflow-hidden, which was clipping the previous
  // absolute-positioned dropdown when it ran near the viewport edge).
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

  const menu = open && pos && (
    <div
      ref={menuRef}
      role="listbox"
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
      <div className="shrink-0 border-b border-slate-100 px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {tHeader("modelSelector")}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {tHeader("modelSelectorHint")}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {grouped.map(([family, options]) => (
          <div
            key={family}
            className={cn(
              "py-1",
              family === "auto" &&
                "border-b border-slate-100 bg-gradient-to-b from-indigo-50/40 to-transparent pb-2",
            )}
          >
            <div className="flex items-center gap-1.5 px-3 py-1">
              <FamilyGlyph family={family} />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {FAMILY_LABELS[family][locale]}
              </span>
            </div>
            {options.map((opt) => {
              const selected = opt.id === currentId;
              const isMoa = opt.id === MOA_MODEL_ID;
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
                    isMoa &&
                      "hover:bg-gradient-to-r hover:from-indigo-50 hover:to-violet-50",
                  )}
                  title={opt.description}
                >
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {selected ? (
                      <Check
                        className="h-3.5 w-3.5 text-slate-900"
                        aria-hidden
                      />
                    ) : isMoa ? (
                      <Sparkles
                        className="h-3 w-3 text-indigo-500"
                        aria-hidden
                      />
                    ) : opt.tier === "premium" ? (
                      <Brain
                        className="h-3 w-3 text-violet-400"
                        aria-hidden
                      />
                    ) : (
                      <Zap className="h-3 w-3 text-slate-400" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                    {shortLabel(opt)}
                    {opt.experimental && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-800">
                        beta
                      </span>
                    )}
                  </span>
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
          isMoaSelected
            ? "border-indigo-300 bg-gradient-to-r from-indigo-50 to-violet-50 text-indigo-900 hover:from-indigo-100 hover:to-violet-100"
            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tHeader("modelSelector")}
        title={current.description}
      >
        {isMoaSelected ? (
          <Sparkles className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
        ) : (
          <Brain className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        )}
        <FamilyGlyph family={current.family} />
        <span className="max-w-[160px] truncate">{shortLabel(current)}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform",
            isMoaSelected ? "text-indigo-500" : "text-slate-500",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {mounted && menu && createPortal(menu, document.body)}
    </div>
  );
}
