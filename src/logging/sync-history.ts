import type { SyncTrigger } from "../sync";

export type SyncHistoryOutcome =
  | "planned"
  | "up-to-date"
  | "pushed"
  | "pulled"
  | "merged"
  | "conflict"
  | "error";

export interface SyncHistoryEntry {
  id: string;
  startedAt: number;
  finishedAt: number;
  triggers: SyncTrigger[];
  outcome: SyncHistoryOutcome;
  pendingChanges: number;
  commitId?: string;
  message: string;
}

export function loadSyncHistory(value: unknown): SyncHistoryEntry[] {
  if (!isRecord(value) || !Array.isArray(value.syncHistory)) return [];
  return value.syncHistory.filter(isHistoryEntry).slice(-100).map((entry) => ({ ...entry }));
}

export function appendSyncHistory(
  history: readonly SyncHistoryEntry[],
  entry: SyncHistoryEntry,
  limit = 100,
): SyncHistoryEntry[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("history limit must be positive");
  return [...history, { ...entry }].slice(-limit);
}

function isHistoryEntry(value: unknown): value is SyncHistoryEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.finishedAt === "number" &&
    Array.isArray(value.triggers) &&
    typeof value.outcome === "string" &&
    typeof value.pendingChanges === "number" &&
    typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
