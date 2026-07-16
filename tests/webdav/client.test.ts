import assert from "node:assert/strict";
import test from "node:test";
import { WebDavClient } from "../../src/webdav/client";
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "../../src/webdav/types";

class FakeTransport implements WebDavTransport {
  readonly requests: WebDavRequest[] = [];

  constructor(private readonly responses: WebDavResponse[]) {}

  async request(request: WebDavRequest): Promise<WebDavResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    assert.ok(response, `Unexpected ${request.method} request`);
    return response;
  }
}

function response(status: number, headers: Record<string, string> = {}, text = ""): WebDavResponse {
  return { status, headers, text, arrayBuffer: new ArrayBuffer(0) };
}

function createClient(transport: WebDavTransport): WebDavClient {
  return new WebDavClient(
    {
      serverUrl: "https://dav.example.com/webdav",
      remoteRoot: "vault",
      credentials: { username: "user", password: "secret" },
    },
    transport,
  );
}

function moveProbeResponses(
  statuses: readonly number[] = [201, 412, 412, 412],
  targetCandidateIndex = 0,
): WebDavResponse[] {
  assert.equal(statuses.length, 4);
  return [
    response(201), response(201), response(201), response(201),
    ...statuses.map((status) => response(status)),
    response(200, {}, `obsidian-webdav-probe-move-candidate-${targetCandidateIndex}`),
  ];
}

test("MOVE uses an absolute destination URL and the requested overwrite mode", async () => {
  const transport = new FakeTransport([response(201), response(204)]);
  const client = createClient(transport);

  await client.move("source.txt", "locks/head.lock", false);
  await client.move("source-2.txt", "locks/head.lock", true);

  assert.equal(transport.requests[0]?.url, "https://dav.example.com/webdav/vault/source.txt");
  assert.equal(
    transport.requests[0]?.headers?.Destination,
    "https://dav.example.com/webdav/vault/locks/head.lock",
  );
  assert.equal(transport.requests[0]?.headers?.Overwrite, "F");
  assert.equal(transport.requests[1]?.headers?.Overwrite, "T");
});

test("creates every missing segment of a nested remote root", async () => {
  const transport = new FakeTransport([
    response(404), response(201),
    response(404), response(201),
  ]);
  const client = new WebDavClient(
    {
      serverUrl: "https://dav.example.com/webdav",
      remoteRoot: "parent/child",
      credentials: { username: "user", password: "secret" },
    },
    transport,
  );

  await client.ensureRemoteRoot();

  assert.deepEqual(transport.requests.map(({ method }) => method), ["HEAD", "MKCOL", "HEAD", "MKCOL"]);
  assert.equal(transport.requests[0]?.url, "https://dav.example.com/webdav/parent");
  assert.equal(transport.requests[2]?.url, "https://dav.example.com/webdav/parent/child");
});

test("automatically creates a missing configured root before capability probing", async () => {
  const transport = new FakeTransport([
    response(404),
    response(404), response(201),
    response(200),
    response(500),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, false);
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    "OPTIONS", "HEAD", "MKCOL", "OPTIONS", "MKCOL", "DELETE",
  ]);
  assert.equal(transport.requests[1]?.url, "https://dav.example.com/webdav/vault");
  assert.equal(transport.requests[2]?.url, "https://dav.example.com/webdav/vault");
});

test("creates the configured root when OPTIONS succeeds but child MKCOL reports a missing parent", async () => {
  const transport = new FakeTransport([
    response(200),
    response(409),
    response(404), response(201),
    response(201),
    response(500),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, false);
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    "OPTIONS", "MKCOL", "HEAD", "MKCOL", "MKCOL", "PUT", "DELETE",
  ]);
  assert.equal(transport.requests[2]?.url, "https://dav.example.com/webdav/vault");
  assert.equal(transport.requests[3]?.url, "https://dav.example.com/webdav/vault");
});

test("proves safe concurrent writes with strong ETag stale-write rejection", async () => {
  const transport = new FakeTransport([
    response(200, { DAV: "1, 2" }),
    response(201),
    response(201),
    response(412),
    response(200, {}, "obsidian-webdav-probe-v1"),
    response(200, { ETag: '"v1"' }),
    response(204),
    response(412),
    response(201),
    response(423),
    response(423),
    response(423),
    ...moveProbeResponses(),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.conditionalCreate, true);
  assert.equal(result.capabilities.strongEtag, true);
  assert.equal(result.capabilities.conditionalUpdate, true);
  assert.equal(result.capabilities.staleEtagRejected, true);
  assert.equal(result.capabilities.atomicMoveNoOverwrite, true);
  assert.equal(result.capabilities.atomicCollectionCreate, true);
  assert.equal(result.capabilities.headUpdateStrategy, "etag");
  assert.equal(result.capabilities.safeConcurrentWrites, true);
  assert.equal(result.capabilities.cleanupSucceeded, true);
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    "OPTIONS", "MKCOL", "PUT", "PUT", "GET", "HEAD", "PUT", "PUT",
    "MKCOL", "MKCOL", "MKCOL", "MKCOL",
    "PUT", "PUT", "PUT", "PUT", "MOVE", "MOVE", "MOVE", "MOVE", "GET", "DELETE",
  ]);
  assert.equal(transport.requests[2]?.headers?.["If-None-Match"], "*");
  assert.equal(transport.requests[3]?.headers?.["If-None-Match"], "*");
  assert.equal(transport.requests[6]?.headers?.["If-Match"], '"v1"');
  const moveRequests = transport.requests.filter(({ method }) => method === "MOVE");
  assert.equal(moveRequests.length, 4);
  assert.equal(moveRequests[0]?.headers?.Overwrite, "F");
  assert.equal(
    moveRequests[0]?.headers?.Destination,
    "https://dav.example.com/webdav/vault/" +
      transport.requests[1]?.url.split("/").at(-1) +
      "/move-lock-target.txt",
  );
});

test("cleans the temporary collection when probing fails", async () => {
  const transport = new FakeTransport([
    response(200),
    response(201),
    response(500),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PUT_FAILED");
  assert.equal(result.capabilities.cleanupSucceeded, true);
  assert.equal(transport.requests.at(-1)?.method, "DELETE");
});

test("does not claim concurrent safety for a weak ETag", async () => {
  const transport = new FakeTransport([
    response(200), response(201), response(201), response(412),
    response(200, {}, "obsidian-webdav-probe-v1"), response(200, { etag: 'W/"v1"' }),
    response(204), response(412), response(201), response(423), response(423), response(423),
    ...moveProbeResponses(),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.strongEtag, false);
  assert.equal(result.capabilities.headUpdateStrategy, null);
  assert.equal(result.capabilities.safeConcurrentWrites, false);
});

test("falls back to PROPFIND and decodes XML entities when HEAD does not expose an ETag", async () => {
  const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getetag>&quot;v1&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>';
  const transport = new FakeTransport([
    response(200), response(201), response(201), response(412),
    response(200, {}, "obsidian-webdav-probe-v1"), response(200), response(207, {}, xml),
    response(204), response(412), response(201), response(423), response(423), response(423),
    ...moveProbeResponses(),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.safeConcurrentWrites, true);
  assert.equal(transport.requests[6]?.method, "PROPFIND");
  assert.equal(transport.requests[6]?.headers?.Depth, "0");
});

test("uses atomic MOVE when conditional creation is ignored but MOVE is safe", async () => {
  const transport = new FakeTransport([
    response(200), response(201), response(201), response(201),
    response(200, {}, "obsidian-webdav-probe-create-race"), response(200, { etag: '"v2"' }),
    response(204), response(201), response(201), response(423), response(423), response(423),
    ...moveProbeResponses(),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.conditionalCreate, false);
  assert.equal(result.capabilities.staleEtagRejected, false);
  assert.equal(result.capabilities.atomicMoveNoOverwrite, true);
  assert.equal(result.capabilities.atomicCollectionCreate, true);
  assert.equal(result.capabilities.headUpdateStrategy, "move-lock");
  assert.equal(result.capabilities.safeConcurrentWrites, true);
});

test("falls back to atomic MKCOL when MOVE no-overwrite is unsafe", async () => {
  const transport = new FakeTransport([
    response(200), response(201), response(201), response(412),
    response(200, {}, "obsidian-webdav-probe-v1"), response(200, { etag: '"v1"' }),
    response(204), response(201), response(201), response(423), response(423), response(423),
    ...moveProbeResponses([201, 201, 412, 412], 1),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.conditionalCreate, true);
  assert.equal(result.capabilities.atomicMoveNoOverwrite, false);
  assert.equal(result.capabilities.atomicCollectionCreate, true);
  assert.equal(result.capabilities.headUpdateStrategy, "mkcol-lock");
  assert.equal(result.capabilities.safeConcurrentWrites, true);
});

test("does not select a strategy when all safe update paths are unavailable", async () => {
  const transport = new FakeTransport([
    response(200), response(201), response(201), response(201),
    response(200, {}, "obsidian-webdav-probe-create-race"), response(200, { etag: '"v2"' }),
    response(204), response(201), response(201), response(423), response(423), response(423),
    ...moveProbeResponses([201, 201, 412, 412], 1),
    response(204),
  ]);

  const result = await createClient(transport).probeCapabilities();

  assert.equal(result.ok, true);
  assert.equal(result.capabilities.conditionalCreate, false);
  assert.equal(result.capabilities.atomicMoveNoOverwrite, false);
  assert.equal(result.capabilities.atomicCollectionCreate, true);
  assert.equal(result.capabilities.headUpdateStrategy, null);
  assert.equal(result.capabilities.safeConcurrentWrites, false);
});
