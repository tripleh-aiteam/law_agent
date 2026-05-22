"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Scale,
  Trash2,
} from "lucide-react";

import {
  useCases,
  type CaseFile,
  type Folder,
} from "@/components/cases/cases-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function InlineNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState(initial);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim() || initial)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value.trim() || initial);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-sm outline-none ring-2 ring-slate-300"
    />
  );
}

type EditingTarget =
  | { kind: "folder"; id: string }
  | { kind: "case"; id: string }
  | null;

function displayName(
  item: { name: string; nameKey?: string },
  t: (key: string) => string,
): string {
  if (item.nameKey) return t(item.nameKey);
  return item.name;
}

function FolderNode({
  folder,
  depth,
  expandedMap,
  toggleExpanded,
  editing,
  setEditing,
}: {
  folder: Folder;
  depth: number;
  expandedMap: Record<string, boolean>;
  toggleExpanded: (id: string) => void;
  editing: EditingTarget;
  setEditing: (e: EditingTarget) => void;
}) {
  const {
    currentCaseId,
    selectCase,
    createCase,
    createFolder,
    deleteFolder,
    renameFolder,
    deleteCase,
    renameCase,
  } = useCases();
  const t = useTranslations();
  const tSide = useTranslations("sidebar");
  const expanded = expandedMap[folder.id] ?? true;
  const folderLabel = displayName(folder, t);

  const hasContents =
    folder.cases.length > 0 || folder.subfolders.length > 0;

  return (
    <li>
      <div
        className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-slate-200/60"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        <button
          type="button"
          onClick={() => toggleExpanded(folder.id)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-300/60"
          aria-label={expanded ? "collapse" : "expand"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
        {expanded && hasContents ? (
          <FolderOpen
            className="h-4 w-4 shrink-0 text-amber-500"
            aria-hidden
          />
        ) : (
          <FolderIcon
            className="h-4 w-4 shrink-0 text-amber-500"
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          {editing?.kind === "folder" && editing.id === folder.id ? (
            <InlineNameInput
              initial={folderLabel}
              onCommit={(v) => {
                renameFolder(folder.id, v);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => setEditing({ kind: "folder", id: folder.id })}
              onClick={() => toggleExpanded(folder.id)}
              className="block w-full truncate text-left text-sm font-medium text-slate-700"
              title={folderLabel}
            >
              {folderLabel}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => {
              createCase(folder.id);
              if (!expanded) toggleExpanded(folder.id);
            }}
            title={tSide("addCase")}
            aria-label={tSide("addCase")}
            className="rounded p-1 text-emerald-600 hover:bg-emerald-100"
          >
            <FilePlus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              createFolder(folder.id);
              if (!expanded) toggleExpanded(folder.id);
            }}
            title={tSide("addFolder")}
            aria-label={tSide("addFolder")}
            className="rounded p-1 text-amber-600 hover:bg-amber-100"
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setEditing({ kind: "folder", id: folder.id })}
            title={tSide("rename")}
            className="rounded p-1 text-slate-500 hover:bg-slate-300/60 hover:text-slate-700"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(tSide("confirmDeleteFolder"))) {
                deleteFolder(folder.id);
              }
            }}
            title={tSide("delete")}
            className="rounded p-1 text-slate-500 hover:bg-rose-100 hover:text-rose-600"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {expanded && (
        <ul className="space-y-0.5">
          {folder.subfolders.map((sub) => (
            <FolderNode
              key={sub.id}
              folder={sub}
              depth={depth + 1}
              expandedMap={expandedMap}
              toggleExpanded={toggleExpanded}
              editing={editing}
              setEditing={setEditing}
            />
          ))}
          {folder.cases.map((c: CaseFile) => {
            const active = c.id === currentCaseId;
            const caseLabel = displayName(c, t);
            return (
              <li key={c.id}>
                <div
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-slate-200/60",
                    active && "bg-slate-200/80 hover:bg-slate-200/80",
                  )}
                  style={{ paddingLeft: `${(depth + 1) * 12 + 12}px` }}
                >
                  <FileText
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-slate-900" : "text-slate-400",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    {editing?.kind === "case" && editing.id === c.id ? (
                      <InlineNameInput
                        initial={caseLabel}
                        onCommit={(v) => {
                          renameCase(c.id, v);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => selectCase(c.id)}
                        onDoubleClick={() =>
                          setEditing({ kind: "case", id: c.id })
                        }
                        className={cn(
                          "block w-full truncate text-left text-sm",
                          active
                            ? "font-medium text-slate-900"
                            : "text-slate-600",
                        )}
                        title={caseLabel}
                      >
                        {caseLabel}
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => setEditing({ kind: "case", id: c.id })}
                      title={tSide("rename")}
                      className="rounded p-1 text-slate-500 hover:bg-slate-300/60 hover:text-slate-700"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(tSide("confirmDeleteCase"))) {
                          deleteCase(c.id);
                        }
                      }}
                      title={tSide("delete")}
                      className="rounded p-1 text-slate-500 hover:bg-rose-100 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({
  mobileOpen = false,
  onCloseMobile,
}: {
  /** Whether the off-canvas drawer is currently open on mobile (<md). */
  mobileOpen?: boolean;
  /** Called when the drawer should close — backdrop tap, case select, etc. */
  onCloseMobile?: () => void;
} = {}) {
  const tCommon = useTranslations("common");
  const tSide = useTranslations("sidebar");
  const { folders, createFolder, createCase, selectCase, currentFolderId } =
    useCases();
  const [expandedMap, setExpandedMap] = React.useState<
    Record<string, boolean>
  >({});
  const [editing, setEditing] = React.useState<EditingTarget>(null);

  const toggleExpanded = React.useCallback((id: string) => {
    setExpandedMap((m) => ({ ...m, [id]: !(m[id] ?? true) }));
  }, []);

  // Wrap selectCase so picking a case on mobile also closes the drawer —
  // otherwise the user has to tap the case, then the backdrop. We pass
  // this wrapper down only on mobile to keep desktop unaffected.
  const selectCaseAndMaybeClose = React.useCallback(
    (id: string) => {
      selectCase(id);
      onCloseMobile?.();
    },
    [selectCase, onCloseMobile],
  );

  const handleNewCase = React.useCallback(() => {
    // Target folder = parent of currently-selected case, else first top-level
    // folder, else null (createCase will auto-make an Inbox folder).
    const targetFolderId =
      currentFolderId ?? folders[0]?.id ?? null;
    const newId = createCase(targetFolderId);
    selectCaseAndMaybeClose(newId);
    // Make sure the target folder is expanded so the user sees the new case.
    if (targetFolderId) {
      setExpandedMap((m) => ({ ...m, [targetFolderId]: true }));
    }
    // Immediately enter rename mode for the new case so the user can name it.
    setEditing({ kind: "case", id: newId });
  }, [currentFolderId, folders, createCase, selectCaseAndMaybeClose]);

  return (
    <aside
      className={cn(
        "flex h-screen w-[280px] shrink-0 flex-col border-r border-slate-200 bg-white",
        // Mobile: off-canvas overlay that slides in from the left
        "fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0",
        mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full md:shadow-none",
      )}
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
          <Scale className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-slate-900">
            {tCommon("appName")}
          </div>
          <div className="truncate text-[11px] text-slate-500">
            {tCommon("appTagline")}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {folders.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-slate-400">
            {tSide("emptyState")}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {folders.map((f) => (
              <FolderNode
                key={f.id}
                folder={f}
                depth={0}
                expandedMap={expandedMap}
                toggleExpanded={toggleExpanded}
                editing={editing}
                setEditing={setEditing}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-slate-200 p-2">
        <Button
          type="button"
          onClick={handleNewCase}
          className="flex-1 justify-start gap-2 bg-slate-900 text-white hover:bg-slate-800"
        >
          <FilePlus className="h-4 w-4" aria-hidden />
          {tSide("newCase")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => createFolder(null)}
          title={tSide("newFolder")}
          aria-label={tSide("newFolder")}
          className="shrink-0 gap-1 border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
        >
          <FolderPlus className="h-4 w-4 text-amber-500" aria-hidden />
        </Button>
      </div>
    </aside>
  );
}
