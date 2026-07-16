import assert from "node:assert/strict";
import test from "node:test";
import { planTreeSync } from "../../src/planning/tree-planner";
import type { RepositoryFileEntry, RepositoryTree } from "../../src/repository";

const text = (blob: string): RepositoryFileEntry => ({ blob, size: 1, kind: "text" });
const binary = (blob: string): RepositoryFileEntry => ({ blob, size: 1, kind: "binary" });

test("plans one-sided uploads, downloads, and deletions", () => {
  const base: RepositoryTree = {
    "local.md": text("a"), "remote.md": text("b"), "delete-remote.md": text("c"), "delete-local.md": text("d"),
  };
  const local: RepositoryTree = {
    "local.md": text("a2"), "remote.md": text("b"), "delete-local.md": text("d"),
  };
  const remote: RepositoryTree = {
    "local.md": text("a"), "remote.md": text("b2"), "delete-remote.md": text("c"),
  };

  assert.deepEqual(
    planTreeSync(base, local, remote).map(({ path, action }) => [path, action]),
    [
      ["delete-local.md", "delete-local"],
      ["delete-remote.md", "delete-remote"],
      ["local.md", "upload"],
      ["remote.md", "download"],
    ],
  );
});

test("recognizes converged edits and plans no operation", () => {
  assert.deepEqual(
    planTreeSync({ "a.md": text("base") }, { "a.md": text("same") }, { "a.md": text("same") }),
    [],
  );
});

test("routes concurrent text edits to three-way merge", () => {
  const plan = planTreeSync(
    { "a.md": text("base") },
    { "a.md": text("local") },
    { "a.md": text("remote") },
  );
  assert.equal(plan[0]?.action, "merge-text");
});

test("classifies add-add, delete-modify, and binary conflicts", () => {
  const addAdd = planTreeSync({}, { "a.md": text("local") }, { "a.md": text("remote") });
  const deleteModify = planTreeSync(
    { "a.md": text("base") }, {}, { "a.md": text("remote") },
  );
  const binaryConflict = planTreeSync(
    { "a.png": binary("base") },
    { "a.png": binary("local") },
    { "a.png": binary("remote") },
  );

  assert.equal(addAdd[0]?.action, "conflict-add-add");
  assert.equal(deleteModify[0]?.action, "conflict-delete-modify");
  assert.equal(binaryConflict[0]?.action, "conflict-binary");
});

test("plans prototype-named root files using own properties only", () => {
  assert.deepEqual(
    planTreeSync(
      { constructor: text("base") },
      { constructor: text("base") },
      {},
    ).map(({ path, action }) => [path, action]),
    [["constructor", "delete-local"]],
  );
  assert.deepEqual(
    planTreeSync({}, { toString: text("local") }, {}).map(({ path, action }) => [path, action]),
    [["toString", "upload"]],
  );
});
