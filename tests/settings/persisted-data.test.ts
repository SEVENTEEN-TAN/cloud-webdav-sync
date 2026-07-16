import assert from "node:assert/strict";
import test from "node:test";
import { loadSyncSession, serializePluginData } from "../../src/settings/persisted-data";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";

test("loads an existing sync base and device identity", () => {
  assert.deepEqual(
    loadSyncSession({ syncState: { baseCommitId: "a".repeat(64), deviceId: "device-a" } }),
    { baseCommitId: "a".repeat(64), deviceId: "device-a", repositoryId: null },
  );
});

test("serializes settings without placing a password in plugin data", () => {
  const data = serializePluginData(
    { ...DEFAULT_SETTINGS },
    { baseCommitId: null, deviceId: "device", repositoryId: "repository" },
    [],
  );
  assert.equal("password" in data, false);
  assert.deepEqual(data.syncState, {
    baseCommitId: null,
    deviceId: "device",
    repositoryId: "repository",
  });
});

test("round-trips a pending local apply journal", () => {
  const pendingApply = {
    targetCommitId: "b".repeat(64),
    sourceBaseCommitId: "a".repeat(64),
    operationId: "operation-1",
  };
  const data = serializePluginData(
    { ...DEFAULT_SETTINGS },
    {
      baseCommitId: "a".repeat(64),
      deviceId: "device",
      repositoryId: "repository",
      pendingApply,
    },
  );

  assert.deepEqual(loadSyncSession(data), {
    baseCommitId: "a".repeat(64),
    deviceId: "device",
    repositoryId: "repository",
    pendingApply,
  });
});

test("ignores malformed pending apply journals", () => {
  assert.deepEqual(loadSyncSession({
    syncState: {
      baseCommitId: null,
      deviceId: "device",
      repositoryId: "repository",
      pendingApply: { targetCommitId: 42, sourceBaseCommitId: null, operationId: "" },
    },
  }), {
    baseCommitId: null,
    deviceId: "device",
    repositoryId: "repository",
  });
});
