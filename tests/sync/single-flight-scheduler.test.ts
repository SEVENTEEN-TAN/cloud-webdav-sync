import assert from "node:assert/strict";
import test from "node:test";

import {
  SingleFlightSyncScheduler,
  type SyncTrigger
} from "../../src/sync/single-flight-scheduler.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("requests received during a run are coalesced into exactly one following run", async () => {
  const gates = [deferred(), deferred()];
  const runs: SyncTrigger[][] = [];
  let activeRuns = 0;
  let maximumActiveRuns = 0;

  const scheduler = new SingleFlightSyncScheduler(async (triggers) => {
    activeRuns += 1;
    maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
    runs.push([...triggers]);
    await gates[runs.length - 1]?.promise;
    activeRuns -= 1;
  });

  const first = scheduler.request("manual");
  await Promise.resolve();
  const second = scheduler.request("file-change");
  const third = scheduler.request("interval");

  assert.equal(runs.length, 1);
  assert.equal(scheduler.pendingCount, 2);

  gates[0]?.resolve();
  await first;
  await Promise.resolve();

  assert.deepEqual(runs, [["manual"], ["file-change", "interval"]]);
  assert.equal(maximumActiveRuns, 1);

  gates[1]?.resolve();
  await Promise.all([second, third]);
  assert.equal(scheduler.isRunning, false);
  assert.equal(scheduler.pendingCount, 0);
});

test("exclusive requests are ordered barriers between coalesced normal runs", async () => {
  const firstRunGate = deferred();
  const secondRunGate = deferred();
  const exclusiveGate = deferred();
  const order: string[] = [];
  let runCount = 0;
  const scheduler = new SingleFlightSyncScheduler(async (triggers) => {
    runCount += 1;
    order.push(`normal:${triggers.join(",")}`);
    if (runCount === 1) await firstRunGate.promise;
    if (runCount === 2) await secondRunGate.promise;
  });
  const first = scheduler.request("manual");
  const beforeBarrier = scheduler.request("file-change");
  const exclusive = scheduler.requestExclusive(async () => {
    order.push("exclusive");
    await exclusiveGate.promise;
  });
  const afterBarrierA = scheduler.request("interval");
  const afterBarrierB = scheduler.request("resume");
  assert.deepEqual(order, ["normal:manual"]);
  firstRunGate.resolve();
  await first;
  await Promise.resolve();
  assert.deepEqual(order, ["normal:manual", "normal:file-change"]);
  secondRunGate.resolve();
  await beforeBarrier;
  await Promise.resolve();
  assert.deepEqual(order, ["normal:manual", "normal:file-change", "exclusive"]);
  exclusiveGate.resolve();
  await exclusive;
  await Promise.resolve();
  assert.deepEqual(order, [
    "normal:manual",
    "normal:file-change",
    "exclusive",
    "normal:interval,resume",
  ]);
  await Promise.all([afterBarrierA, afterBarrierB]);
});
test("a failed exclusive request rejects only itself and continues draining", async () => {
  const order: string[] = [];
  const scheduler = new SingleFlightSyncScheduler(async (triggers) => {
    order.push(`normal:${triggers.join(",")}`);
  });
  const exclusive = scheduler.requestExclusive(async () => {
    order.push("exclusive");
    throw new Error("force failed");
  });
  const normal = scheduler.request("retry");
  await assert.rejects(exclusive, /force failed/);
  await normal;
  assert.deepEqual(order, ["exclusive", "normal:retry"]);
});
test("a failed run rejects only its own requests and still processes queued requests", async () => {
  const firstGate = deferred();
  let runCount = 0;
  const scheduler = new SingleFlightSyncScheduler(async () => {
    runCount += 1;
    if (runCount === 1) {
      await firstGate.promise;
      throw new Error("network unavailable");
    }
  });

  const first = scheduler.request("manual");
  await Promise.resolve();
  const second = scheduler.request("retry");
  firstGate.resolve();

  await assert.rejects(first, /network unavailable/);
  await second;
  assert.equal(runCount, 2);
});
