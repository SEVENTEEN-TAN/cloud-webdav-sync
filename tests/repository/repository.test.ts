import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/repository/canonical-json";
import { createStoredCommit } from "../../src/repository/commit";
import { ContentAddressedRepository } from "../../src/repository/repository";
import { sha256Hex } from "../../src/repository/hash";
import {
  blobPath,
  commitPath,
  HEAD_LOCK_OWNER_PATH,
  HEAD_LOCK_PATH,
} from "../../src/repository/paths";
import type { RepositoryRemote } from "../../src/repository/types";
import type { WebDavResponse } from "../../src/webdav";

class MemoryRemote implements RepositoryRemote {
  private readonly resources = new Map<string, { body: string | ArrayBuffer; etag: string }>();
  private readonly collections = new Set<string>();
  private version = 0;
  ignoreConditionalCreate = false;

  seed(path: string, body: string | ArrayBuffer): void {
    this.resources.set(path, { body: copyBody(body), etag: `"${++this.version}"` });
  }

  seedCollection(path: string): void {
    this.collections.add(path);
  }

  async get(path: string): Promise<WebDavResponse> {
    const resource = this.resources.get(path);
    if (!resource) return response(404);
    return response(200, { ETag: resource.etag }, resource.body);
  }

  async getEtag(path: string): Promise<string | null> {
    return this.resources.get(path)?.etag ?? null;
  }

  async head(path: string): Promise<WebDavResponse> {
    if (this.collections.has(path)) return response(200);
    const resource = this.resources.get(path);
    return resource ? response(200, { ETag: resource.etag }) : response(404);
  }

  async put(
    path: string,
    body: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    const current = this.resources.get(path);
    if (!this.ignoreConditionalCreate && headers["If-None-Match"] === "*" && current) return response(412);
    if (headers["If-Match"] && headers["If-Match"] !== current?.etag) return response(412);
    const etag = `"${++this.version}"`;
    this.resources.set(path, { body: copyBody(body), etag });
    return response(current ? 204 : 201, { ETag: etag });
  }

  async move(sourcePath: string, destinationPath: string, overwrite = true): Promise<WebDavResponse> {
    const source = this.resources.get(sourcePath);
    if (!source) return response(404);
    if (!overwrite && this.resources.has(destinationPath)) return response(423);
    this.resources.set(destinationPath, source);
    this.resources.delete(sourcePath);
    return response(201, { ETag: source.etag });
  }

  async remove(path: string): Promise<WebDavResponse> {
    for (const key of [...this.resources.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.resources.delete(key);
    }
    for (const key of [...this.collections]) {
      if (key === path || key.startsWith(`${path}/`)) this.collections.delete(key);
    }
    return response(204);
  }

  async makeCollection(path: string): Promise<WebDavResponse> {
    if (this.collections.has(path)) return response(405);
    this.collections.add(path);
    return response(201);
  }
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body: string | ArrayBuffer = "",
): WebDavResponse {
  const arrayBuffer = typeof body === "string" ? new TextEncoder().encode(body).buffer : body.slice(0);
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  return { status, headers, text, arrayBuffer };
}

function copyBody(body: string | ArrayBuffer): string | ArrayBuffer {
  return typeof body === "string" ? body : body.slice(0);
}

test("canonical JSON is independent of object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test("canonical JSON preserves an enumerable __proto__ key", () => {
  const value = JSON.parse('{"__proto__":{"x":1},"safe":2}');
  assert.equal(canonicalJson(value), '{"__proto__":{"x":1},"safe":2}');
});

test("initializes one repository identity and an empty strong-ETag HEAD", async () => {
  const remote = new MemoryRemote();
  const first = new ContentAddressedRepository(remote);
  const second = new ContentAddressedRepository(remote);

  const firstMetadata = await first.initialize(new Date("2026-07-15T00:00:00.000Z"));
  const secondMetadata = await second.initialize(new Date("2026-07-16T00:00:00.000Z"));
  const head = await second.readHead();

  assert.equal(secondMetadata.repositoryId, firstMetadata.repositoryId);
  assert.deepEqual(head.reference, { commit: null, generation: 0 });
  assert.match(head.etag, /^"\d+"$/);
});

test("stores blobs and commits by verified content hash", async () => {
  const repository = new ContentAddressedRepository(new MemoryRemote());
  const metadata = await repository.initialize();
  const data = new TextEncoder().encode("hello repository").buffer;
  const blob = await repository.writeBlob(data);
  const restored = await repository.readBlob(blob);
  assert.equal(new TextDecoder().decode(restored), "hello repository");

  const commit = await createStoredCommit({
    formatVersion: 1,
    repositoryId: metadata.repositoryId,
    parents: [],
    deviceId: "test-device",
    createdAt: "2026-07-15T00:00:00.000Z",
    files: { "note.md": { blob, size: data.byteLength, kind: "text" } },
  });
  await repository.writeCommit(commit);
  assert.deepEqual(await repository.readCommit(commit.commitId), commit);
});

test("allows only one client to advance the same HEAD ETag", async () => {
  const remote = new MemoryRemote();
  const first = new ContentAddressedRepository(remote);
  const second = new ContentAddressedRepository(remote);
  await first.initialize();

  const firstView = await first.readHead();
  const secondView = await second.readHead();
  const firstResult = await first.compareAndSwapHead(firstView.etag, { commit: "a".repeat(64), generation: 1 });
  const secondResult = await second.compareAndSwapHead(secondView.etag, { commit: "b".repeat(64), generation: 1 });

  assert.deepEqual(firstResult, { updated: true });
  assert.deepEqual(secondResult, { updated: false, reason: "conflict" });
  assert.equal((await first.readHead()).reference.commit, "a".repeat(64));
});

test("allows only one client to advance HEAD through the MKCOL lock fallback", async () => {
  const remote = new MemoryRemote();
  const first = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "first",
  });
  const second = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "second",
  });
  await first.initialize();

  const firstView = await first.readHead();
  const secondView = await second.readHead();
  assert.deepEqual(
    await first.compareAndSwapHead(firstView.etag, { commit: "a".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.deepEqual(
    await second.compareAndSwapHead(secondView.etag, { commit: "b".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.equal((await first.readHead()).reference.commit, "a".repeat(64));
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 404);
});

test("uses MOVE locking when conditional creation is ignored", async () => {
  const remote = new MemoryRemote();
  remote.ignoreConditionalCreate = true;
  const first = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "first",
  });
  const second = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "second",
  });

  const firstMetadata = await first.initialize(new Date("2026-07-15T00:00:00.000Z"));
  const secondMetadata = await second.initialize(new Date("2026-07-16T00:00:00.000Z"));
  assert.equal(secondMetadata.repositoryId, firstMetadata.repositoryId);

  const firstView = await first.readHead();
  const secondView = await second.readHead();
  assert.deepEqual(
    await first.compareAndSwapHead(firstView.etag, { commit: "e".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.deepEqual(
    await second.compareAndSwapHead(secondView.etag, { commit: "f".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.equal((await first.readHead()).reference.commit, "e".repeat(64));
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 404);
});

test("fails closed instead of automatically deleting an expired MKCOL HEAD lease", async () => {
  const remote = new MemoryRemote();
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "current-owner",
    now: () => new Date(now),
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.seedCollection(HEAD_LOCK_PATH);
  remote.seed(HEAD_LOCK_OWNER_PATH, canonicalJson({
    formatVersion: 1,
    ownerId: "crashed-owner",
    expiresAt: now - 1,
  }));

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "c".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 200);
});

test("treats an active MKCOL HEAD lease as contention", async () => {
  const remote = new MemoryRemote();
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "current-owner",
    now: () => new Date(now),
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.seedCollection(HEAD_LOCK_PATH);
  remote.seed(HEAD_LOCK_OWNER_PATH, canonicalJson({
    formatVersion: 1,
    ownerId: "active-owner",
    expiresAt: now + 60_000,
  }));

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "d".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 200);
});

test("verifies an existing blob after conditional create returns 412", async () => {
  const remote = new MemoryRemote();
  const repository = new ContentAddressedRepository(remote);
  await repository.initialize();
  const data = new TextEncoder().encode("valuable").buffer;
  const hash = await sha256Hex(data);
  remote.seed(blobPath(hash), new TextEncoder().encode("corrupt").buffer);

  await assert.rejects(() => repository.writeBlob(data), /SHA-256 verification/);
});

test("verifies an existing commit after conditional create returns 412", async () => {
  const remote = new MemoryRemote();
  const repository = new ContentAddressedRepository(remote);
  const metadata = await repository.initialize();
  const commit = await createStoredCommit({
    formatVersion: 1,
    repositoryId: metadata.repositoryId,
    parents: [],
    deviceId: "test",
    createdAt: "2026-07-15T00:00:00.000Z",
    files: {},
  });
  remote.seed(commitPath(commit.commitId), "{}");

  await assert.rejects(() => repository.writeCommit(commit), /commit/i);
});

test("keeps correct existing immutable objects idempotent", async () => {
  const repository = new ContentAddressedRepository(new MemoryRemote());
  const metadata = await repository.initialize();
  const data = new TextEncoder().encode("same").buffer;
  const hash = await repository.writeBlob(data);
  assert.equal(await repository.writeBlob(data), hash);
  const commit = await createStoredCommit({
    formatVersion: 1,
    repositoryId: metadata.repositoryId,
    parents: [],
    deviceId: "test",
    createdAt: "2026-07-15T00:00:00.000Z",
    files: {},
  });
  await repository.writeCommit(commit);
  await repository.writeCommit(commit);
});
