import assert from "node:assert/strict";
import test from "node:test";
import { mapLimit, mapLimitWeighted } from "../../src/concurrency/map-limit";

test("limits concurrent work and preserves result order", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapLimit([3, 1, 2, 4], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });

  assert.equal(maximum, 2);
  assert.deepEqual(results, [6, 2, 4, 8]);
});

test("rejects invalid concurrency", async () => {
  await assert.rejects(() => mapLimit([], 0, async () => 0), /positive integer/);
});

test("stops dispatching after the first failure and waits for in-flight work", async () => {
  const started: number[] = [];
  let inFlightFinished = false;

  await assert.rejects(
    () => mapLimit([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 1) throw new Error("failed");
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlightFinished = true;
      return value;
    }),
    /failed/,
  );

  assert.equal(inFlightFinished, true);
  assert.deepEqual(started.sort(), [0, 1]);
});

test("mapLimitWeighted limits concurrent task count", async () => {
  let active = 0;
  let maximum = 0;

  const results = await mapLimitWeighted(
    [1, 2, 3, 4],
    2,
    100,
    () => 1,
    async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value;
    },
  );

  assert.equal(maximum, 2);
  assert.deepEqual(results, [1, 2, 3, 4]);
});

test("mapLimitWeighted limits total in-flight weight", async () => {
  const weights = [3, 2, 4, 1];
  let activeWeight = 0;
  let maximumWeight = 0;
  let maximumTasks = 0;
  let activeTasks = 0;

  await mapLimitWeighted(
    weights,
    4,
    5,
    (weight) => weight,
    async (weight) => {
      activeTasks += 1;
      activeWeight += weight;
      maximumTasks = Math.max(maximumTasks, activeTasks);
      maximumWeight = Math.max(maximumWeight, activeWeight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWeight -= weight;
      activeTasks -= 1;
    },
  );

  assert.equal(maximumTasks, 2);
  assert.equal(maximumWeight, 5);
});

test("mapLimitWeighted lets an overweight task run alone", async () => {
  let releaseOverweight: (() => void) | undefined;
  const overweightBlocked = new Promise<void>((resolve) => {
    releaseOverweight = resolve;
  });
  const started: number[] = [];

  const resultPromise = mapLimitWeighted(
    [10, 1],
    2,
    5,
    (weight) => weight,
    async (weight) => {
      started.push(weight);
      if (weight === 10) await overweightBlocked;
      return weight;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, [10]);

  releaseOverweight?.();
  assert.deepEqual(await resultPromise, [10, 1]);
});

test("mapLimitWeighted preserves input result order", async () => {
  const results = await mapLimitWeighted(
    [30, 5, 15],
    3,
    3,
    () => 1,
    async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay * 2;
    },
  );

  assert.deepEqual(results, [60, 10, 30]);
});

test("mapLimitWeighted stops dispatching after failure and waits for in-flight work", async () => {
  const started: number[] = [];
  let inFlightFinished = false;

  await assert.rejects(
    () =>
      mapLimitWeighted(
        [0, 1, 2, 3],
        2,
        2,
        () => 1,
        async (value) => {
          started.push(value);
          if (value === 1) throw new Error("weighted failure");
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlightFinished = true;
          return value;
        },
      ),
    /weighted failure/,
  );

  assert.equal(inFlightFinished, true);
  assert.deepEqual(started.sort(), [0, 1]);
});

test("mapLimitWeighted validates limits and weights before dispatch", async () => {
  await assert.rejects(
    () => mapLimitWeighted([], 0, 1, () => 0, async () => 0),
    /positive integer/,
  );
  await assert.rejects(
    () => mapLimitWeighted([], 1, -1, () => 0, async () => 0),
    /non-negative finite number/,
  );
  await assert.rejects(
    () => mapLimitWeighted([], 1, Number.POSITIVE_INFINITY, () => 0, async () => 0),
    /non-negative finite number/,
  );

  let dispatched = false;
  await assert.rejects(
    () =>
      mapLimitWeighted(
        [1, 2],
        1,
        1,
        (_, index) => (index === 1 ? Number.NaN : 1),
        async () => {
          dispatched = true;
        },
      ),
    /weight at index 1 must be a non-negative finite number/,
  );
  assert.equal(dispatched, false);

  await assert.rejects(
    () => mapLimitWeighted([1], 1, 1, () => -1, async () => 0),
    /weight at index 0 must be a non-negative finite number/,
  );
});
