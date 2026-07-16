import assert from "node:assert/strict";
import test from "node:test";
import {
  sha256Hex,
  ContentAddressedRepository,
  createStoredCommit,
  type RepositoryRemote,
  type RepositoryTree,
} from "../../src/repository";
import {
  RepositorySyncEngine,
  type ConflictResolution,
  type LocalWorkspace,
  type SyncSessionState,
} from "../../src/sync/repository-sync-engine";
import type { WebDavResponse } from "../../src/webdav";

class MemoryRemote implements RepositoryRemote {
  readonly resources = new Map<string, { body: string | ArrayBuffer; etag: string }>();
  readonly collections = new Set<string>();
  version = 0;
  rejectNextHeadCas = false;

  async get(path: string): Promise<WebDavResponse> {
    const value = this.resources.get(path);
    return value ? response(200, { ETag: value.etag }, value.body) : response(404);
  }
  async getEtag(path: string): Promise<string | null> {
    return this.resources.get(path)?.etag ?? null;
  }
  async head(path: string): Promise<WebDavResponse> {
    const value = this.resources.get(path);
    if (value) return response(200, { ETag: value.etag });
    return this.collections.has(path) ? response(200) : response(404);
  }
  async put(path: string, body: string | ArrayBuffer, headers: Record<string, string> = {}): Promise<WebDavResponse> {
    const current = this.resources.get(path);
    if (path === "refs/head.json" && headers["If-Match"] && this.rejectNextHeadCas) {
      this.rejectNextHeadCas = false;
      return response(412);
    }
    if (headers["If-None-Match"] === "*" && current) return response(412);
    if (headers["If-Match"] && headers["If-Match"] !== current?.etag) return response(412);
    const etag = `"${++this.version}"`;
    this.resources.set(path, { body: copy(body), etag });
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
    this.resources.delete(path);
    this.collections.delete(path);
    return response(204);
  }
  async makeCollection(path: string): Promise<WebDavResponse> {
    if (this.collections.has(path)) return response(405);
    this.collections.add(path);
    return response(201);
  }
}

class MemoryWorkspace implements LocalWorkspace {
  readonly files = new Map<string, { data: ArrayBuffer; kind: "text" | "binary" }>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.setText(path, content);
  }
  async scan(): Promise<RepositoryTree> {
    const tree: RepositoryTree = {};
    for (const [path, file] of this.files) {
      tree[path] = { blob: await sha256Hex(file.data), size: file.data.byteLength, kind: file.kind };
    }
    return tree;
  }
  async read(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local file ${path}`);
    return file.data.slice(0);
  }
  async write(
    path: string,
    data: ArrayBuffer,
    kind: "text" | "binary",
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void> {
    const existing = this.files.get(path);
    if (!existing && expectedCurrent !== null) throw new Error(`Expected existing file ${path}`);
    if (existing && expectedCurrent === null) throw new Error(`Expected absent file ${path}`);
    if (existing && expectedCurrent && !equalBuffers(existing.data, expectedCurrent)) {
      throw new Error(`Local file ${path} changed while synchronization was running.`);
    }
    this.files.set(path, { data: data.slice(0), kind });
  }
  async remove(path: string, expectedCurrent: ArrayBuffer): Promise<void> {
    const existing = this.files.get(path);
    if (!existing || !equalBuffers(existing.data, expectedCurrent)) {
      throw new Error(`Local file ${path} changed while synchronization was applying a delete.`);
    }
    this.files.delete(path);
  }
  async removeEmptyFolder(_path: string): Promise<void> {}
  setText(path: string, content: string): void {
    this.files.set(path, { data: new TextEncoder().encode(content).buffer, kind: "text" });
  }
  getText(path: string): string {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local file ${path}`);
    return new TextDecoder().decode(file.data);
  }
  setBinary(path: string, bytes: number[]): void {
    this.files.set(path, { data: Uint8Array.from(bytes).buffer, kind: "binary" });
  }
  getBinary(path: string): number[] {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local file ${path}`);
    return [...new Uint8Array(file.data)];
  }
}

class MutatingWorkspace extends MemoryWorkspace {
  mutateBeforeWrite = false;

  override async write(
    path: string,
    data: ArrayBuffer,
    kind: "text" | "binary",
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void> {
    if (this.mutateBeforeWrite) {
      this.mutateBeforeWrite = false;
      this.setText(path, "late local edit");
    }
    await super.write(path, data, kind, expectedCurrent);
  }
}

class InterruptingWorkspace extends MemoryWorkspace {
  interruptAfterWrites = 1;
  writesCompleted = 0;
  interruptEnabled = true;

  override async write(
    path: string,
    data: ArrayBuffer,
    kind: "text" | "binary",
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void> {
    if (this.interruptEnabled && this.writesCompleted >= this.interruptAfterWrites) {
      throw new Error("simulated local apply interruption");
    }
    await super.write(path, data, kind, expectedCurrent);
    this.writesCompleted += 1;
  }
}

class DirectoryAwareWorkspace extends MemoryWorkspace {
  readonly folders = new Set<string>();

  override async write(
    path: string,
    data: ArrayBuffer,
    kind: "text" | "binary",
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    let parent = "";
    for (const segment of segments) {
      parent = parent ? `${parent}/${segment}` : segment;
      if (this.files.has(parent)) throw new Error(`file blocks folder ${parent}`);
      this.folders.add(parent);
    }
    if (this.folders.has(path)) throw new Error(`folder blocks file ${path}`);
    await super.write(path, data, kind, expectedCurrent);
  }

  override async removeEmptyFolder(path: string): Promise<void> {
    if ([...this.files.keys()].some((file) => file.startsWith(`${path}/`))) {
      throw new Error(`folder ${path} still contains files`);
    }
    if ([...this.folders].some((folder) => folder !== path && folder.startsWith(`${path}/`))) {
      throw new Error(`folder ${path} still contains folders`);
    }
    this.folders.delete(path);
  }
}

const initialState = (deviceId: string): SyncSessionState => ({
  baseCommitId: null,
  deviceId,
  repositoryId: null,
});
const fixedNow = () => new Date("2026-07-15T00:00:00.000Z");

test("pushes the first vault and pulls it into an empty second device", async () => {
  const remote = new MemoryRemote();
  const firstWorkspace = new MemoryWorkspace({ "note.md": "hello" });
  const secondWorkspace = new MemoryWorkspace();
  const first = new RepositorySyncEngine(new ContentAddressedRepository(remote), firstWorkspace, { now: fixedNow });
  const second = new RepositorySyncEngine(new ContentAddressedRepository(remote), secondWorkspace, { now: fixedNow });

  const pushed = await first.sync(initialState("first"));
  const pulled = await second.sync(initialState("second"));

  assert.equal(pushed.status, "pushed");
  assert.equal(pulled.status, "pulled");
  assert.equal(secondWorkspace.getText("note.md"), "hello");
  assert.equal(pulled.state.baseCommitId, pushed.state.baseCommitId);
});

test("packs small uploaded files and keeps pack locations in later commits", async () => {
  const remote = new MemoryRemote();
  const firstWorkspace = new MemoryWorkspace({ "a.md": "alpha", "b.md": "bravo" });
  const secondWorkspace = new MemoryWorkspace();
  const firstRepository = new ContentAddressedRepository(remote);
  const first = new RepositorySyncEngine(firstRepository, firstWorkspace, { now: fixedNow });
  const second = new RepositorySyncEngine(new ContentAddressedRepository(remote), secondWorkspace, { now: fixedNow });

  const pushed = await first.sync(initialState("first"));
  assert.equal(pushed.status, "pushed");
  const firstCommit = await firstRepository.readCommit(pushed.state.baseCommitId as string);
  assert.ok(firstCommit.files["a.md"]?.pack);
  assert.equal(firstCommit.files["a.md"]?.pack?.path, firstCommit.files["b.md"]?.pack?.path);
  assert.equal([...remote.resources.keys()].filter((path) => path.endsWith(".pack")).length, 1);

  const pulled = await second.sync(initialState("second"));
  assert.equal(pulled.status, "pulled");
  assert.equal(secondWorkspace.getText("a.md"), "alpha");
  assert.equal(secondWorkspace.getText("b.md"), "bravo");

  firstWorkspace.setText("c.md", "charlie");
  const pushedAgain = await first.sync(pushed.state);
  assert.equal(pushedAgain.status, "pushed");
  const nextCommit = await firstRepository.readCommit(pushedAgain.state.baseCommitId as string);
  assert.equal(nextCommit.files["a.md"]?.pack?.path, firstCommit.files["a.md"]?.pack?.path);
  assert.ok(nextCommit.files["c.md"]?.pack);
});

test("keeps the safe default when local and remote are both non-empty on first connection", async () => {
  const remote = new MemoryRemote();
  const first = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    new MemoryWorkspace({ "remote.md": "remote" }),
    { now: fixedNow },
  );
  await first.sync(initialState("first"));
  const second = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    new MemoryWorkspace({ "local.md": "local" }),
    { now: fixedNow },
  );

  const result = await second.sync(initialState("second"));

  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "initial-both-nonempty");
});

test("can explicitly use the remote tree for a non-empty first connection", async () => {
  const remote = new MemoryRemote();
  const first = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    new MemoryWorkspace({ "remote.md": "remote" }),
    { now: fixedNow },
  );
  await first.sync(initialState("first"));
  const local = new MemoryWorkspace({ "local.md": "local" });
  const second = new RepositorySyncEngine(new ContentAddressedRepository(remote), local, {
    now: fixedNow,
    initialSyncPolicy: "prefer-remote",
  });

  const result = await second.sync(initialState("second"));

  assert.equal(result.status, "pulled");
  assert.equal(local.files.has("local.md"), false);
  assert.equal(local.getText("remote.md"), "remote");
});

test("can explicitly commit the local tree on top of an existing remote first connection", async () => {
  const remote = new MemoryRemote();
  const repository = new ContentAddressedRepository(remote);
  const first = new RepositorySyncEngine(
    repository,
    new MemoryWorkspace({ "remote.md": "remote" }),
    { now: fixedNow },
  );
  const remoteState = (await first.sync(initialState("first"))).state;
  const oldHead = await repository.readHead();
  const local = new MemoryWorkspace({ "local.md": "local" });
  const second = new RepositorySyncEngine(new ContentAddressedRepository(remote), local, {
    now: fixedNow,
    initialSyncPolicy: "prefer-local",
  });

  const result = await second.sync(initialState("second"));
  const newHead = await repository.readHead();
  const commit = await repository.readCommit(newHead.reference.commit as string);

  assert.equal(result.status, "pushed");
  assert.deepEqual(commit.parents, [oldHead.reference.commit]);
  assert.deepEqual(Object.keys(commit.files), ["local.md"]);
  assert.ok(remoteState.baseCommitId);
});

test("merges non-overlapping Markdown edits and converges both devices", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace({ "note.md": "title\nbody\nend" });
  const b = new MemoryWorkspace();
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("a"))).state;
  let stateB = (await engineB.sync(initialState("b"))).state;

  a.setText("note.md", "title A\nbody\nend");
  b.setText("note.md", "title\nbody\nend B");
  const pushedA = await engineA.sync(stateA);
  stateA = pushedA.state;
  const mergedB = await engineB.sync(stateB);
  stateB = mergedB.state;
  const pulledA = await engineA.sync(stateA);

  assert.equal(mergedB.status, "merged");
  assert.equal(pulledA.status, "pulled");
  assert.equal(a.getText("note.md"), "title A\nbody\nend B");
  assert.equal(b.getText("note.md"), a.getText("note.md"));
  assert.equal(pulledA.state.baseCommitId, stateB.baseCommitId);
});

test("returns a structured conflict for overlapping Markdown edits without advancing HEAD", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace({ "note.md": "same" });
  const b = new MemoryWorkspace();
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("a"))).state;
  const stateB = (await engineB.sync(initialState("b"))).state;
  a.setText("note.md", "from a");
  b.setText("note.md", "from b");
  stateA = (await engineA.sync(stateA)).state;
  const headBefore = await new ContentAddressedRepository(remote).readHead();

  const conflict = await engineB.sync(stateB);
  const headAfter = await new ContentAddressedRepository(remote).readHead();

  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.status === "conflict" && conflict.reason, "tree-conflict");
  assert.deepEqual(conflict.status === "conflict" && conflict.markdownConflictVersions?.["note.md"], {
    base: "same",
    local: "from b",
    remote: "from a",
  });
  assert.deepEqual(headAfter.reference, headBefore.reference);
  assert.equal(b.getText("note.md"), "from b");
});

test("resolves an overlapping Markdown conflict with a blob-bound local choice", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace({ "note.md": "same" });
  const b = new MemoryWorkspace();
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("a"))).state;
  const stateB = (await engineB.sync(initialState("b"))).state;
  a.setText("note.md", "from a");
  b.setText("note.md", "from b");
  stateA = (await engineA.sync(stateA)).state;
  const conflict = await engineB.sync(stateB);
  assert.equal(conflict.status, "conflict");
  const item = conflict.status === "conflict" ? conflict.plan?.find(({ path }) => path === "note.md") : undefined;
  assert.ok(item);
  const resolution: ConflictResolution = {
    choice: "local",
    baseBlob: item.base?.blob ?? null,
    localBlob: item.local?.blob ?? null,
    remoteBlob: item.remote?.blob ?? null,
  };

  const resolved = await engineB.sync(stateB, { "note.md": resolution });
  const pulled = await engineA.sync(stateA);

  assert.equal(resolved.status, "merged");
  assert.equal(pulled.status, "pulled");
  assert.equal(a.getText("note.md"), "from b");
  assert.equal(b.getText("note.md"), "from b");
});

test("ignores a conflict choice when any bound blob identity is stale", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace({ "note.md": "same" });
  const b = new MemoryWorkspace();
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("a"))).state;
  const stateB = (await engineB.sync(initialState("b"))).state;
  a.setText("note.md", "from a");
  b.setText("note.md", "from b");
  stateA = (await engineA.sync(stateA)).state;

  const result = await engineB.sync(stateB, {
    "note.md": {
      choice: "local",
      baseBlob: "stale",
      localBlob: "stale",
      remoteBlob: "stale",
    },
  });

  assert.equal(result.status, "conflict");
  assert.equal(b.getText("note.md"), "from b");
  assert.ok(stateA.baseCommitId);
});

test("returns retry when another writer wins the HEAD compare-and-swap", async () => {
  const remote = new MemoryRemote();
  remote.rejectNextHeadCas = true;
  const workspace = new MemoryWorkspace({ "note.md": "hello" });
  const engine = new RepositorySyncEngine(new ContentAddressedRepository(remote), workspace, { now: fixedNow });

  const result = await engine.sync(initialState("device"));

  assert.equal(result.status, "retry");
  assert.equal(result.state.baseCommitId, null);
});

test("blocks a large local deletion before advancing remote HEAD", async () => {
  const remote = new MemoryRemote();
  const initial = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [`note-${index}.md`, `content ${index}`]),
  );
  const workspace = new MemoryWorkspace(initial);
  const repository = new ContentAddressedRepository(remote);
  const engine = new RepositorySyncEngine(repository, workspace, { now: fixedNow });
  const first = await engine.sync(initialState("device"));
  const headBefore = await repository.readHead();
  workspace.files.clear();

  const result = await engine.sync(first.state);
  const headAfter = await repository.readHead();

  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "mass-delete");
  assert.deepEqual(headAfter.reference, headBefore.reference);
});

test("preserves both versions of a concurrent binary conflict", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace();
  const b = new MemoryWorkspace();
  a.setBinary("image.png", [1]);
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("device-a"))).state;
  let stateB = (await engineB.sync(initialState("device-b"))).state;
  a.setBinary("image.png", [2]);
  b.setBinary("image.png", [3]);
  stateA = (await engineA.sync(stateA)).state;

  const merged = await engineB.sync(stateB);
  stateB = merged.state;
  const pulled = await engineA.sync(stateA);

  assert.equal(merged.status, "merged");
  assert.equal(pulled.status, "pulled");
  assert.deepEqual(b.getBinary("image.png"), [3]);
  const conflictPath = [...b.files.keys()].find((path) => path.startsWith("image.conflict-device-a-"));
  assert.ok(conflictPath);
  assert.deepEqual(b.getBinary(conflictPath), [2]);
  assert.deepEqual([...a.files.keys()].sort(), [...b.files.keys()].sort());
  assert.equal(pulled.state.baseCommitId, stateB.baseCommitId);
});

test("does not overwrite an existing default binary conflict path", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace();
  const b = new MemoryWorkspace();
  a.setBinary("a.bin", [1]);
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("device-a"))).state;
  const stateB = (await engineB.sync(initialState("device-b"))).state;
  a.setBinary("a.bin", [2]);
  b.setBinary("a.bin", [3]);
  stateA = (await engineA.sync(stateA)).state;
  assert.ok(stateA.baseCommitId);
  const commitPrefix = stateA.baseCommitId.slice(0, 8);
  const defaultConflictPath = `a.conflict-device-a-${commitPrefix}.bin`;
  const suffixedConflictPath = `a.conflict-device-a-${commitPrefix}-2.bin`;
  b.setBinary(defaultConflictPath, [9]);

  const merged = await engineB.sync(stateB);

  assert.equal(merged.status, "merged");
  assert.deepEqual(b.getBinary("a.bin"), [3]);
  assert.deepEqual(b.getBinary(defaultConflictPath), [9]);
  assert.deepEqual(b.getBinary(suffixedConflictPath), [2]);
});

test("refuses to reuse sync state with a different repository identity", async () => {
  const remote = new MemoryRemote();
  const workspace = new MemoryWorkspace({ "note.md": "hello" });
  const engine = new RepositorySyncEngine(new ContentAddressedRepository(remote), workspace, { now: fixedNow });
  const first = await engine.sync(initialState("device"));

  const result = await engine.sync({ ...first.state, repositoryId: "different-repository" });

  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "repository-mismatch");
});

test("does not overwrite a local edit that arrives while remote data is being applied", async () => {
  const remote = new MemoryRemote();
  const a = new MemoryWorkspace({ "note.md": "base" });
  const b = new MutatingWorkspace();
  const engineA = new RepositorySyncEngine(new ContentAddressedRepository(remote), a, { now: fixedNow });
  const engineB = new RepositorySyncEngine(new ContentAddressedRepository(remote), b, { now: fixedNow });
  let stateA = (await engineA.sync(initialState("a"))).state;
  const stateB = (await engineB.sync(initialState("b"))).state;
  a.setText("note.md", "remote update");
  stateA = (await engineA.sync(stateA)).state;
  b.mutateBeforeWrite = true;

  await assert.rejects(
    () => engineB.sync(stateB),
    /changed while synchronization was running/,
  );

  assert.equal(b.getText("note.md"), "late local edit");
  assert.ok(stateA.baseCommitId);
});

test("refuses to merge when the remote HEAD no longer descends from the local base", async () => {
  const remote = new MemoryRemote();
  const workspace = new MemoryWorkspace({ "note.md": "base" });
  const repository = new ContentAddressedRepository(remote);
  const engine = new RepositorySyncEngine(repository, workspace, { now: fixedNow });
  const first = await engine.sync(initialState("device"));
  const base = await repository.readCommit(first.state.baseCommitId as string);
  const divergent = await createStoredCommit({
    formatVersion: 1,
    repositoryId: base.repositoryId,
    parents: [],
    deviceId: "manual-rewrite",
    createdAt: "2026-07-15T01:00:00.000Z",
    files: {},
  });
  await repository.writeCommit(divergent);
  const head = await repository.readHead();
  assert.deepEqual(
    await repository.compareAndSwapHead(head.etag, {
      commit: divergent.commitId,
      generation: head.reference.generation + 1,
    }),
    { updated: true },
  );

  const result = await engine.sync(first.state);

  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "history-diverged");
  assert.equal(workspace.getText("note.md"), "base");
});

test("persists and resumes a partially applied remote commit after restart", async () => {
  const remote = new MemoryRemote();
  const sourceWorkspace = new MemoryWorkspace({ "a.md": "A", "b.md": "B" });
  const targetWorkspace = new InterruptingWorkspace();
  const source = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    sourceWorkspace,
    { now: fixedNow },
  );
  const pushed = await source.sync(initialState("source"));
  let persistedState: SyncSessionState | null = null;
  const interrupted = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    targetWorkspace,
    {
      now: fixedNow,
      concurrency: 1,
      persistSessionState: async (state) => {
        persistedState = structuredClone(state);
      },
    },
  );

  await assert.rejects(
    () => interrupted.sync(initialState("target")),
    /simulated local apply interruption/,
  );
  const journalState = persistedState as SyncSessionState | null;
  assert.ok(journalState?.pendingApply);
  assert.equal(journalState.pendingApply.targetCommitId, pushed.state.baseCommitId);
  assert.equal(targetWorkspace.files.size, 1);

  targetWorkspace.interruptEnabled = false;
  const restarted = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    targetWorkspace,
    { now: fixedNow, concurrency: 1 },
  );
  const recovered = await restarted.sync(journalState);

  assert.equal(recovered.status, "pulled");
  assert.equal(recovered.state.baseCommitId, pushed.state.baseCommitId);
  assert.equal(recovered.state.pendingApply, undefined);
  assert.equal(targetWorkspace.getText("a.md"), "A");
  assert.equal(targetWorkspace.getText("b.md"), "B");
});

test("does not overwrite a user edit made during pending apply recovery", async () => {
  const remote = new MemoryRemote();
  const sourceWorkspace = new MemoryWorkspace({ "a.md": "A", "b.md": "B" });
  const targetWorkspace = new InterruptingWorkspace();
  const source = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    sourceWorkspace,
    { now: fixedNow },
  );
  await source.sync(initialState("source"));
  let persistedState: SyncSessionState | null = null;
  const interrupted = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    targetWorkspace,
    {
      now: fixedNow,
      concurrency: 1,
      persistSessionState: async (state) => {
        persistedState = structuredClone(state);
      },
    },
  );
  await assert.rejects(() => interrupted.sync(initialState("target")));
  const journalState = persistedState as SyncSessionState | null;
  assert.ok(journalState?.pendingApply);
  const appliedPath = [...targetWorkspace.files.keys()][0] as string;
  targetWorkspace.setText(appliedPath, "user edit after interruption");
  targetWorkspace.interruptEnabled = false;

  const restarted = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    targetWorkspace,
    { now: fixedNow, concurrency: 1 },
  );
  const result = await restarted.sync(journalState);

  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "pending-apply-local-change");
  assert.equal(targetWorkspace.getText(appliedPath), "user edit after interruption");
});

test("resumes an interrupted merged commit from its exact local recovery commit", async () => {
  const remote = new MemoryRemote();
  const workspaceA = new MemoryWorkspace({ "a.md": "base A", "b.md": "base B", "c.md": "base C" });
  const workspaceB = new InterruptingWorkspace();
  workspaceB.interruptEnabled = false;
  const engineA = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    workspaceA,
    { now: fixedNow, concurrency: 1 },
  );
  let persistedState: SyncSessionState | null = null;
  const engineB = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    workspaceB,
    {
      now: fixedNow,
      concurrency: 1,
      persistSessionState: async (state) => {
        persistedState = structuredClone(state);
      },
    },
  );
  let stateA = (await engineA.sync(initialState("device-a"))).state;
  const stateB = (await engineB.sync(initialState("device-b"))).state;
  workspaceA.setText("a.md", "remote A");
  workspaceA.setText("c.md", "remote C");
  stateA = (await engineA.sync(stateA)).state;
  workspaceB.setText("b.md", "local B");
  workspaceB.writesCompleted = 0;
  workspaceB.interruptEnabled = true;
  persistedState = null;

  await assert.rejects(() => engineB.sync(stateB), /simulated local apply interruption/);
  const journalState = persistedState as SyncSessionState | null;
  assert.ok(journalState?.pendingApply?.sourceBaseCommitId);
  const targetCommitId = journalState.pendingApply.targetCommitId;
  workspaceB.interruptEnabled = false;

  const restarted = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    workspaceB,
    { now: fixedNow, concurrency: 1 },
  );
  const recovered = await restarted.sync(journalState);

  assert.equal(recovered.status, "pulled");
  assert.equal(recovered.state.baseCommitId, targetCommitId);
  assert.equal(workspaceB.getText("a.md"), "remote A");
  assert.equal(workspaceB.getText("b.md"), "local B");
  assert.equal(workspaceB.getText("c.md"), "remote C");
});

test("applies a remote file-to-folder transition by deleting the blocking file first", async () => {
  const remote = new MemoryRemote();
  const sourceWorkspace = new MemoryWorkspace({ a: "base file" });
  const targetWorkspace = new DirectoryAwareWorkspace();
  const source = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    sourceWorkspace,
    { now: fixedNow, concurrency: 1 },
  );
  const target = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    targetWorkspace,
    { now: fixedNow, concurrency: 1 },
  );
  let sourceState = (await source.sync(initialState("source"))).state;
  let targetState = (await target.sync(initialState("target"))).state;
  sourceWorkspace.files.delete("a");
  sourceWorkspace.setText("a/note.md", "nested note");
  sourceState = (await source.sync(sourceState)).state;

  const pulled = await target.sync(targetState);
  targetState = pulled.state;

  assert.equal(pulled.status, "pulled");
  assert.equal(targetWorkspace.files.has("a"), false);
  assert.equal(targetWorkspace.getText("a/note.md"), "nested note");
  assert.equal(targetWorkspace.folders.has("a"), true);
  assert.equal(targetState.baseCommitId, sourceState.baseCommitId);
});

test("applies a remote folder-to-file transition after removing empty descendant folders", async () => {
  const remote = new MemoryRemote();
  const sourceWorkspace = new MemoryWorkspace({ "a/child/note.md": "nested note" });
  const targetWorkspace = new DirectoryAwareWorkspace();
  const source = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    sourceWorkspace,
    { now: fixedNow, concurrency: 1 },
  );
  const target = new RepositorySyncEngine(
    new ContentAddressedRepository(remote),
    targetWorkspace,
    { now: fixedNow, concurrency: 1 },
  );
  let sourceState = (await source.sync(initialState("source"))).state;
  let targetState = (await target.sync(initialState("target"))).state;
  sourceWorkspace.files.delete("a/child/note.md");
  sourceWorkspace.setText("a", "replacement file");
  sourceState = (await source.sync(sourceState)).state;

  const pulled = await target.sync(targetState);
  targetState = pulled.state;

  assert.equal(pulled.status, "pulled");
  assert.equal(targetWorkspace.getText("a"), "replacement file");
  assert.equal(targetWorkspace.files.has("a/child/note.md"), false);
  assert.equal(targetWorkspace.folders.has("a"), false);
  assert.equal(targetWorkspace.folders.has("a/child"), false);
  assert.equal(targetState.baseCommitId, sourceState.baseCommitId);
});

test("aborts at a safe point before advancing remote HEAD when the run context changes", async () => {
  const remote = new MemoryRemote();
  const repository = new ContentAddressedRepository(remote);
  const workspace = new MemoryWorkspace({ "note.md": "local" });
  let safePointCalls = 0;
  const engine = new RepositorySyncEngine(repository, workspace, {
    now: fixedNow,
    assertSafePoint: () => {
      safePointCalls += 1;
      if (safePointCalls === 3) throw new Error("run context changed");
    },
  });

  await assert.rejects(() => engine.sync(initialState("device")), /run context changed/);

  assert.deepEqual((await repository.readHead()).reference, { commit: null, generation: 0 });
});

function response(
  status: number,
  headers: Record<string, string> = {},
  body: string | ArrayBuffer = "",
): WebDavResponse {
  const arrayBuffer = typeof body === "string" ? new TextEncoder().encode(body).buffer : body.slice(0);
  return { status, headers, text: typeof body === "string" ? body : new TextDecoder().decode(body), arrayBuffer };
}

function copy(body: string | ArrayBuffer): string | ArrayBuffer {
  return typeof body === "string" ? body : body.slice(0);
}

function equalBuffers(left: ArrayBuffer, right: ArrayBuffer): boolean {
  return left.byteLength === right.byteLength &&
    new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
}
