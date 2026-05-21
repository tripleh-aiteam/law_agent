"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import {
  Building2,
  CheckCircle2,
  Copy,
  Loader2,
  ShieldOff,
  X,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Public component                                                            */
/* -------------------------------------------------------------------------- */

export type ToolsPanelTool = "redact" | "business-lookup" | null;

/**
 * Slide-over panel exposing utility tools that don't belong in the
 * main Q→A conversation flow. Currently:
 *  - 🔒 PII Redactor          (regex + LLM)
 *  - 🏢 사업자등록번호 조회   (NTS Open API)
 */
export function ToolsPanel({
  tool,
  onClose,
}: {
  tool: ToolsPanelTool;
  onClose: () => void;
}): React.ReactElement | null {
  if (!tool) return null;
  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="flex-1 bg-slate-900/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      {/* Slide-over */}
      <aside className="w-full max-w-2xl overflow-y-auto bg-white shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-5 py-3 backdrop-blur">
          <h2 className="text-base font-semibold text-slate-900">
            {tool === "redact"
              ? "🔒 PII 자동 제거"
              : "🏢 사업자등록번호 조회"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="px-5 py-5">
          {tool === "redact" && <PiiRedactTool />}
          {tool === "business-lookup" && <BusinessLookupTool />}
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* PII redact tool                                                             */
/* -------------------------------------------------------------------------- */

function PiiRedactTool(): React.ReactElement {
  const [input, setInput] = React.useState("");
  const [thorough, setThorough] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{
    redactedText: string;
    hitCount: number;
    hitsByCategory: Record<string, number>;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onRun = async () => {
    if (!input.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/document/redact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input, thorough }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyRedacted = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.redactedText);
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-slate-600">
        문서를 붙여넣으면 주민등록번호, 사업자등록번호, 전화번호, 계좌번호,
        이메일 등을 자동으로 제거합니다. 정밀 모드는 추가로 LLM이 이름과
        주소까지 식별합니다.
        <br />
        <span className="text-slate-400">
          Paste a document — PII patterns (RRN, phone, accounts, etc.) are
          stripped. Thorough mode also catches names + addresses via LLM.
        </span>
      </p>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="문서 본문을 여기에 붙여넣으세요... / Paste document content here..."
        rows={10}
        className="block w-full resize-y rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-400 focus:bg-white"
      />

      <div className="flex items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-slate-700">
          <input
            type="checkbox"
            checked={thorough}
            onChange={(e) => setThorough(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          정밀 모드 (이름·주소까지 검출 / LLM-thorough)
        </label>
        <button
          type="button"
          onClick={onRun}
          disabled={!input.trim() || busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors",
            !input.trim() || busy
              ? "bg-slate-200 text-slate-400"
              : "bg-slate-900 text-white hover:bg-slate-800",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ShieldOff className="h-3.5 w-3.5" aria-hidden />
          )}
          {busy ? "처리 중..." : "PII 제거 / Redact"}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13px] text-emerald-900">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
            <span className="font-medium">
              {result.hitCount}건의 PII 제거됨 / {result.hitCount} PII items redacted
            </span>
            {Object.entries(result.hitsByCategory).map(([cat, count]) => (
              <span
                key={cat}
                className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-800"
              >
                {cat}: {count}
              </span>
            ))}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Redacted output
              </span>
              <button
                type="button"
                onClick={copyRedacted}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <Copy className="h-3 w-3" aria-hidden />
                복사 / Copy
              </button>
            </div>
            <pre className="max-h-[420px] overflow-y-auto whitespace-pre-wrap p-3 text-[13px] leading-relaxed text-slate-800">
              {result.redactedText}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 사업자등록번호 lookup tool                                                  */
/* -------------------------------------------------------------------------- */

interface LookupResult {
  bizNumber: string;
  found: boolean;
  status?: { code: string; ko: string; en: string };
  taxType?: { code: string; ko: string; en: string };
  closedAt?: string;
}

function BusinessLookupTool(): React.ReactElement {
  const locale = useLocale() as "ko" | "en";
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<LookupResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onLookup = async () => {
    if (!input.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/business-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bizNumber: input }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onLookup();
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-slate-600">
        상대방의 사업자등록번호를 입력하면 국세청 Open API로 영업 상태(계속/휴업/폐업)와
        과세유형을 즉시 조회합니다. 소송 상대방이 실재하는지 확인하는 첫 단계입니다.
        <br />
        <span className="text-slate-400">
          Enter the opposing party's 사업자등록번호. Verifies whether the
          business actually exists, active/suspended/closed status, and tax
          type via the official NTS Open API.
        </span>
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="123-45-67890 or 1234567890"
          className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-mono tracking-wide text-slate-900 outline-none focus:border-slate-400 focus:bg-white"
        />
        <button
          type="button"
          onClick={onLookup}
          disabled={!input.trim() || busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors",
            !input.trim() || busy
              ? "bg-slate-200 text-slate-400"
              : "bg-slate-900 text-white hover:bg-slate-800",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Building2 className="h-3.5 w-3.5" aria-hidden />
          )}
          {busy ? "조회 중..." : "조회 / Lookup"}
        </button>
      </div>

      {error && (
        <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-800">
          <p className="whitespace-pre-wrap">{error}</p>
          {/NTS_BUSINESS_API_KEY/.test(error) && (
            <div className="rounded border border-rose-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-700">
              <p className="font-semibold">설정 안내 / Setup steps:</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>
                  <a
                    href="https://data.go.kr"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    data.go.kr
                  </a>{" "}
                  에 가입
                </li>
                <li>국세청_사업자등록정보 진위확인 및 상태조회 API 활용신청</li>
                <li>
                  발급된 인코딩 키를{" "}
                  <code className="rounded bg-slate-100 px-1">NTS_BUSINESS_API_KEY</code>{" "}
                  로 .env.local + Vercel에 추가
                </li>
                <li>재배포</li>
              </ol>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            {result.found ? (
              <CheckCircle2
                className="h-4 w-4 text-emerald-600"
                aria-hidden
              />
            ) : (
              <XCircle className="h-4 w-4 text-rose-600" aria-hidden />
            )}
            <span className="font-mono text-sm font-semibold text-slate-900">
              {formatBizNumber(result.bizNumber)}
            </span>
          </div>
          {result.found ? (
            <div className="space-y-2.5 px-3 py-3 text-[13px]">
              <KV
                label={locale === "ko" ? "영업 상태" : "Status"}
                value={
                  result.status ? (
                    <StatusBadge
                      code={result.status.code}
                      label={locale === "ko" ? result.status.ko : result.status.en}
                    />
                  ) : (
                    "-"
                  )
                }
              />
              <KV
                label={locale === "ko" ? "과세유형" : "Tax type"}
                value={
                  result.taxType
                    ? locale === "ko"
                      ? result.taxType.ko
                      : result.taxType.en
                    : "-"
                }
              />
              {result.closedAt && (
                <KV
                  label={locale === "ko" ? "폐업일" : "Closed date"}
                  value={formatDate(result.closedAt)}
                />
              )}
            </div>
          ) : (
            <div className="px-3 py-3 text-[13px] text-slate-600">
              {locale === "ko"
                ? "국세청에 등록된 사업자가 아닙니다. 사업자등록번호를 다시 확인해 주세요."
                : "Not found in the NTS registry. Double-check the 사업자등록번호."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KV({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-slate-900">{value}</span>
    </div>
  );
}

function StatusBadge({
  code,
  label,
}: {
  code: string;
  label: string;
}): React.ReactElement {
  const color =
    code === "01"
      ? "bg-emerald-100 text-emerald-700"
      : code === "02"
        ? "bg-amber-100 text-amber-700"
        : code === "03"
          ? "bg-rose-100 text-rose-700"
          : "bg-slate-100 text-slate-600";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        color,
      )}
    >
      {label}
    </span>
  );
}

function formatBizNumber(s: string): string {
  if (s.length !== 10) return s;
  return `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}`;
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}`;
}
