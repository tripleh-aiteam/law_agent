"use client";

import * as React from "react";

import type { LegalElements, PrecedentMatch } from "@/lib/types";

export type CaseFile = {
  id: string;
  name: string;
  /** Translation key (e.g. "sidebar.untitledCase") used instead of `name` when the
   * name was system-generated. Cleared once the user explicitly renames. */
  nameKey?: string;
  narrative: string;
  elements?: LegalElements;
  matches?: PrecedentMatch[];
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
  /** AI model selected for LLM tasks (extract / search rerank / dashboard). */
  selectedModelId: string | null;
};

type CasesContextValue = {
  folders: Folder[];
  currentCaseId: string | null;
  currentCase: CaseFile | null;
  /** Folder ID of the parent folder of the currently-selected case (null if none). */
  currentFolderId: string | null;
  /** Currently-selected LLM model ID (e.g. "anthropic/claude-opus-4-7"). */
  selectedModelId: string | null;
  /** Setter for the selected model — persists to localStorage. */
  setSelectedModelId: (modelId: string) => void;
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
      Pick<CaseFile, "narrative" | "elements" | "matches" | "name">
    >,
  ) => void;
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
  if (typeof window === "undefined") {
    return { folders: [], currentCaseId: null, selectedModelId: null };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { folders: [], currentCaseId: null, selectedModelId: null };
    const parsed = JSON.parse(raw) as StoredState;
    if (!parsed || !Array.isArray(parsed.folders)) {
      return { folders: [], currentCaseId: null, selectedModelId: null };
    }
    return {
      folders: migrateFolders(parsed.folders),
      currentCaseId: parsed.currentCaseId ?? null,
      selectedModelId: parsed.selectedModelId ?? null,
    };
  } catch {
    return { folders: [], currentCaseId: null, selectedModelId: null };
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
    selectedModelId: null,
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
        Pick<CaseFile, "narrative" | "elements" | "matches" | "name">
      >,
    ) => {
      setState((s) => ({
        ...s,
        folders: updateCaseInTree(s.folders, caseId, patch),
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

  const setSelectedModelId = React.useCallback((modelId: string) => {
    setState((s) => ({ ...s, selectedModelId: modelId }));
  }, []);

  const value: CasesContextValue = {
    folders: state.folders,
    currentCaseId: state.currentCaseId,
    currentCase,
    currentFolderId,
    selectedModelId: state.selectedModelId,
    setSelectedModelId,
    createFolder,
    deleteFolder,
    renameFolder,
    createCase,
    deleteCase,
    renameCase,
    selectCase,
    updateCase,
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
