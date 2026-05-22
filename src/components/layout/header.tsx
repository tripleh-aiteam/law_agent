"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Building2,
  FileDiff,
  FileWarning,
  Gavel,
  Globe,
  Menu,
  Settings2,
  ShieldOff,
} from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { ModelSelector } from "@/components/layout/model-selector";
import {
  ToolsPanel,
  type ToolsPanelTool,
} from "@/components/tools/tools-panel";
import { usePathname, useRouter } from "@/i18n/navigation";

export function Header({
  onOpenSidebar,
}: {
  /** Callback to open the mobile sidebar drawer. Hamburger shows on <md. */
  onOpenSidebar?: () => void;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale() as "ko" | "en";
  const tHeader = useTranslations("header");

  const t = useTranslations();
  const { currentCase, renameCase } = useCases();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [activeTool, setActiveTool] = React.useState<ToolsPanelTool>(null);

  const currentCaseLabel = currentCase
    ? currentCase.nameKey
      ? t(currentCase.nameKey)
      : currentCase.name
    : "";

  const startEdit = () => {
    if (!currentCase) return;
    setDraft(currentCaseLabel);
    setEditing(true);
  };

  const commitEdit = () => {
    if (currentCase) {
      const v = draft.trim();
      if (v) renameCase(currentCase.id, v);
    }
    setEditing(false);
  };

  const toggleLocale = () => {
    const next = locale === "ko" ? "en" : "ko";
    router.replace(pathname, { locale: next });
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white/80 px-3 backdrop-blur-sm sm:px-6">
      {/* Hamburger — opens the off-canvas sidebar on mobile (<md) */}
      <button
        type="button"
        onClick={onOpenSidebar}
        className="-ml-1 inline-flex shrink-0 items-center justify-center rounded-md p-2 text-slate-700 transition-colors hover:bg-slate-100 md:hidden"
        aria-label={tHeader("newCase")}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        {editing && currentCase ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            className="w-full max-w-md rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium outline-none ring-2 ring-slate-300"
          />
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="truncate rounded-md px-1 py-0.5 text-sm font-medium tracking-tight text-slate-800 hover:bg-slate-100"
            title={currentCase ? tHeader("renameCase") : undefined}
          >
            {currentCase ? currentCaseLabel : tHeader("newCase")}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        {/* Tool quick-actions — text labels hide on small screens so the
            full row fits a phone. Icons + tooltips stay. */}
        <button
          type="button"
          onClick={() => setActiveTool("civil-draft")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:px-2.5 sm:py-1.5"
          title={tHeader("toolCivilDraftTitle")}
          aria-label={tHeader("toolCivilDraftTitle")}
        >
          <Gavel className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          <span className="hidden lg:inline">{tHeader("toolCivilDraft")}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("contract-redline")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:px-2.5 sm:py-1.5"
          title={tHeader("toolContractRedlineTitle")}
          aria-label={tHeader("toolContractRedlineTitle")}
        >
          <FileWarning className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          <span className="hidden lg:inline">{tHeader("toolContractRedline")}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("document-diff")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:px-2.5 sm:py-1.5"
          title={tHeader("toolDocumentDiffTitle")}
          aria-label={tHeader("toolDocumentDiffTitle")}
        >
          <FileDiff className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          <span className="hidden lg:inline">{tHeader("toolDocumentDiff")}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("redact")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:px-2.5 sm:py-1.5"
          title={tHeader("toolPiiRedactTitle")}
          aria-label={tHeader("toolPiiRedactTitle")}
        >
          <ShieldOff className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          <span className="hidden lg:inline">{tHeader("toolPiiRedact")}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("business-lookup")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:px-2.5 sm:py-1.5"
          title={tHeader("toolBusinessLookupTitle")}
          aria-label={tHeader("toolBusinessLookupTitle")}
        >
          <Building2 className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          <span className="hidden lg:inline">{tHeader("toolBusinessLookup")}</span>
        </button>
        <ModelSelector />
        <button
          type="button"
          onClick={toggleLocale}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 sm:px-2.5 sm:py-1.5"
          aria-label={tHeader("toggleLocale")}
        >
          <Globe className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">
            {locale === "ko" ? "EN" : "한국어"}
          </span>
        </button>
        <button
          type="button"
          className="hidden items-center justify-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 transition-colors hover:bg-slate-100 sm:inline-flex"
          aria-label={tHeader("settings")}
          title={tHeader("settings")}
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <ToolsPanel tool={activeTool} onClose={() => setActiveTool(null)} />
    </header>
  );
}
