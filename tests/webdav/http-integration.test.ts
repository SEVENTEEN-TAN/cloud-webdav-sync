import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { ContentAddressedRepository, createStoredCommit } from "../../src/repository";
import { WebDavClient } from "../../src/webdav/client";
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "../../src/webdav/types";

class FetchTransport implements WebDavTransport {
  async request(request: WebDavRequest): Promise<WebDavResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: new TextDecoder().decode(arrayBuffer),
      arrayBuffer,
    };
  }
}

test("runs the capability probe through real HTTP requests", async () => {
  const resources = new Map<string, { body: Uint8Array; etag: string }>();
  const collections = new Set(["/vault"]);
  let version = 0;
  let sawAuthorization = false;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.headers.authorization === "Basic dXNlcjpzZWNyZXQ=") sawAuthorization = true;
    await handleDavRequest(request, response, path, resources, collections, () => `"${++version}"`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new WebDavClient(
      {
        serverUrl: `http://127.0.0.1:${address.port}`,
        remoteRoot: "vault",
        credentials: { username: "user", password: "secret" },
      },
      new FetchTransport(),
    );
    const result = await client.probeCapabilities();
    assert.equal(result.ok, true);
    assert.equal(result.capabilities.conditionalCreate, true);
    assert.equal(result.capabilities.headUpdateStrategy, "etag");
    assert.equal(result.capabilities.safeConcurrentWrites, true);
    assert.equal(result.capabilities.cleanupSucceeded, true);
    assert.equal(sawAuthorization, true);
    assert.equal([...collections].some((path) => path.startsWith("/vault/probe-")), false);
    assert.equal([...resources].some(([path]) => path.startsWith("/vault/probe-")), false);

    const repository = new ContentAddressedRepository(client);
    const metadata = await repository.initialize(new Date("2026-07-15T00:00:00.000Z"));
    const data = new TextEncoder().encode("HTTP repository data").buffer;
    const blob = await repository.writeBlob(data);
    const commit = await createStoredCommit({
      formatVersion: 1,
      repositoryId: metadata.repositoryId,
      parents: [],
      deviceId: "http-test",
      createdAt: "2026-07-15T00:00:00.000Z",
      files: { "note.md": { blob, size: data.byteLength, kind: "text" } },
    });
    await repository.writeCommit(commit);
    const head = await repository.readHead();
    assert.deepEqual(
      await repository.compareAndSwapHead(head.etag, { commit: commit.commitId, generation: 1 }),
      { updated: true },
    );
    assert.equal((await repository.readCommit(commit.commitId)).commitId, commit.commitId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("uses the MOVE lease against a server that accepts stale If-Match", async () => {
  const resources = new Map<string, { body: Uint8Array; etag: string }>();
  const collections = new Set(["/vault"]);
  let version = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    await handleDavRequest(
      request,
      response,
      path,
      resources,
      collections,
      () => `"${++version}"`,
      {
        acceptStaleIfMatch: true,
        ignoreConditionalCreate: true,
        existingCollectionStatus: 423,
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new WebDavClient(
      {
        serverUrl: `http://127.0.0.1:${address.port}`,
        remoteRoot: "vault",
        credentials: { username: "user", password: "secret" },
      },
      new FetchTransport(),
    );
    const result = await client.probeCapabilities();
    assert.equal(result.ok, true);
    assert.equal(result.capabilities.conditionalCreate, false);
    assert.equal(result.capabilities.staleEtagRejected, false);
    assert.equal(result.capabilities.atomicCollectionCreate, true);
    assert.equal(result.capabilities.atomicMoveNoOverwrite, true);
    assert.equal(result.capabilities.headUpdateStrategy, "move-lock");
    assert.equal(result.capabilities.safeConcurrentWrites, true);

    const first = new ContentAddressedRepository(client, {
      headUpdateStrategy: "move-lock",
      conditionalCreate: false,
    });
    const second = new ContentAddressedRepository(client, {
      headUpdateStrategy: "move-lock",
      conditionalCreate: false,
    });
    await first.initialize();
    await second.initialize();
    const firstHead = await first.readHead();
    const secondHead = await second.readHead();

    assert.deepEqual(
      await first.compareAndSwapHead(firstHead.etag, { commit: "a".repeat(64), generation: 1 }),
      { updated: true },
    );
    assert.deepEqual(
      await second.compareAndSwapHead(secondHead.etag, { commit: "b".repeat(64), generation: 1 }),
      { updated: false, reason: "conflict" },
    );
    assert.equal((await first.readHead()).reference.commit, "a".repeat(64));
    assert.equal(collections.has("/vault/refs/head.lock"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

interface DavBehavior {
  acceptStaleIfMatch?: boolean;
  ignoreConditionalCreate?: boolean;
  existingCollectionStatus?: number;
}

async function handleDavRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  resources: Map<string, { body: Uint8Array; etag: string }>,
  collections: Set<string>,
  nextEtag: () => string,
  behavior: DavBehavior = {},
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(collections.has(path) ? 200 : 404, { DAV: "1, 2" }).end();
    return;
  }
  if (request.method === "MKCOL") {
    if (collections.has(path)) response.writeHead(behavior.existingCollectionStatus ?? 405).end();
    else {
      collections.add(path);
      response.writeHead(201).end();
    }
    return;
  }
  if (request.method === "MOVE") {
    const source = resources.get(path);
    const destination = request.headers.destination;
    if (!source || typeof destination !== "string") {
      response.writeHead(source ? 400 : 404).end();
      return;
    }
    const destinationPath = new URL(destination, "http://localhost").pathname;
    if (request.headers.overwrite === "F" && resources.has(destinationPath)) {
      response.writeHead(423).end();
      return;
    }
    resources.set(destinationPath, source);
    resources.delete(path);
    response.writeHead(201, { ETag: source.etag }).end();
    return;
  }
  if (request.method === "PUT") {
    const current = resources.get(path);
    if (!behavior.ignoreConditionalCreate && request.headers["if-none-match"] === "*" && current) {
      response.writeHead(412).end();
      return;
    }
    if (
      !behavior.acceptStaleIfMatch &&
      request.headers["if-match"] &&
      request.headers["if-match"] !== current?.etag
    ) {
      response.writeHead(412).end();
      return;
    }
    const body = await readBody(request);
    const etag = nextEtag();
    resources.set(path, { body, etag });
    response.writeHead(current ? 204 : 201, { ETag: etag }).end();
    return;
  }
  if (request.method === "HEAD") {
    const resource = resources.get(path);
    if (resource) response.writeHead(200, { ETag: resource.etag }).end();
    else response.writeHead(collections.has(path) ? 200 : 404).end();
    return;
  }
  if (request.method === "GET") {
    const resource = resources.get(path);
    if (!resource) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { ETag: resource.etag });
    response.end(resource.body);
    return;
  }
  if (request.method === "DELETE") {
    for (const key of [...resources.keys()]) if (key === path || key.startsWith(`${path}/`)) resources.delete(key);
    for (const key of [...collections]) if (key === path || key.startsWith(`${path}/`)) collections.delete(key);
    response.writeHead(204).end();
    return;
  }
  response.writeHead(405).end();
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
