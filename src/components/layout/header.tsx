"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Building2,
  FileWarning,
  Globe,
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

export function Header() {
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
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/80 px-6 backdrop-blur-sm">
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
      <div className="flex items-center gap-1.5">
        {/* Tool quick-actions — utility tools that don't belong in the
            conversation flow (PII redact, business lookup, contract review). */}
        <button
          type="button"
          onClick={() => setActiveTool("contract-redline")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
          title="📋 계약서 검토 / Auto-redline contract per Korean law"
          aria-label="Contract redline"
        >
          <FileWarning className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          계약서
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("redact")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
          title="🔒 PII 자동 제거 / Auto-redact personal info"
          aria-label="PII redact"
        >
          <ShieldOff className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          PII
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("business-lookup")}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
          title="🏢 사업자등록번호 조회 / Verify business registration"
          aria-label="Business lookup"
        >
          <Building2 className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          사업자
        </button>
        <ModelSelector />
        <button
          type="button"
          onClick={toggleLocale}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
          aria-label={tHeader("toggleLocale")}
        >
          <Globe className="h-3.5 w-3.5" aria-hidden />
          {locale === "ko" ? "EN" : "한국어"}
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 transition-colors hover:bg-slate-100"
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
