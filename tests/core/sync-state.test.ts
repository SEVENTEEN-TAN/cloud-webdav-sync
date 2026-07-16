import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidSyncTransitionError,
  SyncStateMachine
} from "../../src/core/sync-state.ts";

test("sync state machine follows a normal synchronization lifecycle", () => {
  const machine = new SyncStateMachine("idle");

  machine.transitionTo("scanning");
  machine.transitionTo("checking-remote");
  machine.transitionTo("planning");
  machine.transitionTo("uploading");
  machine.transitionTo("updating-head");
  machine.transitionTo("idle");

  assert.equal(machine.current, "idle");
});

test("sync state machine rejects invalid transitions without changing state", () => {
  const machine = new SyncStateMachine("idle");

  assert.throws(
    () => machine.transitionTo("updating-head"),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSyncTransitionError);
      assert.equal(error.from, "idle");
      assert.equal(error.to, "updating-head");
      return true;
    }
  );
  assert.equal(machine.current, "idle");
});

test("sync state subscribers receive transitions and can unsubscribe", () => {
  const machine = new SyncStateMachine("unconfigured");
  const observed: string[] = [];
  const unsubscribe = machine.subscribe(({ from, to }) => {
    observed.push(from + "->" + to);
  });

  machine.transitionTo("idle");
  unsubscribe();
  machine.transitionTo("paused");

  assert.deepEqual(observed, ["unconfigured->idle"]);
});
