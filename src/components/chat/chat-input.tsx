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
  /** Present only when the request used Mixture-of-Agents (auto/...). */
  candidates?: Array<{
    modelId: string;
    status: "ok" | "failed";
    error?: string;
  }>;
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

export function ChatInput() {
  const tChat = useTranslations("chat");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const {
    currentCaseId,
    createCase,
    selectCase,
    selectedModelId,
    appendTurn,
    updateTurn,
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

  /** AbortController for the in-flight extract+search pipeline. Stored in a
   * ref (not state) because clicking Stop must fire the abort synchronously
   * — React state updates would queue the abort behind a re-render. */
  const abortRef = React.useRef<AbortController | null>(null);

  // Detect Web Speech API after mount only — checking `window` during SSR/hydration
  // would render different markup on server vs client and break hydration.
  const [speechSupported, setSpeechSupported] = React.useState(false);
  React.useEffect(() => {
    const ctor = getSpeechRecognitionCtor();
    speechCtorRef.current = ctor;
    setSpeechSupported(ctor !== null);
  }, []);

  // On case switch: clear textarea + attachments + abort any in-flight pipeline.
  React.useEffect(() => {
    setValue("");
    setAttachments([]);
    abortRef.current?.abort();
    abortRef.current = null;
    setIsSending(false);
  }, [currentCaseId]);

  // Autoresize the textarea up to ~6 lines, then scroll.
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
        // Optimistically push a "loading" attachment chip — never inject
        // the extracted text into the textarea (that's Manus-style:
        // the file is CONTEXT, the textarea is the QUESTION).
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
   *  question (the textarea text) with the attached files. The user's
   *  question is placed FIRST and clearly labeled so the LLM treats it
   *  as the primary signal, with files as supplementary context. */
  const buildNarrative = React.useCallback(
    (question: string, currentAttachments: Attachment[]): string => {
      const q = question.trim();
      const ready = currentAttachments.filter(
        (a) => a.status === "ready" && a.text.length > 0,
      );
      if (ready.length === 0) return q;
      const fileBlocks = ready
        .map((a) => `[첨부파일 / Attached file: ${a.filename}]\n${a.text}`)
        .join("\n\n---\n\n");
      if (!q) return fileBlocks;
      return `[사용자 질의 / User question]\n${q}\n\n---\n\n${fileBlocks}`;
    },
    [],
  );

  const onPickFiles = () => {
    fileInputRef.current?.click();
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
    // Reset so picking the same file again still fires.
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
      rec.onerror = () => {
        setIsRecording(false);
      };
      rec.onend = () => {
        setIsRecording(false);
      };
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
  // Allow sending if the user typed >= 10 chars OR has at least one ready file.
  const canSend =
    !isSending && (value.trim().length >= 10 || hasReadyAttachments);

  const onStop = () => {
    // Synchronously abort the in-flight fetches. The catch block in onSend
    // will mark the turn as "cancelled".
    abortRef.current?.abort();
  };

  const onSend = async () => {
    const questionText = value.trim();
    const snapshotAttachments = attachments;
    const narrative = buildNarrative(value, snapshotAttachments);
    if (!narrative) return;

    // Make sure we have an active case to write into.
    let targetId = currentCaseId;
    if (!targetId) {
      // No name passed → createCase uses translatable nameKey "sidebar.untitledCase".
      targetId = createCase(null);
      selectCase(targetId);
    }

    // Snapshot of attached filenames at ask-time so the turn shows them even
    // after we clear the attachments after send.
    const attachmentNames = snapshotAttachments
      .filter((a) => a.status === "ready")
      .map((a) => a.filename);

    // Create the turn with status="pending" so the thread immediately shows
    // Q + a loading bubble. The Stop button uses this turn's id to know
    // which one to mark cancelled.
    const turnId = uid();
    const pendingTurn: CaseTurn = {
      id: turnId,
      question:
        questionText ||
        (attachmentNames.length > 0
          ? attachmentNames.join(", ")
          : ""),
      createdAt: new Date().toISOString(),
      modelId: selectedModelId ?? undefined,
      attachmentNames: attachmentNames.length > 0 ? attachmentNames : undefined,
      narrative,
      status: "pending",
    };
    appendTurn(targetId, pendingTurn);

    // Clear textarea + attachments immediately. The Q is now part of the
    // thread; the input is ready for the next question even while this one
    // is still running (Manus-style).
    setValue("");
    setAttachments([]);
    setError(null);

    const ac = new AbortController();
    abortRef.current = ac;
    setIsSending(true);

    try {
      const exRes = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrative,
          locale,
          model: selectedModelId ?? undefined,
        }),
        signal: ac.signal,
      });
      if (!exRes.ok) {
        const body = (await exRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          body?.error ?? `Extract failed: ${exRes.status}`,
        );
      }
      const exData = (await exRes.json()) as ExtractResponse;

      // Persist summary + elements + (optional) MoA audit onto the turn
      // right away — even if search fails afterwards, the user still sees
      // the document summary (which is the main thing they want for
      // "summarize this PDF" requests).
      updateTurn(targetId, turnId, {
        elements: exData.elements,
        summary: exData.summary,
        moaCandidates: exData.candidates,
      });

      const srRes = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrative,
          elements: exData.elements,
          locale,
          model: selectedModelId ?? undefined,
        }),
        signal: ac.signal,
      });
      if (!srRes.ok) {
        // Search failed but we still have a summary — keep the turn
        // "complete" with whatever we have rather than marking the whole
        // turn as errored.
        updateTurn(targetId, turnId, {
          status: "complete",
          matches: [],
        });
      } else {
        const srData = (await srRes.json()) as SearchResponse;
        updateTurn(targetId, turnId, {
          status: "complete",
          matches: srData.matches ?? [],
        });
      }
    } catch (err: unknown) {
      // AbortError → Stop button was pressed.
      if (
        err instanceof DOMException && err.name === "AbortError"
      ) {
        updateTurn(targetId, turnId, { status: "cancelled" });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        updateTurn(targetId, turnId, {
          status: "error",
          error: message,
        });
        setError(message);
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setIsSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

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

        {/* Attachment chip area — shows above the textarea so users see
            their files as CONTEXT, separate from their question. */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 pt-3 pb-3">
            {attachments.map((a) => (
              <div
                key={a.id}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                  a.status === "loading" &&
                    "border-slate-200 bg-slate-50",
                  a.status === "ready" &&
                    "border-emerald-200 bg-emerald-50",
                  a.status === "error" &&
                    "border-rose-200 bg-rose-50",
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
                aria-label={
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
                {tChat("thinking")}
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
                onClick={onSend}
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

      <ActionChips onSelect={replaceWithPrefix} />
    </div>
  );
}
