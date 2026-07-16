import assert from "node:assert/strict";
import test from "node:test";
import { buildThreeWayDiff } from "../../src/ui/diff-lines";

test("highlights independent local and remote line changes against the base", () => {
  const diff = buildThreeWayDiff(
    "title\nbase\nend",
    "title\nlocal\nend",
    "title\nbase\nremote\nend",
  );

  assert.equal(diff.simplified, false);
  assert.deepEqual(diff.base.map(({ lineNumber, kind }) => [lineNumber, kind]), [
    [1, "context"],
    [2, "changed"],
    [3, "context"],
  ]);
  assert.deepEqual(diff.local.map(({ lineNumber, text, kind }) => [lineNumber, text, kind]), [
    [1, "title", "context"],
    [2, "local", "added"],
    [3, "end", "context"],
  ]);
  assert.deepEqual(diff.remote.map(({ lineNumber, text, kind }) => [lineNumber, text, kind]), [
    [1, "title", "context"],
    [2, "base", "context"],
    [3, "remote", "added"],
    [4, "end", "context"],
  ]);
});

test("falls back to a neutral view for oversized comparisons", () => {
  const lines = Array.from({ length: 1_226 }, (_, index) => `line ${index}`).join("\n");
  const diff = buildThreeWayDiff(lines, lines, lines);

  assert.equal(diff.simplified, true);
  assert.equal(diff.base.length, 1_226);
  assert.equal(diff.local.every(({ kind }) => kind === "context"), true);
});
