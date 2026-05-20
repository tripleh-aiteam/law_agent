"use client";

import * as React from "react";

import { safeModelIds, DEFAULT_SELECTED_MODEL_IDS } from "@/lib/models";
import type {
  CaseQuestion,
  CaseTurn,
  LegalElements,
  PrecedentMatch,
  TurnBranch,
} from "@/lib/types";

export type CaseFile = {
  id: string;
  name: string;
  /** Translation key (e.g. "sidebar.untitledCase") used instead of `name` when the
   * name was system-generated. Cleared once the user explicitly renames. */
  nameKey?: string;
  /** Latest combined narrative — kept so legacy CaseDashboard still works. */
  narrative: string;
  /** Mirrors the LATEST turn's elements; kept for any legacy reader. */
  elements?: LegalElements;
  /** Mirrors the LATEST turn's matches; kept for any legacy reader. */
  matches?: PrecedentMatch[];
  /** @deprecated Replaced by `turns`; only retained for back-compat hydration. */
  questions?: CaseQuestion[];
  /**
   * Ordered list of conversation turns. Each turn pairs ONE user question
   * with its OWN answer payload (summary + elements + matches). Oldest first
   * — the UI renders top-to-bottom so the most recent turn is at the bottom,
   * directly above the input box (Manus-style).
   */
  turns?: CaseTurn[];
  createdAt: string;
  updatedAt: string;
};

export type Folder = {
  id: string;
  name: string;
  nameKey?: string;
  cases: CaseFile[];
  subfolders: Folder[];
};

const STORAGE_KEY = "law-agent:cases";

type StoredState = {
  folders: Folder[];
  currentCaseId: string | null;
  /**
   * AI models selected for the next query. When this list has one entry,
   * the app behaves as a single-model chatbot. When it has 2+, the send
   * pipeline fans out in parallel and the UI renders results as tabs so
   * the user can compare and pick the best answer themselves.
   */
  selectedModelIds: string[];
};

type CasesContextValue = {
  folders: Folder[];
  currentCaseId: string | null;
  currentCase: CaseFile | null;
  /** Folder ID of the parent folder of the currently-selected case (null if none). */
  currentFolderId: string | null;
  /** Currently-selected LLM models. Always at least 1 entry. */
  selectedModelIds: string[];
  /** Replace the entire selection (use for "Apply" in multi-select panel). */
  setSelectedModelIds: (modelIds: string[]) => void;
  /** Toggle a single model in/out of the selection. */
  toggleSelectedModel: (modelId: string) => void;
  createFolder: (parentFolderId?: string | null, name?: string) => string;
  deleteFolder: (folderId: string) => void;
  renameFolder: (folderId: string, name: string) => void;
  createCase: (folderId: string | null, name?: string) => string;
  deleteCase: (caseId: string) => void;
  renameCase: (caseId: string, name: string) => void;
  selectCase: (caseId: string | null) => void;
  updateCase: (
    caseId: string,
    patch: Partial<
      Pick<
        CaseFile,
        "narrative" | "elements" | "matches" | "name" | "questions" | "turns"
      >
    >,
  ) => void;
  /** Append a brand-new turn (Q with no answer yet) and return its id. */
  appendTurn: (caseId: string, turn: CaseTurn) => void;
  /** Patch fields on one turn (e.g. mark cancelled, set best branch). */
  updateTurn: (
    caseId: string,
    turnId: string,
    patch: Partial<CaseTurn>,
  ) => void;
  /**
   * Patch ONE branch of a turn (e.g. when its parallel /api/extract call
   * returns). Auto-recomputes the turn's aggregate status from the new
   * branch states.
   */
  updateTurnBranch: (
    caseId: string,
    turnId: string,
    modelId: string,
    patch: Partial<TurnBranch>,
  ) => void;
  /** Mark the user's preferred branch for a turn. */
  setBestBranch: (caseId: string, turnId: string, modelId: string) => void;
};

const CasesContext = React.createContext<CasesContextValue | null>(null);

function uid() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
  );
}

function nowIso() {
  return new Date().toISOString();
}

// Maps known hardcoded default names (from earlier builds) onto translation keys
// so language toggle works for cases already saved in localStorage.
const LEGACY_FOLDER_NAMES: Record<string, string> = {
  "받은 사건": "sidebar.inbox",
  Inbox: "sidebar.inbox",
  "새 폴더": "sidebar.newFolderDefault",
  "New folder": "sidebar.newFolderDefault",
};
const LEGACY_CASE_NAMES: Record<string, string> = {
  "이름 없는 사건": "sidebar.untitledCase",
  "Untitled case": "sidebar.untitledCase",
};

function migrateFolders(folders: Folder[]): Folder[] {
  return folders.map((f) => ({
    ...f,
    nameKey: f.nameKey ?? LEGACY_FOLDER_NAMES[f.name],
    cases: f.cases.map((c) => ({
      ...c,
      nameKey: c.nameKey ?? LEGACY_CASE_NAMES[c.name],
    })),
    subfolders: migrateFolders(f.subfolders),
  }));
}

function loadInitial(): StoredState {
  const empty: StoredState = {
    folders: [],
    currentCaseId: null,
    selectedModelIds: [...DEFAULT_SELECTED_MODEL_IDS],
  };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    // Older payloads used `selectedModelId: string | null`. The multi-model
    // refactor stores `selectedModelIds: string[]`. Detect either and
    // migrate to the new shape with `safeModelIds` (which also drops
    // models that are no longer in the registry).
    const parsed = JSON.parse(raw) as Partial<StoredState> & {
      selectedModelId?: string | null;
    };
    if (!parsed || !Array.isArray(parsed.folders)) return empty;
    const ids = Array.isArray(parsed.selectedModelIds)
      ? parsed.selectedModelIds
      : parsed.selectedModelId
        ? [parsed.selectedModelId]
        : [];
    return {
      folders: migrateFolders(parsed.folders),
      currentCaseId: parsed.currentCaseId ?? null,
      selectedModelIds: safeModelIds(ids),
    };
  } catch {
    return empty;
  }
}

function persist(state: StoredState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore (quota, private mode, etc.)
  }
}

// ---------- Tree helpers (pure) ----------

function mapFolders(
  folders: Folder[],
  visit: (folder: Folder) => Folder,
): Folder[] {
  return folders.map((f) => {
    const next = visit(f);
    return { ...next, subfolders: mapFolders(next.subfolders, visit) };
  });
}

function findFolder(folders: Folder[], folderId: string): Folder | null {
  for (const f of folders) {
    if (f.id === folderId) return f;
    const child = findFolder(f.subfolders, folderId);
    if (child) return child;
  }
  return null;
}

function findCase(folders: Folder[], caseId: string): CaseFile | null {
  for (const f of folders) {
    const direct = f.cases.find((c) => c.id === caseId);
    if (direct) return direct;
    const nested = findCase(f.subfolders, caseId);
    if (nested) return nested;
  }
  return null;
}

function findParentFolderId(folders: Folder[], caseId: string): string | null {
  for (const f of folders) {
    if (f.cases.some((c) => c.id === caseId)) return f.id;
    const nested = findParentFolderId(f.subfolders, caseId);
    if (nested) return nested;
  }
  return null;
}

function insertFolderInto(
  folders: Folder[],
  parentId: string | null,
  newFolder: Folder,
): Folder[] {
  if (parentId === null) {
    return [...folders, newFolder];
  }
  return folders.map((f) => {
    if (f.id === parentId) {
      return { ...f, subfolders: [...f.subfolders, newFolder] };
    }
    return { ...f, subfolders: insertFolderInto(f.subfolders, parentId, newFolder) };
  });
}

function removeFolder(folders: Folder[], folderId: string): Folder[] {
  return folders
    .filter((f) => f.id !== folderId)
    .map((f) => ({ ...f, subfolders: removeFolder(f.subfolders, folderId) }));
}

function renameFolderTree(
  folders: Folder[],
  folderId: string,
  name: string,
): Folder[] {
  return mapFolders(folders, (f) => (f.id === folderId ? { ...f, name } : f));
}

function addCaseTo(
  folders: Folder[],
  folderId: string | null,
  newCase: CaseFile,
): { folders: Folder[]; placedFolderId: string | null } {
  if (folderId === null) {
    // Create or reuse an "Inbox" top-level folder.
    if (folders.length === 0) {
      const inbox: Folder = {
        id: uid(),
        name: "",
        nameKey: "sidebar.inbox",
        cases: [newCase],
        subfolders: [],
      };
      return { folders: [inbox], placedFolderId: inbox.id };
    }
    const [first, ...rest] = folders;
    return {
      folders: [{ ...first, cases: [...first.cases, newCase] }, ...rest],
      placedFolderId: first.id,
    };
  }
  let placedFolderId: string | null = null;
  const next = mapFolders(folders, (f) => {
    if (f.id === folderId) {
      placedFolderId = f.id;
      return { ...f, cases: [...f.cases, newCase] };
    }
    return f;
  });
  return { folders: next, placedFolderId };
}

function removeCaseFromTree(folders: Folder[], caseId: string): Folder[] {
  return mapFolders(folders, (f) => ({
    ...f,
    cases: f.cases.filter((c) => c.id !== caseId),
  }));
}

function updateCaseInTree(
  folders: Folder[],
  caseId: string,
  patch: Partial<CaseFile>,
): Folder[] {
  return mapFolders(folders, (f) => ({
    ...f,
    cases: f.cases.map((c) =>
      c.id === caseId ? { ...c, ...patch, updatedAt: nowIso() } : c,
    ),
  }));
}

// ---------- Provider ----------

export function CasesProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<StoredState>({
    folders: [],
    currentCaseId: null,
    selectedModelIds: [...DEFAULT_SELECTED_MODEL_IDS],
  });
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setState(loadInitial());
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    if (!hydrated) return;
    persist(state);
  }, [state, hydrated]);

  const createFolder = React.useCallback(
    (parentFolderId: string | null = null, name?: string) => {
      const folder: Folder = {
        id: uid(),
        name: name ?? "",
        nameKey: name ? undefined : "sidebar.newFolderDefault",
        cases: [],
        subfolders: [],
      };
      setState((s) => ({
        ...s,
        folders: insertFolderInto(s.folders, parentFolderId, folder),
      }));
      return folder.id;
    },
    [],
  );

  const deleteFolder = React.useCallback((folderId: string) => {
    setState((s) => {
      const target = findFolder(s.folders, folderId);
      const removedIds = new Set<string>();
      function walk(f: Folder) {
        f.cases.forEach((c) => removedIds.add(c.id));
        f.subfolders.forEach(walk);
      }
      if (target) walk(target);
      return {
        ...s,
        folders: removeFolder(s.folders, folderId),
        currentCaseId:
          s.currentCaseId && removedIds.has(s.currentCaseId)
            ? null
            : s.currentCaseId,
      };
    });
  }, []);

  const renameFolder = React.useCallback((folderId: string, name: string) => {
    setState((s) => ({
      ...s,
      folders: mapFolders(s.folders, (f) =>
        f.id === folderId ? { ...f, name, nameKey: undefined } : f,
      ),
    }));
  }, []);

  const createCase = React.useCallback(
    (folderId: string | null, name?: string) => {
      const id = uid();
      const newCase: CaseFile = {
        id,
        name: name ?? "",
        nameKey: name ? undefined : "sidebar.untitledCase",
        narrative: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      setState((s) => {
        const { folders } = addCaseTo(s.folders, folderId, newCase);
        return { ...s, folders, currentCaseId: id };
      });
      return id;
    },
    [],
  );

  const deleteCase = React.useCallback((caseId: string) => {
    setState((s) => ({
      ...s,
      folders: removeCaseFromTree(s.folders, caseId),
      currentCaseId: s.currentCaseId === caseId ? null : s.currentCaseId,
    }));
  }, []);

  const renameCase = React.useCallback((caseId: string, name: string) => {
    setState((s) => ({
      ...s,
      folders: updateCaseInTree(s.folders, caseId, {
        name,
        nameKey: undefined,
      }),
    }));
  }, []);

  const selectCase = React.useCallback((caseId: string | null) => {
    setState((s) => ({ ...s, currentCaseId: caseId }));
  }, []);

  const updateCase = React.useCallback(
    (
      caseId: string,
      patch: Partial<
        Pick<
          CaseFile,
          "narrative" | "elements" | "matches" | "name" | "questions" | "turns"
        >
      >,
    ) => {
      setState((s) => ({
        ...s,
        folders: updateCaseInTree(s.folders, caseId, patch),
      }));
    },
    [],
  );

  const appendTurn = React.useCallback(
    (caseId: string, turn: CaseTurn) => {
      setState((s) => ({
        ...s,
        folders: mapFolders(s.folders, (f) => ({
          ...f,
          cases: f.cases.map((c) =>
            c.id === caseId
              ? {
                  ...c,
                  turns: [...(c.turns ?? []), turn],
                  updatedAt: nowIso(),
                }
              : c,
          ),
        })),
      }));
    },
    [],
  );

  /**
   * Compute a turn's aggregate status from its branches:
   *  - "pending"   if any branch is still pending
   *  - "complete"  if all branches are terminal AND at least one is complete
   *  - "cancelled" if all terminal branches are cancelled
   *  - "error"     if all terminal branches errored
   */
  function deriveTurnStatus(branches: TurnBranch[]): CaseTurn["status"] {
    if (branches.length === 0) return "pending";
    if (branches.some((b) => b.status === "pending")) return "pending";
    if (branches.some((b) => b.status === "complete")) return "complete";
    if (branches.every((b) => b.status === "cancelled")) return "cancelled";
    return "error";
  }

  const updateTurn = React.useCallback(
    (caseId: string, turnId: string, patch: Partial<CaseTurn>) => {
      setState((s) => ({
        ...s,
        folders: mapFolders(s.folders, (f) => ({
          ...f,
          cases: f.cases.map((c) =>
            c.id !== caseId
              ? c
              : {
                  ...c,
                  turns: (c.turns ?? []).map((t) =>
                    t.id === turnId ? { ...t, ...patch } : t,
                  ),
                  updatedAt: nowIso(),
                },
          ),
        })),
      }));
    },
    [],
  );

  const updateTurnBranch = React.useCallback(
    (
      caseId: string,
      turnId: string,
      modelId: string,
      patch: Partial<TurnBranch>,
    ) => {
      setState((s) => ({
        ...s,
        folders: mapFolders(s.folders, (f) => ({
          ...f,
          cases: f.cases.map((c) => {
            if (c.id !== caseId) return c;
            return {
              ...c,
              turns: (c.turns ?? []).map((t) => {
                if (t.id !== turnId) return t;
                const branches = (t.branches ?? []).map((b) =>
                  b.modelId === modelId ? { ...b, ...patch } : b,
                );
                return {
                  ...t,
                  branches,
                  status: deriveTurnStatus(branches),
                };
              }),
              updatedAt: nowIso(),
            };
          }),
        })),
      }));
    },
    [],
  );

  const setBestBranch = React.useCallback(
    (caseId: string, turnId: string, modelId: string) => {
      setState((s) => ({
        ...s,
        folders: mapFolders(s.folders, (f) => ({
          ...f,
          cases: f.cases.map((c) =>
            c.id !== caseId
              ? c
              : {
                  ...c,
                  turns: (c.turns ?? []).map((t) =>
                    t.id === turnId
                      ? {
                          ...t,
                          // Toggle: clicking the same model twice un-stars it.
                          bestBranchModelId:
                            t.bestBranchModelId === modelId
                              ? undefined
                              : modelId,
                        }
                      : t,
                  ),
                  updatedAt: nowIso(),
                },
          ),
        })),
      }));
    },
    [],
  );

  const currentCase = React.useMemo(
    () =>
      state.currentCaseId
        ? findCase(state.folders, state.currentCaseId)
        : null,
    [state.folders, state.currentCaseId],
  );

  const currentFolderId = React.useMemo(
    () =>
      state.currentCaseId
        ? findParentFolderId(state.folders, state.currentCaseId)
        : null,
    [state.folders, state.currentCaseId],
  );

  const setSelectedModelIds = React.useCallback((modelIds: string[]) => {
    setState((s) => ({ ...s, selectedModelIds: safeModelIds(modelIds) }));
  }, []);

  const toggleSelectedModel = React.useCallback((modelId: string) => {
    setState((s) => {
      const current = new Set(s.selectedModelIds);
      if (current.has(modelId)) {
        // Don't allow emptying the selection — at least one model must
        // remain so Send always has something to call.
        if (current.size <= 1) return s;
        current.delete(modelId);
      } else {
        current.add(modelId);
      }
      return { ...s, selectedModelIds: safeModelIds(Array.from(current)) };
    });
  }, []);

  const value: CasesContextValue = {
    folders: state.folders,
    currentCaseId: state.currentCaseId,
    currentCase,
    currentFolderId,
    selectedModelIds: state.selectedModelIds,
    setSelectedModelIds,
    toggleSelectedModel,
    createFolder,
    deleteFolder,
    renameFolder,
    createCase,
    deleteCase,
    renameCase,
    selectCase,
    updateCase,
    appendTurn,
    updateTurn,
    updateTurnBranch,
    setBestBranch,
  };

  return (
    <CasesContext.Provider value={value}>{children}</CasesContext.Provider>
  );
}

export function useCases() {
  const ctx = React.useContext(CasesContext);
  if (!ctx) {
    throw new Error("useCases must be used inside <CasesProvider>");
  }
  return ctx;
}
