import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseInitialConflictPath,
  filterConflicts,
  getConflictResolutionProgress,
  moveConflictSelection,
} from "../../src/ui/conflict-resolution-model";

const conflicts = [
  { path: "a.md", canResolve: true },
  { path: "b.md", canResolve: true, choice: "local" as const },
  { path: "repository", canResolve: false },
];

test("requires every conflict to be resolvable and selected before continuing", () => {
  assert.deepEqual(getConflictResolutionProgress(conflicts), {
    total: 2,
    resolved: 1,
    unresolved: 1,
    canContinue: false,
  });

  assert.deepEqual(getConflictResolutionProgress([
    { path: "a.md", canResolve: true, choice: "local" as const },
    { path: "b.md", canResolve: true, choice: "remote" as const },
  ]), {
    total: 2,
    resolved: 2,
    unresolved: 0,
    canContinue: true,
  });
});

test("filters and navigates multiple conflicts predictably", () => {
  assert.deepEqual(filterConflicts(conflicts, "unresolved").map(({ path }) => path), ["a.md", "repository"]);
  assert.deepEqual(filterConflicts(conflicts, "resolved").map(({ path }) => path), ["b.md"]);
  assert.equal(chooseInitialConflictPath(conflicts), "a.md");
  assert.equal(moveConflictSelection(conflicts, "a.md", 1), "b.md");
  assert.equal(moveConflictSelection(conflicts, "b.md", -1), "a.md");
  assert.equal(moveConflictSelection(conflicts, "repository", 1), "repository");
});
