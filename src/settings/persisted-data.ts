import type { SyncSessionState } from "../sync";
import type { SyncHistoryEntry } from "../logging";
import type { WebDavSyncSettings } from "./settings";

export function loadSyncSession(value: unknown): SyncSessionState {
  const record = isRecord(value) && isRecord(value.syncState) ? value.syncState : {};
  const pendingApply = loadPendingApply(record.pendingApply);
  return {
    baseCommitId: typeof record.baseCommitId === "string" ? record.baseCommitId : null,
    deviceId: typeof record.deviceId === "string" && record.deviceId
      ? record.deviceId
      : crypto.randomUUID(),
    repositoryId: typeof record.repositoryId === "string" ? record.repositoryId : null,
    ...(pendingApply ? { pendingApply } : {}),
  };
}

export function serializePluginData(
  settings: WebDavSyncSettings,
  syncState: SyncSessionState,
  syncHistory: readonly SyncHistoryEntry[] = [],
): Record<string, unknown> {
  return {
    ...settings,
    syncState: { ...syncState },
    syncHistory: syncHistory.map((entry) => ({ ...entry })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadPendingApply(value: unknown): SyncSessionState["pendingApply"] {
  if (!isRecord(value)) return undefined;
  if (
    !isCommitId(value.targetCommitId) ||
    (value.sourceBaseCommitId !== null && !isCommitId(value.sourceBaseCommitId)) ||
    typeof value.operationId !== "string" ||
    !value.operationId ||
    value.operationId.length > 128
  ) {
    return undefined;
  }
  return {
    targetCommitId: value.targetCommitId,
    sourceBaseCommitId: value.sourceBaseCommitId,
    operationId: value.operationId,
  };
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
