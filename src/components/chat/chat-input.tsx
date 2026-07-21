"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowUp,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Square,
  X,
} from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { ActionChips } from "@/components/chat/action-chips";
import { cn } from "@/lib/utils";
import type {
  CaseTurn,
  ClarifyingQuestion,
  LegalElements,
  PrecedentMatch,
  TurnBranch,
} from "@/lib/types";

/** A file the user attached as context. Stays visible as a chip above the
 *  textarea until the user removes it OR sends the message. */
type Attachment = {
  id: string;
  filename: string;
  byteSize: number;
  status: "loading" | "ready" | "error";
  /** Extracted text (only populated when status === "ready"). */
  text: string;
  /** Character count, for the chip's "...chars extracted" hint. */
  chars: number;
  /** Inline warnings from the extractor (e.g. HWP unsupported, scanned PDF). */
  warnings: string[];
  /** Error message when status === "error". */
  errorMessage?: string;
};

interface ExtractResponse {
  elements: LegalElements;
  summary: string;
  clarifyingQuestions: ClarifyingQuestion[];
}

interface SearchResponse {
  matches: PrecedentMatch[];
}

// SpeechRecognition isn't in the TS lib by default — narrow the type.
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionLike)
  | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* -------------------------------------------------------------------------- */
/* Per-model extract + search pipeline                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run the full extract→search pipeline for ONE model. Errors propagate so
 * the caller can mark this branch as failed without affecting siblings.
 */
async function runOneBranch(args: {
  narrative: string;
  locale: string;
  modelId: string;
  signal: AbortSignal;
}): Promise<{
  elements: LegalElements;
  summary: string;
  matches: PrecedentMatch[];
}> {
  const exRes = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      narrative: args.narrative,
      locale: args.locale,
      model: args.modelId,
    }),
    signal: args.signal,
  });
  if (!exRes.ok) {
    const body = (await exRes.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(body?.error ?? `Extract failed: ${exRes.status}`);
  }
  const exData = (await exRes.json()) as ExtractResponse;

  // Search uses the model that just produced the extraction so the rerank
  // stays consistent with the elements. If search fails we still keep the
  // extraction (summary + elements) — that's the most valuable part.
  let matches: PrecedentMatch[] = [];
  try {
    const srRes = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        narrative: args.narrative,
        elements: exData.elements,
        locale: args.locale,
        model: args.modelId,
      }),
      signal: args.signal,
    });
    if (srRes.ok) {
      const srData = (await srRes.json()) as SearchResponse;
      matches = srData.matches ?? [];
    }
  } catch (err) {
    // Swallow search-only errors — the extraction is the primary product.
    // The abort case will re-throw via the outer promise's signal handling.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
  }

  return {
    elements: exData.elements,
    summary: exData.summary,
    matches,
  };
}

/* -------------------------------------------------------------------------- */

export function ChatInput() {
  const tChat = useTranslations("chat");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const {
    currentCase,
    currentCaseId,
    createCase,
    selectCase,
    selectedModelIds,
    appendTurn,
    updateTurn,
    updateTurnBranch,
  } = useCases();

  const [value, setValue] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  const baseTranscriptRef = React.useRef<string>("");
  const speechCtorRef = React.useRef<(new () => SpeechRecognitionLike) | null>(
    null,
  );

  /** Single AbortController governs ALL parallel branches for the current
   * turn. Click Stop → abort → every per-model fetch rejects with AbortError
   * → each branch marks itself cancelled.
   *
   * We track WHICH case the in-flight pipeline belongs to alongside the
   * controller. The case-switch effect below needs that to tell a genuine
   * "user navigated to another case" (abort) apart from "onSend just
   * created the case this very request belongs to" (do NOT abort). */
  const abortRef = React.useRef<{
    controller: AbortController;
    caseId: string;
  } | null>(null);

  const [speechSupported, setSpeechSupported] = React.useState(false);
  React.useEffect(() => {
    const ctor = getSpeechRecognitionCtor();
    speechCtorRef.current = ctor;
    setSpeechSupported(ctor !== null);
  }, []);

  // On case switch: clear textarea + attachments + abort any in-flight pipeline.
  //
  // CAREFUL — this effect used to abort the FIRST question of every fresh
  // session. Asking with no case selected makes onSend call
  // createCase() + selectCase(), so currentCaseId changes inside the same
  // React batch as the send. This effect then fired and aborted the
  // AbortController onSend had just assigned, and the turn rendered as
  // "사용자가 정지함" even though the user never touched Stop. (The second
  // question always worked, because by then the case id no longer changed
  // — which is what made it look intermittent.)
  //
  // The guard below distinguishes the two cases: if the in-flight pipeline
  // already belongs to the case we just switched to, this isn't a
  // navigation away — it's the send that created it. Leave it alone.
  React.useEffect(() => {
    if (abortRef.current && abortRef.current.caseId === currentCaseId) return;
    setValue("");
    setAttachments([]);
    abortRef.current?.controller.abort();
    abortRef.current = null;
    setIsSending(false);
  }, [currentCaseId]);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 320;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value]);

  const replaceWithPrefix = React.useCallback((prefix: string) => {
    setValue((prev) => {
      const trimmed = prev.trim();
      if (trimmed.startsWith(prefix)) return prev;
      if (!trimmed) return prefix;
      return `${prefix}${trimmed}`;
    });
    textareaRef.current?.focus();
  }, []);

  const handleFiles = React.useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      for (const file of list) {
        const id = uid();
        setAttachments((prev) => [
          ...prev,
          {
            id,
            filename: file.name,
            byteSize: file.size,
            status: "loading",
            text: "",
            chars: 0,
            warnings: [],
          },
        ]);
        try {
          const formData = new FormData();
          formData.append("files", file);
          const res = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as
              | { error?: string }
              | null;
            throw new Error(
              body?.error ?? `Upload failed: ${res.status}`,
            );
          }
          const data = (await res.json()) as {
            files: Array<{
              filename: string;
              text: string;
              warnings: string[];
            }>;
          };
          const extractedFile = data.files?.[0];
          const extracted = (extractedFile?.text ?? "").trim();
          const warnings = extractedFile?.warnings ?? [];
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    status: extracted ? "ready" : "error",
                    text: extracted,
                    chars: extracted.length,
                    warnings,
                    errorMessage: extracted
                      ? undefined
                      : warnings[0] ?? "No text extracted from file.",
                  }
                : a,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, status: "error", errorMessage: message }
                : a,
            ),
          );
        }
      }
    },
    [],
  );

  const removeAttachment = React.useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /** Build the narrative sent to /api/extract by combining the user's
   *  question (the textarea text), files, AND context from the most
   *  recent completed turn so follow-ups have continuity. */
  const buildNarrative = React.useCallback(
    (question: string, currentAttachments: Attachment[]): string => {
      const q = question.trim();
      const ready = currentAttachments.filter(
        (a) => a.status === "ready" && a.text.length > 0,
      );
      const fileBlocks = ready
        .map((a) => `[첨부파일 / Attached file: ${a.filename}]\n${a.text}`)
        .join("\n\n---\n\n");

      const priorTurns = currentCase?.turns ?? [];
      const lastCompleted = [...priorTurns]
        .reverse()
        .find((t) => t.status === "complete");

      const sections: string[] = [];

      if (lastCompleted) {
        // Find the best branch (user-marked) or the first complete branch
        // to use as prior context for the follow-up.
        const priorBranches = lastCompleted.branches ?? [];
        const bestId = lastCompleted.bestBranchModelId;
        const priorBranch =
          (bestId && priorBranches.find((b) => b.modelId === bestId)) ||
          priorBranches.find((b) => b.status === "complete") ||
          // legacy turn fallback (no branches)
          ({
            summary: lastCompleted.summary,
          } as Partial<TurnBranch>);

        // Only include the prior-conversation block when the prior turn
        // has SUBSTANTIVE content (real case narrative). Otherwise we'd
        // be sending the LLM a wall of empty headers with no actual
        // case material — which makes models like Manus correctly
        // reply "you didn't include the case content".
        const priorNarrative = lastCompleted.narrative?.trim() ?? "";
        const priorSummary = priorBranch?.summary?.trim() ?? "";
        const priorIsSubstantive =
          priorNarrative.length > 200 || priorSummary.length > 100;

        if (priorIsSubstantive) {
          const contextBlock: string[] = [
            "[이전 대화 / Prior conversation]",
          ];
          if (priorNarrative.length > 0) {
            contextBlock.push(
              `이전 사건 사실관계 / Previous case context:\n${priorNarrative}`,
            );
          }
          if (lastCompleted.question?.trim()) {
            contextBlock.push(
              `이전 질문 / Previous question: ${lastCompleted.question.trim()}`,
            );
          }
          if (priorSummary.length > 0) {
            contextBlock.push(
              `이전 분석 요약 / Previous analysis summary:\n${priorSummary}`,
            );
          }
          sections.push(contextBlock.join("\n\n"));
        }
      }

      if (q) {
        sections.push(
          lastCompleted
            ? `[현재 후속 질문 / Current follow-up question]\n${q}`
            : `[사용자 질의 / User question]\n${q}`,
        );
      }
      if (fileBlocks) sections.push(fileBlocks);

      return sections.join("\n\n---\n\n");
    },
    [currentCase],
  );

  const onPickFiles = () => {
    fileInputRef.current?.click();
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && !f.type.startsWith("image/")) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  // ---------- Mic ----------
  const startRecording = () => {
    const Ctor = speechCtorRef.current;
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.lang = locale === "ko" ? "ko-KR" : "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      baseTranscriptRef.current = value.endsWith(" ") || value.length === 0
        ? value
        : value + " ";
      rec.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) {
            finalText += r[0].transcript;
          } else {
            interimText += r[0].transcript;
          }
        }
        baseTranscriptRef.current += finalText;
        setValue(baseTranscriptRef.current + interimText);
      };
      rec.onerror = () => setIsRecording(false);
      rec.onend = () => setIsRecording(false);
      recognitionRef.current = rec;
      rec.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsRecording(false);
  };

  const toggleRecording = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  React.useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  // ---------- Send pipeline ----------
  const hasReadyAttachments = attachments.some((a) => a.status === "ready");
  const hasPriorTurns = (currentCase?.turns ?? []).some(
    (t) => t.status === "complete",
  );
  const minChars = hasPriorTurns ? 1 : 10;
  const canSend =
    !isSending &&
    selectedModelIds.length > 0 &&
    (value.trim().length >= minChars || hasReadyAttachments);

  const onStop = () => {
    abortRef.current?.controller.abort();
  };

  /**
   * Fire the extract + search pipeline against the currently-selected
   * models. By default it uses whatever the user has typed in the
   * textarea, but the action chips can pass an `overrideQuestion` to
   * fire a chip-specific prompt without first mutating textarea state
   * (which would be a stale-closure race in React).
   */
  const onSend = async (overrideQuestion?: string) => {
    const questionText = (overrideQuestion ?? value).trim();
    const snapshotAttachments = attachments;
    const narrative = buildNarrative(
      overrideQuestion ?? value,
      snapshotAttachments,
    );
    if (!narrative) return;
    if (selectedModelIds.length === 0) return;

    let targetId = currentCaseId;
    if (!targetId) {
      targetId = createCase(null);
      selectCase(targetId);
    }

    const attachmentNames = snapshotAttachments
      .filter((a) => a.status === "ready")
      .map((a) => a.filename);

    // Build a turn with ONE branch per selected model, all starting as
    // pending. The UI will render N tabs immediately so the user sees
    // every model spin up at once.
    const turnId = uid();
    const startedAt = Date.now();
    const branches: TurnBranch[] = selectedModelIds.map((modelId) => ({
      modelId,
      status: "pending",
      startedAt,
    }));
    const pendingTurn: CaseTurn = {
      id: turnId,
      question:
        questionText ||
        (attachmentNames.length > 0
          ? attachmentNames.join(", ")
          : ""),
      createdAt: new Date().toISOString(),
      attachmentNames: attachmentNames.length > 0 ? attachmentNames : undefined,
      narrative,
      status: "pending",
      branches,
    };
    appendTurn(targetId, pendingTurn);

    setValue("");
    setAttachments([]);
    setError(null);

    const ac = new AbortController();
    // Record the owning case id so the case-switch effect can tell this
    // send apart from a real navigation (see the effect above).
    abortRef.current = { controller: ac, caseId: targetId };
    setIsSending(true);

    // Fan out — Promise.allSettled so one model's failure doesn't kill
    // the others. Each branch's status updates as soon as ITS call
    // finishes, so a fast model shows results while a slow one is still
    // spinning.
    try {
      await Promise.allSettled(
        selectedModelIds.map(async (modelId) => {
          try {
            const result = await runOneBranch({
              narrative,
              locale,
              modelId,
              signal: ac.signal,
            });
            updateTurnBranch(targetId!, turnId, modelId, {
              status: "complete",
              elements: result.elements,
              summary: result.summary,
              matches: result.matches,
              finishedAt: Date.now(),
            });
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
              updateTurnBranch(targetId!, turnId, modelId, {
                status: "cancelled",
                finishedAt: Date.now(),
              });
            } else {
              const message =
                err instanceof Error ? err.message : String(err);
              updateTurnBranch(targetId!, turnId, modelId, {
                status: "error",
                error: message,
                finishedAt: Date.now(),
              });
            }
          }
        }),
      );
    } finally {
      if (abortRef.current?.controller === ac) abortRef.current = null;
      setIsSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Standard chat UX: bare Enter sends, Shift+Enter inserts a newline.
    // We also keep accepting Cmd/Ctrl+Enter so muscle memory from the
    // previous binding still works. nativeEvent.isComposing prevents an
    // accidental send while a Korean IME is mid-composition (the IME
    // fires its own Enter to commit the candidate — we must NOT treat
    // that as a submit).
    if (e.key !== "Enter") return;
    if (e.nativeEvent.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    if (canSend) onSend();
  };

  /**
   * Action chip handler — fires the send pipeline IMMEDIATELY when the
   * case has enough context for the chip's prompt to make sense:
   *  - a ready attachment (the chip acts on that file), OR
   *  - a previously-completed turn (the chip acts as a follow-up), OR
   *  - already-typed text in the textarea (the chip refines that)
   *
   * Otherwise — brand-new case with no input yet — it falls back to
   * the old behavior of inserting the prompt into the textarea so the
   * user can add their case facts and Send when ready.
   *
   * IMPORTANT: when firing immediately, we bypass React state by passing
   * the prompt directly into onSend() — avoiding a stale-closure race
   * with setValue().
   */
  const handleChipAction = React.useCallback(
    (prompt: string) => {
      // CONTEXT GATE — only fire to the LLMs when we actually have case
      // material to reason over. Just having "any prior turn" is too
      // permissive: empty chip-fired turns count as prior turns but their
      // narratives are also empty, producing a recursive emptiness where
      // every Manus call returns "you didn't include the case content".
      //
      // "Real" context means ONE of:
      //   • A ready attachment (PDF/DOCX/etc with text extracted), OR
      //   • The user typed substantive text (>50 chars), OR
      //   • A prior turn exists whose narrative has substantive content
      //     (>200 chars — enough to recognize a real case description)
      const lastCompleted = (currentCase?.turns ?? [])
        .slice()
        .reverse()
        .find((t) => t.status === "complete");
      const priorNarrativeLength = lastCompleted?.narrative?.length ?? 0;
      const hasRealContext =
        hasReadyAttachments ||
        value.trim().length > 50 ||
        priorNarrativeLength > 200;

      if (hasRealContext && !isSending && selectedModelIds.length > 0) {
        // Clear the textarea so the user sees the chip's prompt take
        // over (it'll show in the Q bubble of the new turn).
        setValue("");
        void onSend(prompt);
      } else {
        // Not enough context — fall back to prefix-into-textarea so the
        // user can type their case facts or attach a file before sending.
        replaceWithPrefix(prompt);
      }
    },
    [
      hasReadyAttachments,
      value,
      isSending,
      selectedModelIds,
      currentCase,
      onSend,
      replaceWithPrefix,
    ],
  );

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "relative rounded-2xl border bg-white shadow-sm transition-colors",
          isDragOver
            ? "border-slate-900 ring-2 ring-slate-300"
            : "border-slate-200",
        )}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-slate-900/5 text-sm font-medium text-slate-700">
            {tChat("dropFiles")}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 pt-3 pb-3">
            {attachments.map((a) => (
              <div
                key={a.id}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                  a.status === "loading" && "border-slate-200 bg-slate-50",
                  a.status === "ready" && "border-emerald-200 bg-emerald-50",
                  a.status === "error" && "border-rose-200 bg-rose-50",
                )}
                title={a.errorMessage ?? a.warnings.join("\n") ?? a.filename}
              >
                {a.status === "loading" ? (
                  <Loader2
                    className="h-4 w-4 shrink-0 animate-spin text-slate-500"
                    aria-hidden
                  />
                ) : a.status === "error" ? (
                  <X className="h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                ) : (
                  <Paperclip
                    className="h-4 w-4 shrink-0 text-emerald-600"
                    aria-hidden
                  />
                )}
                <div className="min-w-0 max-w-[220px]">
                  <div className="truncate text-xs font-medium text-slate-900">
                    {a.filename}
                  </div>
                  <div className="truncate text-[10px] text-slate-500">
                    {a.status === "loading"
                      ? "추출 중..."
                      : a.status === "error"
                        ? a.errorMessage ?? "Failed"
                        : `${(a.byteSize / 1024).toFixed(0)} KB · ${a.chars.toLocaleString()} chars`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
                  aria-label="Remove attachment"
                  title="Remove"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            attachments.length > 0
              ? tChat("placeholderWithFiles")
              : hasPriorTurns
                ? tChat("placeholderFollowUp")
                : tChat("placeholder")
          }
          rows={4}
          className="block w-full resize-none rounded-2xl bg-transparent px-5 pt-5 pb-2 text-[16px] font-medium leading-relaxed text-slate-900 outline-none placeholder:font-normal placeholder:text-slate-400"
          style={{ minHeight: 120 }}
        />

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.hwp"
              multiple
              hidden
              onChange={onFileInputChange}
            />
            <button
              type="button"
              onClick={onPickFiles}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title={tChat("attachFile")}
              aria-label={tChat("attachFile")}
            >
              <Paperclip className="h-4 w-4" aria-hidden />
            </button>
            {speechSupported && (
              <button
                type="button"
                onClick={toggleRecording}
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                  isRecording
                    ? "animate-pulse bg-rose-600 text-white hover:bg-rose-700"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700",
                )}
                title={
                  isRecording ? tChat("stopRecording") : tChat("startRecording")
                }
                aria-pressed={isRecording}
              >
                {isRecording ? (
                  <MicOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Mic className="h-4 w-4" aria-hidden />
                )}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSending && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {tChat("thinkingN", { count: selectedModelIds.length })}
              </span>
            )}
            {isSending ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700"
                aria-label={tChat("stop")}
              >
                <Square className="h-3 w-3 fill-current" aria-hidden />
                {tChat("stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSend()}
                disabled={!canSend}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                  canSend
                    ? "bg-slate-900 text-white hover:bg-slate-800"
                    : "bg-slate-200 text-slate-400",
                )}
                aria-label={tChat("send")}
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                {tChat("send")}
                {selectedModelIds.length > 1 && (
                  <span className="ml-0.5 rounded-full bg-white/20 px-1.5 text-[10px] font-bold">
                    ×{selectedModelIds.length}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {tCommon("error")}: {error}
        </div>
      )}

      <ActionChips onAction={handleChipAction} />
    </div>
  );
}
