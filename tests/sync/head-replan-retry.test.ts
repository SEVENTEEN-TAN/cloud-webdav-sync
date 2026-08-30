import assert from "node:assert/strict";
import test from "node:test";

import { decideHeadReplanRetry } from "../../src/sync/head-replan-retry.ts";

test("maxRetries counts retries after the initial attempt", () => {
  assert.deepEqual(decideHeadReplanRetry(0, 2), {
    shouldRetry: true,
    retryNumber: 1,
    maxRetries: 2,
  });
  assert.deepEqual(decideHeadReplanRetry(1, 2), {
    shouldRetry: true,
    retryNumber: 2,
    maxRetries: 2,
  });
  assert.deepEqual(decideHeadReplanRetry(2, 2), {
    shouldRetry: false,
    retryNumber: 3,
    maxRetries: 2,
  });
});

test("zero retries stops after the initial attempt", () => {
  assert.deepEqual(decideHeadReplanRetry(0, 0), {
    shouldRetry: false,
    retryNumber: 1,
    maxRetries: 0,
  });
});
