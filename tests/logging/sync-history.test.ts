import assert from "node:assert/strict";
import test from "node:test";
import { appendSyncHistory, loadSyncHistory, type SyncHistoryEntry } from "../../src/logging/sync-history";

const entry = (id: string): SyncHistoryEntry => ({
  id,
  startedAt: 1,
  finishedAt: 2,
  triggers: ["manual"],
  outcome: "pushed",
  pendingChanges: 1,
  commitId: "a".repeat(64),
  message: "Synchronization completed.",
});

test("loads only valid bounded persistent history entries", () => {
  const loaded = loadSyncHistory({ syncHistory: [null, { bad: true }, entry("valid")] });
  assert.deepEqual(loaded, [entry("valid")]);
});

test("appends history and evicts the oldest entries", () => {
  assert.deepEqual(
    appendSyncHistory([entry("one"), entry("two")], entry("three"), 2).map(({ id }) => id),
    ["two", "three"],
  );
});
