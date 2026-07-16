import type { ConflictChoice } from "../sync";

export type ConflictFilter = "all" | "unresolved" | "resolved";

export interface ConflictResolutionListItem {
  path: string;
  canResolve: boolean;
  choice?: ConflictChoice;
}

export interface ConflictResolutionProgress {
  total: number;
  resolved: number;
  unresolved: number;
  canContinue: boolean;
}

export function getConflictResolutionProgress(
  conflicts: readonly ConflictResolutionListItem[],
): ConflictResolutionProgress {
  const resolvable = conflicts.filter(({ canResolve }) => canResolve);
  const resolved = resolvable.filter(({ choice }) => choice !== undefined).length;
  return {
    total: resolvable.length,
    resolved,
    unresolved: resolvable.length - resolved,
    canContinue: conflicts.length > 0 && resolvable.length === conflicts.length && resolved === resolvable.length,
  };
}

export function filterConflicts<T extends ConflictResolutionListItem>(
  conflicts: readonly T[],
  filter: ConflictFilter,
): T[] {
  if (filter === "all") return [...conflicts];
  return conflicts.filter(({ choice }) => filter === "resolved" ? choice !== undefined : choice === undefined);
}

export function chooseInitialConflictPath(
  conflicts: readonly ConflictResolutionListItem[],
): string | null {
  return conflicts.find(({ choice }) => choice === undefined)?.path ?? conflicts[0]?.path ?? null;
}

export function moveConflictSelection(
  conflicts: readonly ConflictResolutionListItem[],
  currentPath: string | null,
  direction: -1 | 1,
): string | null {
  if (conflicts.length === 0) return null;
  const currentIndex = currentPath ? conflicts.findIndex(({ path }) => path === currentPath) : -1;
  if (currentIndex < 0) return direction === 1 ? conflicts[0]?.path ?? null : conflicts.at(-1)?.path ?? null;
  const nextIndex = Math.min(Math.max(currentIndex + direction, 0), conflicts.length - 1);
  return conflicts[nextIndex]?.path ?? null;
}
