// Zero-dependency line diff (longest common subsequence), used by the Studio's Self-Healing Diff and the
// Legacy vs. Resurrected view. public/index.html ships an identical plain-JS copy between `lz-diff:start` and
// `lz-diff:end` markers; studio-ui.test.ts runs that shipped copy against this module on random inputs.

export type DiffKind = "same" | "del" | "add";

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
  /** 1-based line number in the old text (absent for added lines). */
  readonly oldLine?: number;
  /** 1-based line number in the new text (absent for deleted lines). */
  readonly newLine?: number;
}

/** Above this many cells (old lines x new lines, after trimming the common prefix/suffix) the LCS table is skipped. */
export const MAX_LCS_CELLS = 250_000;

/** Lines of a text: CRLF-normalized, without the empty piece a trailing newline would add. "" has no lines. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Minimal line diff from `oldText` to `newText`. Deletions come before additions inside a changed region, so a
 * replaced line reads as `-` then `+`. Unchanged lines carry both line numbers.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out: DiffLine[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i] ?? "", oldLine: i + 1, newLine: i + 1 });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_LCS_CELLS) {
    for (let i = start; i < endA; i++) out.push({ kind: "del", text: a[i] ?? "", oldLine: i + 1 });
    for (let j = start; j < endB; j++) out.push({ kind: "add", text: b[j] ?? "", newLine: j + 1 });
  } else {
    // lcs[i * (m + 1) + j] = LCS length of a[start + i ..] and b[start + j ..].
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] =
          a[start + i] === b[start + j] ? (lcs[(i + 1) * (m + 1) + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * (m + 1) + j] ?? 0, lcs[i * (m + 1) + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ kind: "same", text: a[start + i] ?? "", oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if ((lcs[(i + 1) * (m + 1) + j] ?? 0) >= (lcs[i * (m + 1) + j + 1] ?? 0)) {
        out.push({ kind: "del", text: a[start + i] ?? "", oldLine: start + i + 1 });
        i++;
      } else {
        out.push({ kind: "add", text: b[start + j] ?? "", newLine: start + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) out.push({ kind: "del", text: a[start + i] ?? "", oldLine: start + i + 1 });
    for (; j < m; j++) out.push({ kind: "add", text: b[start + j] ?? "", newLine: start + j + 1 });
  }
  for (let k = 0; k < a.length - endA; k++) out.push({ kind: "same", text: a[endA + k] ?? "", oldLine: endA + k + 1, newLine: endB + k + 1 });
  return out;
}

/** Counts per kind, e.g. for "3 lines rolled back, 3 lines verified". */
export function diffStats(lines: readonly DiffLine[]): { readonly added: number; readonly removed: number; readonly unchanged: number } {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}
