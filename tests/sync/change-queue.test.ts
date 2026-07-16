import assert from "node:assert/strict";
import test from "node:test";

import { ChangeQueue } from "../../src/sync/change-queue.ts";

test("change queue coalesces repeated changes into their net local effect", () => {
  const queue = new ChangeQueue();

  queue.enqueue({ kind: "create", path: "Notes/New.md", detectedAt: 1 });
  queue.enqueue({ kind: "modify", path: "Notes/New.md", detectedAt: 2 });
  queue.enqueue({ kind: "modify", path: "Notes/Existing.md", detectedAt: 3 });
  queue.enqueue({ kind: "delete", path: "Notes/Existing.md", detectedAt: 4 });
  queue.enqueue({ kind: "delete", path: "Notes/Recreated.md", detectedAt: 5 });
  queue.enqueue({ kind: "create", path: "Notes/Recreated.md", detectedAt: 6 });

  assert.deepEqual(queue.snapshot(), [
    { kind: "create", path: "Notes/New.md", detectedAt: 2 },
    { kind: "delete", path: "Notes/Existing.md", detectedAt: 4 },
    { kind: "modify", path: "Notes/Recreated.md", detectedAt: 6 }
  ]);
});

test("creating and then deleting a path removes it from the queue", () => {
  const queue = new ChangeQueue();

  queue.enqueue({ kind: "create", path: "draft.md", detectedAt: 1 });
  queue.enqueue({ kind: "delete", path: "draft.md", detectedAt: 2 });

  assert.equal(queue.size, 0);
  assert.deepEqual(queue.snapshot(), []);
});

test("rename chains preserve the original path and final destination", () => {
  const queue = new ChangeQueue();

  queue.enqueue({
    kind: "rename",
    previousPath: "A.md",
    path: "B.md",
    detectedAt: 1
  });
  queue.enqueue({
    kind: "rename",
    previousPath: "B.md",
    path: "Folder/C.md",
    detectedAt: 2
  });

  assert.deepEqual(queue.snapshot(), [
    {
      kind: "rename",
      previousPath: "A.md",
      path: "Folder/C.md",
      detectedAt: 2
    }
  ]);
});

test("drain returns the current ordered snapshot and empties the queue", () => {
  const queue = new ChangeQueue();
  queue.enqueue({ kind: "modify", path: "B.md", detectedAt: 2 });
  queue.enqueue({ kind: "modify", path: "A.md", detectedAt: 1 });

  assert.deepEqual(queue.drain(), [
    { kind: "modify", path: "B.md", detectedAt: 2 },
    { kind: "modify", path: "A.md", detectedAt: 1 }
  ]);
  assert.equal(queue.size, 0);
});

test("acknowledge removes processed changes but preserves newer events", () => {
  const queue = new ChangeQueue();
  queue.enqueue({ kind: "modify", path: "a.md", detectedAt: 1 });
  queue.enqueue({ kind: "modify", path: "b.md", detectedAt: 1 });
  const processed = queue.snapshot();
  queue.enqueue({ kind: "modify", path: "b.md", detectedAt: 2 });

  queue.acknowledge(processed);

  assert.deepEqual(queue.snapshot(), [{ kind: "modify", path: "b.md", detectedAt: 2 }]);
});
