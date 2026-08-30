import assert from "node:assert/strict";
import test from "node:test";
import { RetryingWebDavTransport, type RetryInfo } from "../../src/webdav/retrying-transport";
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "../../src/webdav/types";

class FlakyTransport implements WebDavTransport {
  failures: Array<() => never | WebDavResponse> = [];

  async request(request: WebDavRequest): Promise<WebDavResponse> {
    const next = this.failures.shift();
    if (next) return next();
    return response(200, {}, "ok");
  }
}

function response(status: number, headers: Record<string, string> = {}, body = ""): WebDavResponse {
  return { status, headers, text: body, arrayBuffer: new TextEncoder().encode(body).buffer };
}

const request: WebDavRequest = {
  url: "https://example.test/dav/file.txt",
  method: "GET",
  headers: {},
};

function delaysOf(retries: readonly RetryInfo[]): number[] {
  return retries.map(({ delayMs }) => delayMs);
}

test("retries a network failure and succeeds on a later attempt", async () => {
  const inner = new FlakyTransport();
  inner.failures.push(() => { throw new Error("net::ERR_CONNECTION_RESET"); });
  const retries: RetryInfo[] = [];
  const transport = new RetryingWebDavTransport(inner, {
    maxRetries: 2,
    sleep: async () => undefined,
    onRetry: (info) => retries.push(info),
  });

  const result = await transport.request(request);

  assert.equal(result.status, 200);
  assert.equal(inner.failures.length, 0);
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.reason, "network");
  assert.match(retries[0]?.error?.message ?? "", /CONNECTION_RESET/);
});

test("retries retryable HTTP statuses but not permanent ones", async () => {
  const flaky = new FlakyTransport();
  flaky.failures.push(() => response(502), () => response(503), () => response(423));
  const retries: RetryInfo[] = [];
  const transport = new RetryingWebDavTransport(flaky, {
    maxRetries: 3,
    sleep: async () => undefined,
    onRetry: (info) => retries.push(info),
  });

  const recovered = await transport.request(request);
  assert.equal(recovered.status, 423);
  assert.deepEqual(delaysOf(retries), [1000, 2000]);

  const permanent = new FlakyTransport();
  permanent.failures.push(() => response(404));
  const strict = new RetryingWebDavTransport(permanent, { maxRetries: 3, sleep: async () => undefined });
  const result = await strict.request(request);
  assert.equal(result.status, 404);
  assert.equal(permanent.failures.length, 0);
});

test("throws the last network error after exhausting retries", async () => {
  const inner = new FlakyTransport();
  inner.failures.push(
    () => { throw new Error("reset 1"); },
    () => { throw new Error("reset 2"); },
  );
  const transport = new RetryingWebDavTransport(inner, { maxRetries: 1, sleep: async () => undefined });

  await assert.rejects(() => transport.request(request), /reset 2/);
});

test("uses exponential backoff capped at the maximum delay", async () => {
  const inner = new FlakyTransport();
  inner.failures.push(
    () => { throw new Error("reset 1"); },
    () => { throw new Error("reset 2"); },
    () => { throw new Error("reset 3"); },
    () => { throw new Error("reset 4"); },
    () => { throw new Error("reset 5"); },
  );
  const retries: RetryInfo[] = [];
  const transport = new RetryingWebDavTransport(inner, {
    maxRetries: 4,
    baseDelayMs: 500,
    maxDelayMs: 1500,
    sleep: async () => undefined,
    onRetry: (info) => retries.push(info),
  });

  await assert.rejects(() => transport.request(request), /reset 5/);
  assert.deepEqual(delaysOf(retries), [500, 1000, 1500, 1500]);
});

test("returns the last retryable status once retries are exhausted", async () => {
  const inner = new FlakyTransport();
  inner.failures.push(() => response(503), () => response(503));
  const transport = new RetryingWebDavTransport(inner, { maxRetries: 1, sleep: async () => undefined });

  const result = await transport.request(request);
  assert.equal(result.status, 503);
  assert.equal(inner.failures.length, 0);
});

test("never replays mutating WebDAV methods after an ambiguous result", async () => {
  for (const method of ["PUT", "MOVE", "DELETE", "MKCOL", "LOCK", "UNLOCK"]) {
    const inner = new FlakyTransport();
    inner.failures.push(() => { throw new Error(`${method} reset`); }, () => response(200));
    const retries: RetryInfo[] = [];
    const transport = new RetryingWebDavTransport(inner, {
      maxRetries: 3,
      sleep: async () => undefined,
      onRetry: (info) => retries.push(info),
    });

    await assert.rejects(() => transport.request({ ...request, method }), new RegExp(`${method} reset`));
    assert.equal(inner.failures.length, 1, `${method} was replayed`);
    assert.deepEqual(retries, []);
  }
});

test("retries only the read-only WebDAV method allowlist", async () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "PROPFIND"]) {
    const inner = new FlakyTransport();
    inner.failures.push(() => response(503));
    const transport = new RetryingWebDavTransport(inner, { maxRetries: 1, sleep: async () => undefined });
    assert.equal((await transport.request({ ...request, method })).status, 200);
  }
});
