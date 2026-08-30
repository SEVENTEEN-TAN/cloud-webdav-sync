import crypto from "node:crypto";
import { canonicalJson } from "../src/repository/canonical-json";
import { ContentAddressedRepository, createStoredCommit, HEAD_LOCK_PATH, HEAD_LOCK_OWNER_PATH } from "../src/repository";
import { RetryingWebDavTransport } from "../src/webdav/retrying-transport";
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

const serverUrl = requireEnvironment("WEBDAV_URL");
const username = requireEnvironment("WEBDAV_USERNAME");
const password = requireEnvironment("WEBDAV_PASSWORD");
const credentials = { username, password };
const transport = new RetryingWebDavTransport(new FetchTransport());
const testDirectory = `codex-webdav-lock-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const rootClient = new WebDavClient({ serverUrl, remoteRoot: "", credentials }, transport);
let cleanupStatus: number | null = null;

try {
  const client = new WebDavClient({ serverUrl, remoteRoot: testDirectory, credentials }, transport);
  const capabilities = await client.probeCapabilities();
  const headUpdateStrategy = capabilities.capabilities.headUpdateStrategy;
  if (!capabilities.ok || !capabilities.capabilities.safeConcurrentWrites || !headUpdateStrategy) {
    throw new Error(`Capability probe failed: ${JSON.stringify(capabilities)}`);
  }
  const repository = new ContentAddressedRepository(client, {
    headUpdateStrategy,
    conditionalCreate: capabilities.capabilities.conditionalCreate,
  });
  const metadata = await repository.initialize();
  const commit = await createStoredCommit({
    formatVersion: 1,
    repositoryId: metadata.repositoryId,
    parents: [],
    deviceId: "lock-recovery",
    createdAt: new Date().toISOString(),
    files: {},
  });
  await repository.writeCommit(commit);

  // Case 1: even an expired lease must fail closed. Client-side expiry cannot
  // fence a paused old holder, so automatic takeover would be unsafe.
  await seedForeignLock(client, headUpdateStrategy, "crashed-device", Date.now() - 60_000);
  const head = await repository.readHead();
  const expiredContention = await repository.compareAndSwapHead(head.etag, {
    commit: commit.commitId,
    generation: head.reference.generation + 1,
  });
  if (expiredContention.updated || expiredContention.reason !== "conflict") {
    throw new Error(`Expired lock was not treated as contention: ${JSON.stringify(expiredContention)}`);
  }
  const lockPath = headUpdateStrategy === "move-lock" ? HEAD_LOCK_PATH : HEAD_LOCK_OWNER_PATH;
  if ((await client.get(lockPath)).status !== 200) {
    throw new Error("Expired lock was deleted without explicit user confirmation.");
  }

  // This models the sync center's confirmation-guarded "clear lock and retry"
  // action, which is the only safe recovery without a server fencing primitive.
  const cleared = await client.remove(HEAD_LOCK_PATH);
  if (![200, 204, 404].includes(cleared.status)) {
    throw new Error(`Could not clear the confirmed stale lock: HTTP ${cleared.status}`);
  }
  await waitUntilMissing(client, lockPath);
  const recovered = await repository.compareAndSwapHead(head.etag, {
    commit: commit.commitId,
    generation: head.reference.generation + 1,
  });
  if (!recovered.updated) {
    throw new Error(`Confirmed lock recovery failed: ${JSON.stringify(recovered)}`);
  }

  // Case 2: an active lease must still be treated as contention.
  await seedForeignLock(client, headUpdateStrategy, "active-device", Date.now() + 120_000);
  const headAfter = await repository.readHead();
  const activeContention = await repository.compareAndSwapHead(headAfter.etag, {
    commit: commit.commitId,
    generation: headAfter.reference.generation + 2,
  });
  if (activeContention.updated || activeContention.reason !== "conflict") {
    throw new Error(`Active lock did not block the update: ${JSON.stringify(activeContention)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    testDirectory,
    headUpdateStrategy,
    expiredLockFailsClosed: expiredContention.reason === "conflict",
    confirmedClearRecovers: recovered.updated,
    activeLockStillBlocks: activeContention.reason === "conflict",
  }, null, 2));
} finally {
  try {
    cleanupStatus = (await rootClient.remove(testDirectory)).status;
  } catch {
    cleanupStatus = null;
  }
  console.error(JSON.stringify({ cleanupDirectory: testDirectory, cleanupStatus }));
}

async function seedForeignLock(
  client: WebDavClient,
  strategy: "etag" | "mkcol-lock" | "move-lock",
  ownerId: string,
  expiresAt: number,
): Promise<void> {
  const lease = canonicalJson({ formatVersion: 1, ownerId, expiresAt });
  if (strategy === "move-lock") {
    const put = await client.put(HEAD_LOCK_PATH, lease, { "Content-Type": "application/json" });
    if (!(put.status >= 200 && put.status < 300)) {
      throw new Error(`Could not seed a foreign MOVE lock: HTTP ${put.status}`);
    }
    return;
  }
  const collection = await client.makeCollection(HEAD_LOCK_PATH);
  if (collection.status !== 201 && collection.status !== 405) {
    throw new Error(`Could not seed a foreign MKCOL lock: HTTP ${collection.status}`);
  }
  const owner = await client.put(HEAD_LOCK_OWNER_PATH, lease, { "Content-Type": "application/json" });
  if (!(owner.status >= 200 && owner.status < 300)) {
    throw new Error(`Could not write the foreign lock owner: HTTP ${owner.status}`);
  }
}

async function waitUntilMissing(client: WebDavClient, path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await client.get(path)).status === 404) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`WebDAV deletion did not become visible for ${path}.`);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
