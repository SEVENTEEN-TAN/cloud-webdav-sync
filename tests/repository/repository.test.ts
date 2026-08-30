import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/repository/canonical-json";
import { createStoredCommit } from "../../src/repository/commit";
import { ContentAddressedRepository } from "../../src/repository/repository";
import { sha256Hex } from "../../src/repository/hash";
import {
  blobPath,
  commitPath,
  HEAD_LOCK_CANDIDATES_PATH,
  HEAD_LOCK_OWNER_PATH,
  HEAD_LOCK_PATH,
  HEAD_PATH,
  REPOSITORY_METADATA_PATH,
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

class MutationTrackingRemote extends MemoryRemote {
  mutations = 0;

  override async put(path: string, body: string | ArrayBuffer, headers: Record<string, string> = {}): Promise<WebDavResponse> {
    this.mutations += 1;
    return super.put(path, body, headers);
  }

  override async move(sourcePath: string, destinationPath: string, overwrite = true): Promise<WebDavResponse> {
    this.mutations += 1;
    return super.move(sourcePath, destinationPath, overwrite);
  }

  override async remove(path: string): Promise<WebDavResponse> {
    this.mutations += 1;
    return super.remove(path);
  }

  override async makeCollection(path: string): Promise<WebDavResponse> {
    this.mutations += 1;
    return super.makeCollection(path);
  }
}

class FaultInjectionRemote extends MemoryRemote {
  makeCollectionFault: "none" | "created-500" | "created-throw" = "none";
  ownerPutFault: "none" | "installed-500" | "installed-throw" | "rejected-403" = "none";
  headPutFault: "none" | "installed-500" | "installed-throw" | "unchanged-500" | "success-without-write" = "none";
  putCalls = new Map<string, number>();
  sharedLockDeletes = 0;
  staleCollectionReads = 0;
  staleOwnerReads = 0;
  staleHeadReads = 0;
  private previousHead: { body: string | ArrayBuffer; etag: string } | null = null;

  override async get(path: string): Promise<WebDavResponse> {
    if (path === HEAD_LOCK_OWNER_PATH && this.staleOwnerReads > 0) {
      this.staleOwnerReads -= 1;
      return response(404);
    }
    if (path === HEAD_PATH && this.staleHeadReads > 0 && this.previousHead) {
      this.staleHeadReads -= 1;
      return response(200, { ETag: this.previousHead.etag }, this.previousHead.body);
    }
    return super.get(path);
  }

  override async head(path: string): Promise<WebDavResponse> {
    if (path === HEAD_LOCK_PATH && this.staleCollectionReads > 0) {
      this.staleCollectionReads -= 1;
      return response(404);
    }
    return super.head(path);
  }

  override async makeCollection(path: string): Promise<WebDavResponse> {
    if (path !== HEAD_LOCK_PATH || this.makeCollectionFault === "none") return super.makeCollection(path);
    this.collections.add(path);
    if (this.makeCollectionFault === "created-throw") throw new Error("net::ERR_CONNECTION_RESET");
    return response(500);
  }

  override async put(
    path: string,
    body: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    this.putCalls.set(path, (this.putCalls.get(path) ?? 0) + 1);
    if (path === HEAD_LOCK_OWNER_PATH && this.ownerPutFault !== "none") {
      if (this.ownerPutFault === "rejected-403") return response(403);
      const installed = await super.put(path, body, headers);
      if (this.ownerPutFault === "installed-throw") throw new Error("net::ERR_CONNECTION_RESET");
      return response(500, installed.headers);
    }
    if (path === HEAD_PATH && this.headPutFault !== "none") {
      if (this.headPutFault === "unchanged-500") return response(500);
      if (this.headPutFault === "success-without-write") return response(204);
      this.previousHead = this.resources.get(path) ?? null;
      const installed = await super.put(path, body, headers);
      if (this.headPutFault === "installed-throw") throw new Error("net::ERR_CONNECTION_RESET");
      return response(500, installed.headers);
    }
    return super.put(path, body, headers);
  }

  override async remove(path: string): Promise<WebDavResponse> {
    if (path === HEAD_LOCK_PATH) this.sharedLockDeletes += 1;
    return super.remove(path);
  }
}

class AmbiguousMoveRemote extends MemoryRemote {
  moveMode: "normal" | "installed-500" | "installed-throw" | "consumed-old-target" | "rejected-403" = "normal";
  staleOwnerReads = 0;
  destinationNotFoundReads = 0;
  moveCalls = 0;
  sharedLockDeletes = 0;
  private staleOwner: { body: string | ArrayBuffer; etag: string } | null = null;

  override async get(path: string): Promise<WebDavResponse> {
    if (path === HEAD_LOCK_PATH && this.destinationNotFoundReads > 0) {
      this.destinationNotFoundReads -= 1;
      return response(404);
    }
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
    if (this.moveMode === "rejected-403") return response(403);
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

test("reports unresolved MOVE state without deleting a foreign lock when the candidate was consumed", async () => {
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

  await assert.rejects(
    () => repository.compareAndSwapHead(head.etag, { commit: "4".repeat(64), generation: 1 }),
    /MOVE lock acquisition is unresolved/,
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

  await assert.rejects(
    () => repository.compareAndSwapHead(head.etag, { commit: "7".repeat(64), generation: 1 }),
    /MOVE lock acquisition is unresolved/,
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

test("reconciles ambiguous MKCOL through an exact owner token without replaying it", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "mkcol-ambiguous",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  const ownerPutsBefore = remote.putCalls.get(HEAD_LOCK_OWNER_PATH) ?? 0;
  remote.makeCollectionFault = "created-throw";

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "1".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.equal((remote.putCalls.get(HEAD_LOCK_OWNER_PATH) ?? 0) - ownerPutsBefore, 1);
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 404);
});

test("waits beyond the former MOVE visibility window before accepting its exact lease", async () => {
  const remote = new AmbiguousMoveRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "move-delayed",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.moveMode = "installed-throw";
  remote.destinationNotFoundReads = 12;

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "e".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.deepEqual((await repository.readHead()).reference, { commit: "e".repeat(64), generation: 1 });
});

test("waits for an ambiguously created MKCOL lock to become visible", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "mkcol-delayed",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.makeCollectionFault = "created-500";
  remote.staleCollectionReads = 12;

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "f".repeat(64), generation: 1 }),
    { updated: true },
  );
});

test("accepts an ambiguous owner PUT only when the stored owner verifies", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "owner-ambiguous",
  });
  await repository.initialize();
  const head = await repository.readHead();
  const ownerPutsBefore = remote.putCalls.get(HEAD_LOCK_OWNER_PATH) ?? 0;
  remote.ownerPutFault = "installed-throw";

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "2".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.equal((remote.putCalls.get(HEAD_LOCK_OWNER_PATH) ?? 0) - ownerPutsBefore, 1);
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 404);
});

test("waits for an ambiguously written owner token to become visible", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "owner-delayed",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.ownerPutFault = "installed-500";
  remote.staleOwnerReads = 12;

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "4".repeat(64), generation: 1 }),
    { updated: true },
  );
});

test("removes its definitely created MKCOL lock after a definite owner PUT rejection", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "owner-rejected",
  });
  await repository.initialize();
  const head = await repository.readHead();
  const deletesBefore = remote.sharedLockDeletes;
  remote.ownerPutFault = "rejected-403";

  await assert.rejects(
    () => repository.compareAndSwapHead(head.etag, { commit: "3".repeat(64), generation: 1 }),
    /HTTP 403/,
  );
  assert.equal(remote.sharedLockDeletes, deletesBefore + 1);
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 404);
});

test("propagates a definite MOVE rejection instead of reporting contention", async () => {
  const remote = new AmbiguousMoveRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "move-lock",
    conditionalCreate: false,
    lockOwnerId: "move-rejected",
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.moveMode = "rejected-403";

  await assert.rejects(
    () => repository.compareAndSwapHead(head.etag, { commit: "a".repeat(64), generation: 1 }),
    /HTTP 403/,
  );
  assert.equal(remote.moveCalls, 2);
  assert.equal((await remote.get(`${HEAD_LOCK_CANDIDATES_PATH}/move-rejected.json`)).status, 404);
});

test("reconciles an ambiguous locked HEAD PUT with one write and releases a verified lease", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "head-installed",
  });
  await repository.initialize();
  const head = await repository.readHead();
  const headPutsBefore = remote.putCalls.get(HEAD_PATH) ?? 0;
  remote.headPutFault = "installed-throw";

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "b".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.equal((remote.putCalls.get(HEAD_PATH) ?? 0) - headPutsBefore, 1);
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 404);
});

test("waits for an ambiguously updated HEAD to become visible without replaying PUT", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "head-delayed",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  const headPutsBefore = remote.putCalls.get(HEAD_PATH) ?? 0;
  remote.headPutFault = "installed-500";
  remote.staleHeadReads = 12;

  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, { commit: "5".repeat(64), generation: 1 }),
    { updated: true },
  );
  assert.equal((remote.putCalls.get(HEAD_PATH) ?? 0) - headPutsBefore, 1);
});

test("retains the lease when a locked HEAD PUT remains unresolved", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "head-unresolved",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  const headPutsBefore = remote.putCalls.get(HEAD_PATH) ?? 0;
  remote.headPutFault = "unchanged-500";

  await assert.rejects(
    () => repository.compareAndSwapHead(head.etag, { commit: "c".repeat(64), generation: 1 }),
    /HEAD update is unresolved/,
  );
  assert.equal((remote.putCalls.get(HEAD_PATH) ?? 0) - headPutsBefore, 1);
  assert.equal((await remote.head(HEAD_LOCK_PATH)).status, 200);
});

test("retains the lease when a successful locked HEAD PUT contradicts the stored HEAD", async () => {
  const remote = new FaultInjectionRemote();
  const repository = new ContentAddressedRepository(remote, {
    headUpdateStrategy: "mkcol-lock",
    lockOwnerId: "head-contradiction",
    sleep: async () => undefined,
  });
  await repository.initialize();
  const head = await repository.readHead();
  remote.headPutFault = "success-without-write";

  await assert.rejects(
    () => repository.compareAndSwapHead(head.etag, { commit: "d".repeat(64), generation: 1 }),
    /contradicted a successful update/,
  );
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

test("history is strictly read-only when metadata and HEAD are both absent", async () => {
  const remote = new MutationTrackingRemote();
  const repository = new ContentAddressedRepository(remote);

  assert.deepEqual(await repository.listCommitHistory(), []);
  assert.equal(remote.mutations, 0);
  assert.equal((await remote.get(REPOSITORY_METADATA_PATH)).status, 404);
  assert.equal((await remote.get(HEAD_PATH)).status, 404);
});

test("history rejects an incomplete repository without repairing it", async () => {
  const remote = new MutationTrackingRemote();
  remote.seed(REPOSITORY_METADATA_PATH, canonicalJson({
    formatVersion: 1,
    repositoryId: "history-repository",
    hashAlgorithm: "sha256",
    createdAt: "2026-07-15T00:00:00.000Z",
  }));
  const repository = new ContentAddressedRepository(remote);

  await assert.rejects(() => repository.listCommitHistory(), /history is incomplete/);
  assert.equal(remote.mutations, 0);
  assert.equal((await remote.get(HEAD_PATH)).status, 404);
});

test("history validates metadata and does not require a HEAD ETag", async () => {
  const remote = new MutationTrackingRemote();
  remote.seed(REPOSITORY_METADATA_PATH, canonicalJson({
    formatVersion: 1,
    repositoryId: "history-repository",
    hashAlgorithm: "sha256",
    createdAt: "2026-07-15T00:00:00.000Z",
  }));
  remote.seed(HEAD_PATH, canonicalJson({ commit: null, generation: 0 }));
  const originalGet = remote.get.bind(remote);
  remote.get = async (path: string) => {
    const result = await originalGet(path);
    return path === HEAD_PATH ? { ...result, headers: {} } : result;
  };

  assert.deepEqual(await new ContentAddressedRepository(remote).listCommitHistory(), []);
  assert.equal(remote.mutations, 0);

  remote.seed(REPOSITORY_METADATA_PATH, canonicalJson({
    formatVersion: 1,
    repositoryId: "history-repository",
    hashAlgorithm: "sha256",
    createdAt: "not-a-date",
  }));
  await assert.rejects(
    () => new ContentAddressedRepository(remote).listCommitHistory(),
    /malformed repository metadata/,
  );
  assert.equal(remote.mutations, 0);
});
