/**
 * Document comparison (diff) utilities for legal text.
 *
 * Produces a unified diff that can be rendered in a side-by-side view.
 * Each "DiffRow" represents one screen row in the result — either:
 *  - "equal"   : same on both sides (gray)
 *  - "removed" : in original only (red strike on the left)
 *  - "added"   : in modified only (green on the right)
 *  - "changed" : differing line on the same row (red left + green right)
 *
 * The grouping is intentionally simple: we run line-level diff and then
 * pair adjacent remove+add blocks into "changed" rows so the side-by-side
 * UI doesn't show a sea of misaligned lines.
 */
import { diffLines, diffWords } from "diff";

export type DiffRowKind = "equal" | "removed" | "added" | "changed";

export interface InlineWordChange {
  text: string;
  kind: "equal" | "removed" | "added";
}

export interface DiffRow {
  kind: DiffRowKind;
  /** Original-side text (for equal/removed/changed). */
  originalText?: string;
  /** Modified-side text (for equal/added/changed). */
  modifiedText?: string;
  /** Word-level breakdown of a "changed" row — empty for other kinds. */
  inlineLeft?: InlineWordChange[];
  inlineRight?: InlineWordChange[];
}

export interface DiffResult {
  rows: DiffRow[];
  stats: {
    equalLines: number;
    removedLines: number;
    addedLines: number;
    changedLines: number;
  };
}

/**
 * Build a side-by-side diff from two text strings.
 * Handles Korean text correctly because jsdiff operates on Unicode codepoints.
 */
export function compareDocuments(
  original: string,
  modified: string,
): DiffResult {
  // 1. Line-level diff. Each "change" has { value, added?, removed? }.
  // value can contain multiple \n-separated lines.
  const lineChanges = diffLines(original, modified, {
    ignoreWhitespace: false,
    newlineIsToken: false,
  });

  // 2. Expand each change into individual lines so we can pair them up.
  type Item = { kind: "equal" | "removed" | "added"; line: string };
  const items: Item[] = [];
  for (const c of lineChanges) {
    // jsdiff's value typically ends with \n; split() leaves a trailing
    // empty string we discard.
    const lines = c.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const kind: Item["kind"] = c.added
        ? "added"
        : c.removed
          ? "removed"
          : "equal";
      items.push({ kind, line });
    }
  }

  // 3. Pair adjacent removed+added runs into "changed" rows so the UI
  // shows old + new side-by-side instead of stacked.
  const rows: DiffRow[] = [];
  let i = 0;
  let equalLines = 0;
  let removedLines = 0;
  let addedLines = 0;
  let changedLines = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === "equal") {
      rows.push({
        kind: "equal",
        originalText: it.line,
        modifiedText: it.line,
      });
      equalLines++;
      i++;
      continue;
    }

    // Gather consecutive removed lines, then consecutive added lines.
    const removed: string[] = [];
    while (i < items.length && items[i].kind === "removed") {
      removed.push(items[i].line);
      i++;
    }
    const added: string[] = [];
    while (i < items.length && items[i].kind === "added") {
      added.push(items[i].line);
      i++;
    }

    // Pair them up index-by-index for "changed" rows. Trailing
    // unmatched removed/added become standalone rows.
    const pairs = Math.min(removed.length, added.length);
    for (let p = 0; p < pairs; p++) {
      const left = removed[p];
      const right = added[p];
      const inline = diffWords(left, right);
      rows.push({
        kind: "changed",
        originalText: left,
        modifiedText: right,
        inlineLeft: inline
          .filter((w) => !w.added)
          .map((w) => ({
            text: w.value,
            kind: w.removed ? "removed" : "equal",
          })),
        inlineRight: inline
          .filter((w) => !w.removed)
          .map((w) => ({
            text: w.value,
            kind: w.added ? "added" : "equal",
          })),
      });
      changedLines++;
    }
    for (let p = pairs; p < removed.length; p++) {
      rows.push({ kind: "removed", originalText: removed[p] });
      removedLines++;
    }
    for (let p = pairs; p < added.length; p++) {
      rows.push({ kind: "added", modifiedText: added[p] });
      addedLines++;
    }
  }

  return {
    rows,
    stats: { equalLines, removedLines, addedLines, changedLines },
  };
}

/**
 * Build a plain-text summary of the diff for sending to an LLM that
 * analyzes the legal significance of the changes. Compact format:
 *   -- removed line
 *   ++ added line
 *   ~~ changed: "old" → "new"
 * Equal lines omitted unless they're context (we include ±1 line around
 * each change region).
 */
export function diffToTextForLlm(result: DiffResult): string {
  const lines: string[] = [];
  for (const row of result.rows) {
    if (row.kind === "removed") {
      lines.push(`-- ${row.originalText ?? ""}`);
    } else if (row.kind === "added") {
      lines.push(`++ ${row.modifiedText ?? ""}`);
    } else if (row.kind === "changed") {
      lines.push(
        `~~ "${row.originalText ?? ""}" → "${row.modifiedText ?? ""}"`,
      );
    }
    // equal lines omitted to keep the prompt compact
  }
  return lines.join("\n");
}
