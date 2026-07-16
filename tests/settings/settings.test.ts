import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  hasConnectionSettings,
  isPathInExcludedFolders,
  normalizeSettings,
} from "../../src/settings/settings";

test("normalizes persisted settings and rejects invalid numeric values", () => {
  const settings = normalizeSettings({
    serverUrl: "https://dav.example.com",
    autoSync: false,
    fileChangeDelayMs: -1,
    remotePollMinutes: Number.NaN,
    initialSyncPolicy: "unsafe-choice",
  });

  assert.equal(settings.serverUrl, "https://dav.example.com");
  assert.equal(settings.autoSync, false);
  assert.equal(settings.fileChangeDelayMs, DEFAULT_SETTINGS.fileChangeDelayMs);
  assert.equal(settings.remotePollMinutes, DEFAULT_SETTINGS.remotePollMinutes);
  assert.equal(settings.initialSyncPolicy, "stop");
});

test("bounds transfer concurrency to a safe range", () => {
  assert.equal(normalizeSettings({ transferConcurrency: 1 }).transferConcurrency, 1);
  assert.equal(normalizeSettings({ transferConcurrency: 16 }).transferConcurrency, 16);
  assert.equal(normalizeSettings({ transferConcurrency: 100 }).transferConcurrency, 16);
  assert.equal(
    normalizeSettings({ transferConcurrency: 0 }).transferConcurrency,
    DEFAULT_SETTINGS.transferConcurrency,
  );
});

test("requires all connection fields and a non-empty secret", () => {
  const settings = normalizeSettings({
    serverUrl: "https://dav.example.com",
    remoteRoot: "vault",
    username: "user",
  });

  assert.equal(hasConnectionSettings(settings, null), false);
  assert.equal(hasConnectionSettings(settings, ""), false);
  assert.equal(hasConnectionSettings(settings, "password"), true);
});

test("requires HTTPS except for explicit localhost development URLs", () => {
  const base = { remoteRoot: "vault", username: "user" };

  assert.equal(hasConnectionSettings(normalizeSettings({ ...base, serverUrl: "http://dav.example.com" }), "password"), false);
  assert.equal(hasConnectionSettings(normalizeSettings({ ...base, serverUrl: "https://dav.example.com" }), "password"), true);
  assert.equal(hasConnectionSettings(normalizeSettings({ ...base, serverUrl: "http://localhost:8080" }), "password"), true);
  assert.equal(hasConnectionSettings(normalizeSettings({ ...base, serverUrl: "http://127.0.0.1:8080" }), "password"), true);
  assert.equal(hasConnectionSettings(normalizeSettings({ ...base, serverUrl: "http://[::1]:8080" }), "password"), true);
});

test("rejects embedded URL credentials and ambiguous Basic Auth usernames", () => {
  assert.equal(hasConnectionSettings(normalizeSettings({
    serverUrl: "https://user:secret@dav.example.com",
    remoteRoot: "vault",
    username: "user",
  }), "password"), false);
  assert.equal(hasConnectionSettings(normalizeSettings({
    serverUrl: "https://dav.example.com",
    remoteRoot: "vault",
    username: "user:other",
  }), "password"), false);
});

test("normalizes manual excluded folder settings", () => {
  const settings = normalizeSettings({
    excludedFolders: [" cache ", "/exports/pdf/", "bad//path", "nested\\drafts", "cache"],
  });

  assert.deepEqual(settings.excludedFolders, ["cache", "exports/pdf", "nested/drafts"]);
  assert.equal(isPathInExcludedFolders("cache/a.md", settings.excludedFolders), true);
  assert.equal(isPathInExcludedFolders("exports/pdf", settings.excludedFolders), true);
  assert.equal(isPathInExcludedFolders("exports/pdf/a.md", settings.excludedFolders), true);
  assert.equal(isPathInExcludedFolders("exports/raw/a.md", settings.excludedFolders), false);
});
