"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowUp,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  X,
} from "lucide-react";

import { useCases } from "@/components/cases/cases-context";
import { ActionChips } from "@/components/chat/action-chips";
import { cn } from "@/lib/utils";
import type {
  ClarifyingQuestion,
  LegalElements,
  PrecedentMatch,
} from "@/lib/types";

type Phase = "idle" | "extracting" | "searching";

type UploadState = {
  id: string;
  name: string;
  status: "uploading" | "done" | "error";
};

interface ExtractResponse {
  elements: LegalElements;
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

export function ChatInput() {
  const tChat = useTranslations("chat");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const {
    currentCase,
    currentCaseId,
    createCase,
    updateCase,
    selectCase,
    selectedModelId,
  } = useCases();

  const [value, setValue] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [uploads, setUploads] = React.useState<UploadState[]>([]);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  const baseTranscriptRef = React.useRef<string>("");
  const speechCtorRef = React.useRef<(new () => SpeechRecognitionLike) | null>(
    null,
  );

  // Detect Web Speech API after mount only — checking `window` during SSR/hydration
  // would render different markup on server vs client and break hydration.
  const [speechSupported, setSpeechSupported] = React.useState(false);
  React.useEffect(() => {
    const ctor = getSpeechRecognitionCtor();
    speechCtorRef.current = ctor;
    setSpeechSupported(ctor !== null);
  }, []);

  // Load narrative from selected case file.
  React.useEffect(() => {
    if (currentCase) {
      setValue(currentCase.narrative ?? "");
    } else {
      setValue("");
    }
  }, [currentCaseId, currentCase]);

  // Autoresize.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 320;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value]);

  const insertText = React.useCallback((extra: string) => {
    setValue((prev) => {
      if (!prev.trim()) return extra;
      return `${prev.trim()}\n\n${extra}`;
    });
  }, []);

  const replaceWithPrefix = React.useCallback((prefix: string) => {
    setValue((prev) => {
      const trimmed = prev.trim();
      if (trimmed.startsWith(prefix)) return prev;
      // If existing text is empty, just put the prefix.
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
        setUploads((u) => [
          ...u,
          { id, name: file.name, status: "uploading" },
        ]);
        try {
          const formData = new FormData();
          // Backend (/api/upload) reads from formData.getAll("files") — must be plural.
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
          if (extracted) {
            setValue((prev) => {
              const sep =
                prev.length > 0 && !prev.endsWith("\n") ? "\n\n" : "";
              return `${prev}${sep}---\n[FROM FILE: ${file.name}]\n${extracted}`;
            });
          } else if (extractedFile?.warnings?.length) {
            // No extracted text (e.g. HWP, scanned PDF) — surface the warning
            // inline instead of silently dropping the upload.
            console.warn(
              `[upload] ${file.name}: ${extractedFile.warnings.join("; ")}`,
            );
          }
          setUploads((u) =>
            u.map((it) =>
              it.id === id ? { ...it, status: "done" as const } : it,
            ),
          );
          // Remove the chip after a short delay.
          setTimeout(() => {
            setUploads((u) => u.filter((it) => it.id !== id));
          }, 1500);
        } catch (err) {
          console.error(err);
          setUploads((u) =>
            u.map((it) =>
              it.id === id ? { ...it, status: "error" as const } : it,
            ),
          );
        }
      }
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
  const canSend =
    phase === "idle" && value.trim().length >= 20;

  const onSend = async () => {
    const narrative = value.trim();
    if (!narrative) return;

    // Make sure we have an active case to write into.
    let targetId = currentCaseId;
    if (!targetId) {
      // No name passed → createCase uses translatable nameKey "sidebar.untitledCase".
      targetId = createCase(null);
      selectCase(targetId);
    }
    updateCase(targetId, { narrative });

    setPhase("extracting");
    setError(null);

    try {
      const exRes = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrative, locale, model: selectedModelId ?? undefined }),
      });
      if (!exRes.ok) throw new Error(`Extract failed: ${exRes.status}`);
      const exData = (await exRes.json()) as ExtractResponse;

      updateCase(targetId, { elements: exData.elements });

      setPhase("searching");
      const srRes = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrative,
          elements: exData.elements,
          locale,
          model: selectedModelId ?? undefined,
        }),
      });
      if (!srRes.ok) throw new Error(`Search failed: ${srRes.status}`);
      const srData = (await srRes.json()) as SearchResponse;
      updateCase(targetId, { matches: srData.matches ?? [] });
      setPhase("idle");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const isBusy = phase !== "idle";

  return (
    <div className="space-y-4">
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

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={tChat("placeholder")}
          disabled={isBusy}
          rows={4}
          className="block w-full resize-none rounded-2xl bg-transparent px-5 pt-5 pb-2 text-[15px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60"
          style={{ minHeight: 120 }}
        />

        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-2">
            {uploads.map((u) => (
              <span
                key={u.id}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]",
                  u.status === "uploading" &&
                    "bg-slate-100 text-slate-600",
                  u.status === "done" &&
                    "bg-emerald-100 text-emerald-700",
                  u.status === "error" && "bg-rose-100 text-rose-700",
                )}
              >
                {u.status === "uploading" && (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                )}
                <span className="max-w-[180px] truncate">{u.name}</span>
                {u.status === "error" && (
                  <X
                    className="h-3 w-3 cursor-pointer"
                    onClick={() =>
                      setUploads((us) => us.filter((it) => it.id !== u.id))
                    }
                    aria-hidden
                  />
                )}
              </span>
            ))}
          </div>
        )}

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
              disabled={isBusy}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              title={tChat("attachFile")}
              aria-label={tChat("attachFile")}
            >
              <Paperclip className="h-4 w-4" aria-hidden />
            </button>
            {speechSupported && (
              <button
                type="button"
                onClick={toggleRecording}
                disabled={isBusy}
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:opacity-50",
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
            {isBusy && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {phase === "extracting"
                  ? tChat("extracting")
                  : tCommon("searching")}
              </span>
            )}
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
