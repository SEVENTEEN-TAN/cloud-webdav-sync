import assert from "node:assert/strict";
import test from "node:test";
import { validateCommitContent, validateRepositoryTree, validateStoredCommitShape } from "../../src/repository/validation";
import type { CommitContent, RepositoryTree, StoredCommit } from "../../src/repository";

const blob = "a".repeat(64);
const entry = { blob, size: 1, kind: "text" as const };

test("rejects excluded, escaping, absolute, and cross-platform unsafe paths", () => {
  for (const path of [
    ".obsidian/plugins/x/main.js",
    ".trash/x.md",
    ".git/config",
    "../outside.md",
    "/absolute.md",
    "a\\b.md",
    "CON.txt",
    "bad?.md",
  ]) {
    assert.throws(() => validateRepositoryTree({ [path]: entry }), /path/i, path);
  }
});

test("rejects case-insensitive and file-folder path collisions", () => {
  assert.throws(
    () => validateRepositoryTree({ "Note.md": entry, "note.md": entry }),
    /collision/,
  );
  assert.throws(
    () => validateRepositoryTree({ a: entry, "a/b.md": entry }),
    /file\/folder collision/,
  );
});

test("rejects malformed tree entries and repository identities", () => {
  assert.throws(
    () => validateRepositoryTree({ "note.md": { ...entry, blob: "bad" } }),
    /blob/,
  );
  const content: CommitContent = {
    formatVersion: 1,
    repositoryId: "repository-a",
    parents: [],
    deviceId: "device",
    createdAt: "2026-07-15T00:00:00.000Z",
    files: { "note.md": entry },
  };
  assert.throws(() => validateCommitContent(content, "repository-b"), /identity/);
});

test("validates a stored commit path ID before content hashing", () => {
  const commit = {
    commitId: "b".repeat(64),
    formatVersion: 1,
    repositoryId: "repository",
    parents: [],
    deviceId: "device",
    createdAt: "2026-07-15T00:00:00.000Z",
    files: {} as RepositoryTree,
  } satisfies StoredCommit;
  assert.throws(() => validateStoredCommitShape(commit, "c".repeat(64)), /repository path/);
});
