import assert from "node:assert/strict";
import test from "node:test";

import { BoundedMemoryLog } from "../../src/logging/memory-log.ts";

test("memory log redacts secrets in messages and structured context", () => {
  const log = new BoundedMemoryLog({
    maxEntries: 10,
    maxBytes: 4_096,
    now: () => 123
  });

  log.info(
    "PUT https://alice:secret@example.com/vault?token=abc&file=note.md Authorization: Bearer xyz",
    {
      password: "plain-text",
      headers: {
        Authorization: "Basic Zm9vOmJhcg==",
        "Content-Type": "application/json"
      },
      nested: { accessToken: "token-value", safe: "visible" }
    }
  );

  const serialized = JSON.stringify(log.snapshot());
  assert.doesNotMatch(serialized, /alice|secret|abc|xyz|plain-text|Zm9v|token-value/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /visible/);
  assert.match(serialized, /Content-Type/);
});

test("memory log evicts oldest entries to satisfy count and byte bounds", () => {
  let now = 0;
  const log = new BoundedMemoryLog({
    maxEntries: 3,
    maxBytes: 360,
    now: () => ++now
  });

  for (let index = 0; index < 8; index += 1) {
    log.info("entry-" + index + "-" + "x".repeat(40));
  }

  const entries = log.snapshot();
  assert.ok(entries.length <= 3);
  assert.ok(log.sizeBytes <= 360);
  assert.equal(entries.at(-1)?.timestamp, 8);
  assert.doesNotMatch(entries.map((entry) => entry.message).join(" "), /entry-0/);
});

test("an oversized entry is truncated and retained within the byte limit", () => {
  const log = new BoundedMemoryLog({
    maxEntries: 5,
    maxBytes: 256,
    now: () => 1
  });

  log.error("x".repeat(2_000), { payload: "y".repeat(2_000) });

  const [entry] = log.snapshot();
  assert.ok(entry);
  assert.equal(entry.truncated, true);
  assert.ok(log.sizeBytes <= 256);
});

test("logging circular context never throws or exposes sensitive keys", () => {
  const circular: Record<string, unknown> = { apiKey: "secret-key" };
  circular.self = circular;
  const log = new BoundedMemoryLog({ maxEntries: 5, maxBytes: 1_024 });

  assert.doesNotThrow(() => log.warn("request failed", circular));
  const serialized = JSON.stringify(log.snapshot());
  assert.doesNotMatch(serialized, /secret-key/);
  assert.match(serialized, /\[Circular\]/);
});

test("an unreadable context cannot interrupt the caller", () => {
  const context = Object.defineProperty({}, "unsafe", {
    enumerable: true,
    get: () => {
      throw new Error("getter failure");
    }
  });
  const log = new BoundedMemoryLog({ maxEntries: 5, maxBytes: 1_024 });

  assert.doesNotThrow(() => log.error("sync failed", context));
  assert.match(JSON.stringify(log.snapshot()), /Unserializable context/);
});
