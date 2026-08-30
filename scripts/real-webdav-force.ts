import crypto from "node:crypto";
import { ContentAddressedRepository, createStoredCommit, sha256Hex, type RepositoryTree } from "../src/repository";
import { RepositorySyncEngine, type LocalWorkspace, type SyncSessionState } from "../src/sync";
import { WebDavClient } from "../src/webdav/client";
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "../src/webdav/types";

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
    if (!file) throw new Error(`Smoke workspace file missing: ${path}`);
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
    this.files.set(path, { data: data.slice(0), kind });
  }
  async remove(path: string, expectedCurrent: ArrayBuffer): Promise<void> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Smoke workspace file missing on delete: ${path}`);
    if (!equalBuffers(file.data, expectedCurrent)) {
      throw new Error(`Smoke workspace file changed on delete: ${path}`);
    }
    this.files.delete(path);
  }
  async removeEmptyFolder(_path: string): Promise<void> {}
  setText(path: string, content: string): void {
    this.files.set(path, { data: new TextEncoder().encode(content).buffer, kind: "text" });
  }
  getText(path: string): string {
    const file = this.files.get(path);
    if (!file) throw new Error(`Smoke workspace file missing: ${path}`);
    return new TextDecoder().decode(file.data);
  }
}

const serverUrl = requireEnvironment("WEBDAV_URL");
const username = requireEnvironment("WEBDAV_USERNAME");
const password = requireEnvironment("WEBDAV_PASSWORD");
const credentials = { username, password };
const transport = new FetchTransport();
const testDirectory = `codex-webdav-force-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const rootClient = new WebDavClient({ serverUrl, remoteRoot: "", credentials }, transport);
let cleanupStatus: number | null = null;

try {
  const client = new WebDavClient({ serverUrl, remoteRoot: testDirectory, credentials }, transport);
  const capabilities = await client.probeCapabilities();
  const headUpdateStrategy = capabilities.capabilities.headUpdateStrategy;
  if (!capabilities.ok || !capabilities.capabilities.safeConcurrentWrites || !headUpdateStrategy) {
    throw new Error(`Capability probe failed: ${JSON.stringify(capabilities)}`);
  }
  const createRepository = () => new ContentAddressedRepository(client, {
    headUpdateStrategy,
    conditionalCreate: capabilities.capabilities.conditionalCreate,
  });
  const workspaceA = new MemoryWorkspace({ "note.md": "base\nline", "a-only.md": "from a" });
  const workspaceB = new MemoryWorkspace();
  const engineA = new RepositorySyncEngine(createRepository(), workspaceA, { concurrency: 3 });
  const engineB = new RepositorySyncEngine(createRepository(), workspaceB, { concurrency: 3 });
  let stateA = initialState("force-a");
  let stateB = initialState("force-b");

  const pushed = await engineA.sync(stateA);
  stateA = pushed.state;
  const pulled = await engineB.sync(stateB);
  stateB = pulled.state;
  if (pushed.status !== "pushed" || pulled.status !== "pulled") {
    throw new Error(`Unexpected initial results: ${pushed.status}/${pulled.status}`);
  }

  // Give device B its own local edits that it wants to win over the cloud,
  // including deleting a file that only existed on A's side.
  workspaceB.setText("note.md", "b wins");
  workspaceB.setText("b-only.md", "from b");
  workspaceB.files.delete("a-only.md");

  // Rewrite the remote HEAD onto an unrelated lineage, which is exactly the
  // situation the historical "cannot force local over cloud" report describes.
  const repositoryB = createRepository();
  const baseCommit = await repositoryB.readCommit(stateB.baseCommitId as string);
  const divergent = await createStoredCommit({
    formatVersion: 1,
    repositoryId: baseCommit.repositoryId,
    parents: [],
    deviceId: "manual-rewrite",
    createdAt: new Date().toISOString(),
    files: {},
  });
  await repositoryB.writeCommit(divergent);
  const head = await repositoryB.readHead();
  const headSwap = await repositoryB.compareAndSwapHead(head.etag, {
    commit: divergent.commitId,
    generation: head.reference.generation + 1,
  });
  if (!headSwap.updated) throw new Error("Could not stage the divergent HEAD for the force test.");

  const diverged = await engineB.sync(stateB);
  if (diverged.status !== "conflict" || (diverged.status === "conflict" && diverged.reason !== "history-diverged")) {
    throw new Error(`Expected a history-diverged conflict, got: ${JSON.stringify(diverged.status)}`);
  }

  const forcedPush = await engineB.forceSync(stateB, "push-local");
  if (forcedPush.status !== "pushed") {
    throw new Error(`Force push failed: ${forcedPush.status}`);
  }
  stateB = forcedPush.state;
  const convergedB = await engineB.sync(stateB);
  if (convergedB.status !== "up-to-date") throw new Error(`Device B did not converge: ${convergedB.status}`);

  const forcedPull = await engineA.forceSync(stateA, "pull-remote");
  if (forcedPull.status !== "pulled") throw new Error(`Force pull failed: ${forcedPull.status}`);
  stateA = forcedPull.state;
  const convergedA = await engineA.sync(stateA);
  if (convergedA.status !== "up-to-date") throw new Error(`Device A did not converge: ${convergedA.status}`);

  if (workspaceA.getText("note.md") !== "b wins") throw new Error("Force pull did not adopt the remote note.");
  if (!workspaceA.files.has("b-only.md")) throw new Error("Force pull did not download the remote-only file.");
  if (workspaceA.files.has("a-only.md")) throw new Error("Force pull kept a file that the remote had replaced.");

  const history = await createRepository().listCommitHistory(10);
  // Reachable from HEAD: the forced push commit and the divergent commit it
  // landed on. The pre-divergence lineage is intentionally orphaned.
  if (history.length < 2) throw new Error(`Commit history looks too short: ${history.length}`);
  if (forcedPush.status === "pushed" && history[0]?.commitId !== forcedPush.commitId) {
    throw new Error("Commit history does not start at the newest commit.");
  }

  console.log(JSON.stringify({
    ok: true,
    testDirectory,
    headUpdateStrategy,
    results: [pushed.status, pulled.status, diverged.status, forcedPush.status, forcedPull.status],
    converged: convergedA.status === "up-to-date" && convergedB.status === "up-to-date",
    historyAfterForce: history.map(({ commitId, deviceId, fileCount, createdAt }) => ({
      commitId: commitId.slice(0, 12),
      deviceId,
      fileCount,
      createdAt,
    })),
  }, null, 2));
} finally {
  try {
    cleanupStatus = (await rootClient.remove(testDirectory)).status;
  } catch {
    cleanupStatus = null;
  }
  console.error(JSON.stringify({ cleanupDirectory: testDirectory, cleanupStatus }));
}

function initialState(deviceId: string): SyncSessionState {
  return { baseCommitId: null, repositoryId: null, deviceId };
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function equalBuffers(left: ArrayBuffer, right: ArrayBuffer): boolean {
  return left.byteLength === right.byteLength &&
    new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
}
