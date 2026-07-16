import { WebDavClient } from "../src/webdav/client";
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "../src/webdav/types";
import { ContentAddressedRepository, sha256Hex, type RepositoryTree } from "../src/repository";
import { RepositorySyncEngine, type LocalWorkspace, type SyncSessionState } from "../src/sync";

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
    if (Boolean(existing) !== Boolean(expectedCurrent)) throw new Error(`Smoke workspace race: ${path}`);
    this.files.set(path, { data: data.slice(0), kind });
  }
  async remove(path: string): Promise<void> {
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
const testDirectory = `codex-webdav-sync-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const credentials = { username, password };
const transport = new FetchTransport();
const rootClient = new WebDavClient({ serverUrl, remoteRoot: "", credentials }, transport);
let cleanupStatus: number | null = null;

try {
  const client = new WebDavClient({ serverUrl, remoteRoot: testDirectory, credentials }, transport);
  const capabilities = await client.probeCapabilities();
  const headUpdateStrategy = capabilities.capabilities.headUpdateStrategy;
  if (!capabilities.ok || !capabilities.capabilities.safeConcurrentWrites || !headUpdateStrategy) {
    throw new Error(`Capability probe failed: ${JSON.stringify(capabilities)}`);
  }

  const workspaceA = new MemoryWorkspace({ "note.md": "title\nbody\nend" });
  const workspaceB = new MemoryWorkspace();
  const engineA = new RepositorySyncEngine(
    new ContentAddressedRepository(client, {
      headUpdateStrategy,
      conditionalCreate: capabilities.capabilities.conditionalCreate,
    }),
    workspaceA,
    { concurrency: 3 },
  );
  const engineB = new RepositorySyncEngine(
    new ContentAddressedRepository(client, {
      headUpdateStrategy,
      conditionalCreate: capabilities.capabilities.conditionalCreate,
    }),
    workspaceB,
    { concurrency: 3 },
  );
  let stateA = initialState("smoke-a");
  let stateB = initialState("smoke-b");
  const pushed = await engineA.sync(stateA);
  stateA = pushed.state;
  const pulled = await engineB.sync(stateB);
  stateB = pulled.state;
  workspaceA.setText("note.md", "title A\nbody\nend");
  workspaceB.setText("note.md", "title\nbody\nend B");
  const pushedAgain = await engineA.sync(stateA);
  stateA = pushedAgain.state;
  const merged = await engineB.sync(stateB);
  stateB = merged.state;
  const converged = await engineA.sync(stateA);

  if (pushed.status !== "pushed" || pulled.status !== "pulled") {
    throw new Error(`Unexpected initial results: ${pushed.status}/${pulled.status}`);
  }
  if (merged.status !== "merged" || converged.status !== "pulled") {
    throw new Error(`Unexpected merge results: ${merged.status}/${converged.status}`);
  }
  if (workspaceA.getText("note.md") !== workspaceB.getText("note.md")) {
    throw new Error("Smoke devices did not converge.");
  }

  console.log(JSON.stringify({
    ok: true,
    testDirectory,
    capabilities: capabilities.capabilities,
    results: [pushed.status, pulled.status, pushedAgain.status, merged.status, converged.status],
    finalContent: workspaceA.getText("note.md"),
    repositoryId: stateB.repositoryId,
    finalCommitId: stateB.baseCommitId,
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
