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
  protected readonly resources = new Map<string, { body: string | ArrayBuffer; etag: string }>();
  protected readonly collections = new Set<string>();
  protected version = 0;
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

class AmbiguousMoveRemote extends MemoryRemote {
  moveMode: "normal" | "installed-500" | "installed-throw" | "consumed-old-target" = "normal";
  staleOwnerReads = 0;
  moveCalls = 0;
  sharedLockDeletes = 0;
  private staleOwner: { body: string | ArrayBuffer; etag: string } | null = null;

  override async get(path: string): Promise<WebDavResponse> {
    if (path === HEAD_LOCK_PATH && this.staleOwnerReads > 0 && this.staleOwner) {
      this.staleOwnerReads -= 1;
      return response(200, { ETag: this.staleOwner.etag }, this.staleOwner.body);
    }
    return super.get(path);
  }

  override async move(sourcePath: string, destinationPath: string, overwrite = true): Promise<WebDavResponse> {
    this.moveCalls += 1;
    if (destinationPath !== HEAD_LOCK_PATH || this.moveMode === "normal") {
      return super.move(sourcePath, destinationPath, overwrite);
    }
    const source = this.resources.get(sourcePath);
    if (!source) return response(404);
    const previous = this.resources.get(destinationPath) ?? null;
    this.resources.delete(sourcePath);
    if (this.moveMode === "consumed-old-target") {
      return response(500);
    }
    if (previous) this.staleOwner = previous;
    this.resources.set(destinationPath, source);
    if (this.moveMode === "installed-throw") throw new Error("net::ERR_CONNECTION_RESET");
    return response(500);
  }

  override async remove(path: string): Promise<WebDavResponse> {
    if (path === HEAD_LOCK_PATH) this.sharedLockDeletes += 1;
    return super.remove(path);
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

test("reconciles a MOVE that installs the lease but returns HTTP 500", async () => {
  const remote = new AmbiguousMoveRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "ambiguous-owner",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.moveMode = "installed-500";
  remote.staleOwnerReads = 2;

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "6".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.equal((await repository.readHead()).reference.commit, "6".repeat(64));
  assert.equal(remote.moveCalls, 2);
  assert.equal(remote.sharedLockDeletes, 2);
});

test("reconciles a MOVE that installs the lease and then resets the connection", async () => {
  const remote = new AmbiguousMoveRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "reset-owner",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.moveMode = "installed-throw";

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "5".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.equal((await repository.readHead()).reference.commit, "5".repeat(64));
  assert.equal(remote.moveCalls, 2);
});

test("does not delete a foreign lock when failed MOVE consumed its candidate", async () => {
  const remote = new AmbiguousMoveRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "uncertain-owner",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  const foreign = canonicalJson({
    formatVersion: 1,
    ownerId: "foreign-owner",
    expiresAt: Date.now() - 1,
  });
  remote.seed(HEAD_LOCK_PATH, foreign);
  remote.moveMode = "consumed-old-target";

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "4".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.equal((await remote.get(HEAD_LOCK_PATH)).text, foreign);
  assert.equal(remote.sharedLockDeletes, 1);
});

test("fails closed instead of automatically deleting an expired MOVE HEAD lease", async () => {
  const remote = new MemoryRemote();
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    lockOwnerId: "current-owner",
    now: () => new Date(now),
  });
  await repository.initialize();
  const head = await repository.readHead();
  const expired = canonicalJson({
    formatVersion: 1,
    ownerId: "crashed-owner",
    expiresAt: now - 1,
  });
  remote.seed(HEAD_LOCK_PATH, expired);

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "9".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
  assert.equal((await remote.get(HEAD_LOCK_PATH)).text, expired);
});

test("treats an active MOVE HEAD lease as contention", async () => {
  const remote = new MemoryRemote();
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    lockOwnerId: "current-owner",
    now: () => new Date(now),
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.seed(HEAD_LOCK_PATH, canonicalJson({
    formatVersion: 1,
    ownerId: "active-owner",
    expiresAt: now + 60_000,
  }));

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "8".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
  assert.equal((await remote.get(HEAD_LOCK_PATH)).text, canonicalJson({
    formatVersion: 1,
    ownerId: "active-owner",
    expiresAt: now + 60_000,
  }));
});

test("fails closed instead of stealing a malformed MOVE HEAD lock", async () => {
  const remote = new MemoryRemote();
  const now = Date.parse("2026-07-15T12:00:00.000Z");
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    lockOwnerId: "current-owner",
    now: () => new Date(now),
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.seed(HEAD_LOCK_PATH, "not a lease");

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "7".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
  assert.equal((await remote.get(HEAD_LOCK_PATH)).text, "not a lease");
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
  const expired = canonicalJson({
    formatVersion: 1,
    ownerId: "crashed-owner",
    expiresAt: now - 1,
  });
  remote.seedCollection(HEAD_LOCK_PATH);
  remote.seed(HEAD_LOCK_OWNER_PATH, expired);

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "c".repeat(64), generation: 1 }),
    { updated: false, reason: "conflict" },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
  assert.equal((await remote.get(HEAD_LOCK_OWNER_PATH)).text, expired);
});

test("fails closed instead of stealing a malformed MKCOL HEAD lock", async () => {
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
  remote.seed(HEAD_LOCK_OWNER_PATH, "not a lease");

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

test("lists commit history from HEAD ordered by newest first", async () => {
  const repository = new ContentAddressedRepository(new MemoryRemote());
  const metadata = await repository.initialize();
  const createCommit = async (parents: string[], createdAt: string, files: Record<string, string>) => {
    const tree: Record<string, { blob: string; size: number; kind: "text" }> = {};
    for (const [path, content] of Object.entries(files)) {
      const data = new TextEncoder().encode(content).buffer;
      tree[path] = { blob: await sha256Hex(data), size: data.byteLength, kind: "text" };
    }
    const commit = await createStoredCommit({
      formatVersion: 1,
      repositoryId: metadata.repositoryId,
      parents,
      deviceId: "test",
      createdAt,
      files: tree,
    });
    await repository.writeCommit(commit);
    return commit;
  };

  const first = await createCommit([], "2026-07-15T00:00:00.000Z", { "a.md": "a" });
  const second = await createCommit([first.commitId], "2026-07-16T00:00:00.000Z", { "a.md": "a", "b.md": "b" });
  const merge = await createCommit([first.commitId, second.commitId], "2026-07-17T00:00:00.000Z", { "a.md": "merged" });
  const head = await repository.readHead();
  await repository.compareAndSwapHead(head.etag, { commit: merge.commitId, generation: head.reference.generation + 1 });

  const history = await repository.listCommitHistory();
  assert.deepEqual(history.map(({ commitId }) => commitId), [merge.commitId, second.commitId, first.commitId]);
  assert.equal(history[1]?.fileCount, 2);
  assert.deepEqual(history[1]?.parents, [first.commitId]);
  assert.deepEqual(await repository.listCommitHistory(1).then((entries) => entries.length), 1);

  const emptyRepository = new ContentAddressedRepository(new MemoryRemote());
  assert.deepEqual(await emptyRepository.listCommitHistory(), []);
});
