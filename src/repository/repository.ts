import { canonicalJson } from "./canonical-json";
import { verifyStoredCommit } from "./commit";
import { sha256Hex } from "./hash";
import {
  blobPath,
  commitPath,
  HEAD_LOCK_CANDIDATES_PATH,
  HEAD_LOCK_OWNER_PATH,
  HEAD_LOCK_PATH,
  HEAD_PATH,
  packPath,
  REPOSITORY_METADATA_PATH,
} from "./paths";
import type {
  RepositoryFileEntry,
  HeadReference,
  HeadSnapshot,
  HeadUpdateResult,
  RepositoryMetadata,
  RepositoryOptions,
  RepositoryRemote,
  StoredCommit,
} from "./types";
import { validateStoredCommitShape } from "./validation";

export interface BlobPackWriteRequest {
  id: string;
  data: ArrayBuffer;
  expectedHash: string;
  size: number;
  kind: RepositoryFileEntry["kind"];
}

export interface CommitHistoryEntry {
  commitId: string;
  parents: string[];
  deviceId: string;
  createdAt: string;
  fileCount: number;
}

const DEFAULT_MAX_PACKED_BLOB_BYTES = 256 * 1_024;
const DEFAULT_MAX_BLOB_PACK_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 200;
const LOCK_CONSISTENCY_POLLS = 20;
const LOCK_CONSISTENCY_DELAY_MS = 250;

export class ContentAddressedRepository {
  private metadata: RepositoryMetadata | null = null;
  private readonly headUpdateStrategy: "etag" | "mkcol-lock" | "move-lock";
  private readonly conditionalCreate: boolean;
  private readonly lockLeaseMs: number;
  private readonly createLockOwnerId: () => string;
  private readonly now: () => Date;
  private readonly sleepFor: (milliseconds: number) => Promise<void>;
  private readonly enableBlobPacks: boolean;
  private readonly maxPackedBlobBytes: number;
  private readonly maxBlobPackBytes: number;
  private readonly packCache = new Map<string, Promise<ArrayBuffer>>();

  constructor(
    private readonly remote: RepositoryRemote,
    options: RepositoryOptions = {},
  ) {
    this.headUpdateStrategy = options.headUpdateStrategy ?? "etag";
    this.conditionalCreate = options.conditionalCreate ?? true;
    this.lockLeaseMs = options.lockLeaseMs ?? 120_000;
    if (!Number.isFinite(this.lockLeaseMs) || this.lockLeaseMs <= 0) {
      throw new Error("Repository lock lease duration must be positive.");
    }
    this.enableBlobPacks = options.enableBlobPacks ?? true;
    this.maxPackedBlobBytes = options.maxPackedBlobBytes ?? DEFAULT_MAX_PACKED_BLOB_BYTES;
    this.maxBlobPackBytes = options.maxBlobPackBytes ?? DEFAULT_MAX_BLOB_PACK_BYTES;
    if (!Number.isSafeInteger(this.maxPackedBlobBytes) || this.maxPackedBlobBytes <= 0) {
      throw new Error("Maximum packed blob size must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.maxBlobPackBytes) || this.maxBlobPackBytes <= 0) {
      throw new Error("Maximum blob pack size must be a positive integer.");
    }
    this.createLockOwnerId = options.lockOwnerId
      ? () => options.lockOwnerId as string
      : () => crypto.randomUUID();
    this.now = options.now ?? (() => new Date());
    this.sleepFor = options.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  }

  async initialize(now = new Date()): Promise<RepositoryMetadata> {
    await this.ensureCollection("objects");
    await this.ensureCollection("objects/sha256");
    if (this.enableBlobPacks) {
      await this.ensureCollection("packs");
      await this.ensureCollection("packs/sha256");
    }
    await this.ensureCollection("commits");
    await this.ensureCollection("refs");
    if (this.headUpdateStrategy === "move-lock") {
      await this.ensureCollection(HEAD_LOCK_CANDIDATES_PATH);
      return this.initializeWithHeadLease(now);
    }

    let metadata = await this.tryReadMetadata();
    if (!metadata) {
      metadata = await this.createMetadata(now, true);
    }

    await this.ensureHead();
    this.metadata = metadata;
    return metadata;
  }

  async writeBlob(data: ArrayBuffer): Promise<string> {
    const hash = await sha256Hex(data);
    await this.ensureCollection(`objects/sha256/${hash.slice(0, 2)}`);
    const response = await this.remote.put(
      blobPath(hash),
      data,
      this.conditionalCreate ? { "If-None-Match": "*" } : {},
    );
    if (response.status === 412) await this.readBlob(hash);
    else {
      assertSuccessful(response.status, "write blob");
      if (!this.conditionalCreate) await this.readBlob(hash);
    }
    return hash;
  }

  shouldPackBlob(size: number): boolean {
    return this.enableBlobPacks && size >= 0 && size <= this.maxPackedBlobBytes;
  }

  getMaxBlobPackBytes(): number {
    return this.maxBlobPackBytes;
  }

  async writeBlobPack(requests: readonly BlobPackWriteRequest[]): Promise<Map<string, RepositoryFileEntry>> {
    if (!this.enableBlobPacks) throw new Error("Blob packs are disabled for this repository.");
    if (requests.length === 0) return new Map();
    const totalBytes = requests.reduce((sum, request) => sum + request.size, 0);
    if (totalBytes > this.maxBlobPackBytes) throw new Error("Blob pack is larger than the configured maximum.");

    const packBytes = new Uint8Array(totalBytes);
    const locations = new Map<string, { offset: number; length: number }>();
    let offset = 0;
    for (const request of requests) {
      if (request.data.byteLength !== request.size) throw new Error(`Packed blob ${request.id} has an unexpected size.`);
      const actualHash = await sha256Hex(request.data);
      if (actualHash !== request.expectedHash) throw new Error(`Packed blob ${request.id} changed while being uploaded.`);
      packBytes.set(new Uint8Array(request.data), offset);
      locations.set(request.id, { offset, length: request.size });
      offset += request.size;
    }

    const packBuffer = packBytes.buffer;
    const packHash = await sha256Hex(packBuffer);
    const path = packPath(packHash);
    await this.ensureCollection(`packs/sha256/${packHash.slice(0, 2)}`);
    const response = await this.remote.put(
      path,
      packBuffer,
      this.conditionalCreate ? { "If-None-Match": "*" } : {},
    );
    if (response.status === 412) await this.readAndVerifyPack(path, packHash);
    else {
      assertSuccessful(response.status, "write blob pack");
      if (this.conditionalCreate) this.packCache.set(path, Promise.resolve(packBuffer.slice(0)));
      else await this.readAndVerifyPack(path, packHash);
    }

    const entries = new Map<string, RepositoryFileEntry>();
    for (const request of requests) {
      const location = locations.get(request.id) as { offset: number; length: number };
      entries.set(request.id, {
        blob: request.expectedHash,
        size: request.size,
        kind: request.kind,
        pack: { path, ...location },
      });
    }
    return entries;
  }

  async readBlob(hash: string): Promise<ArrayBuffer> {
    const response = await this.remote.get(blobPath(hash));
    assertSuccessful(response.status, "read blob");
    if (await sha256Hex(response.arrayBuffer) !== hash) {
      throw new Error(`Blob ${hash} failed SHA-256 verification.`);
    }
    return response.arrayBuffer;
  }

  async readFileEntryBlob(entry: RepositoryFileEntry): Promise<ArrayBuffer> {
    if (!entry.pack) return this.readBlob(entry.blob);
    const packHash = parsePackHash(entry.pack.path);
    const pack = await this.readAndVerifyPack(entry.pack.path, packHash);
    const end = entry.pack.offset + entry.pack.length;
    if (end > pack.byteLength) throw new Error(`Blob ${entry.blob} points outside its blob pack.`);
    const data = pack.slice(entry.pack.offset, end);
    if (await sha256Hex(data) !== entry.blob) {
      throw new Error(`Packed blob ${entry.blob} failed SHA-256 verification.`);
    }
    return data;
  }

  async writeCommit(commit: StoredCommit): Promise<void> {
    validateStoredCommitShape(commit, commit.commitId, this.metadata?.repositoryId);
    if (!(await verifyStoredCommit(commit))) throw new Error("Cannot write a commit with an invalid ID.");
    const response = await this.remote.put(
      commitPath(commit.commitId),
      canonicalJson(commit),
      jsonHeaders(this.conditionalCreate ? { "If-None-Match": "*" } : {}),
    );
    if (response.status === 412) await this.readCommit(commit.commitId);
    else {
      assertSuccessful(response.status, "write commit");
      if (!this.conditionalCreate) await this.readCommit(commit.commitId);
    }
  }

  async readCommit(commitId: string): Promise<StoredCommit> {
    const response = await this.remote.get(commitPath(commitId));
    assertSuccessful(response.status, "read commit");
    const commit = JSON.parse(response.text) as StoredCommit;
    validateStoredCommitShape(commit, commitId, this.metadata?.repositoryId);
    if (!(await verifyStoredCommit(commit))) {
      throw new Error(`Commit ${commitId} failed integrity verification.`);
    }
    return commit;
  }

  async listCommitHistory(limit = DEFAULT_HISTORY_LIMIT): Promise<CommitHistoryEntry[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_HISTORY_LIMIT);
    const [metadataResponse, headResponse] = await Promise.all([
      this.remote.get(REPOSITORY_METADATA_PATH),
      this.remote.get(HEAD_PATH),
    ]);
    if (metadataResponse.status === 404 && headResponse.status === 404) return [];
    if (metadataResponse.status === 404 || headResponse.status === 404) {
      throw new Error("Repository history is incomplete: metadata and HEAD must either both exist or both be absent.");
    }
    assertSuccessful(metadataResponse.status, "read repository metadata for history");
    assertSuccessful(headResponse.status, "read HEAD for history");
    this.metadata = parseMetadata(metadataResponse.text);
    const head = parseHead(headResponse.text);
    if (head.commit === null) return [];
    const visited = new Set<string>();
    const pending = [head.commit];
    const entries: CommitHistoryEntry[] = [];
    while (pending.length > 0 && visited.size < boundedLimit) {
      const commitId = pending.shift() as string;
      if (visited.has(commitId)) continue;
      visited.add(commitId);
      const commit = await this.readCommit(commitId);
      entries.push({
        commitId: commit.commitId,
        parents: [...commit.parents],
        deviceId: commit.deviceId,
        createdAt: commit.createdAt,
        fileCount: Object.keys(commit.files).length,
      });
      pending.push(...commit.parents);
    }
    return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async readHead(): Promise<HeadSnapshot> {
    const response = await this.remote.get(HEAD_PATH);
    assertSuccessful(response.status, "read HEAD");
    const etag = getHeader(response.headers, "etag") ?? await this.remote.getEtag(HEAD_PATH);
    if (!etag || etag.startsWith("W/")) {
      throw new Error("A strong ETag is required for repository HEAD.");
    }
    return { reference: parseHead(response.text), etag };
  }

  async compareAndSwapHead(expectedEtag: string, next: HeadReference): Promise<HeadUpdateResult> {
    if (this.headUpdateStrategy !== "etag") {
      return this.compareAndSwapHeadWithLock(expectedEtag, next);
    }
    const response = await this.remote.put(
      HEAD_PATH,
      canonicalJson(next),
      jsonHeaders({ "If-Match": expectedEtag }),
    );
    if (response.status === 412) return { updated: false, reason: "conflict" };
    assertSuccessful(response.status, "update HEAD");
    return { updated: true };
  }

  private async ensureHead(): Promise<void> {
    const existing = await this.remote.get(HEAD_PATH);
    if (isSuccessful(existing.status)) return;
    if (existing.status !== 404) throw remoteError("read HEAD", existing.status);

    if (this.headUpdateStrategy !== "etag") {
      const lease = await this.acquireHeadLease();
      if (!lease) {
        const afterContention = await this.remote.get(HEAD_PATH);
        if (isSuccessful(afterContention.status)) return;
        throw new Error("Repository HEAD lock is busy; retry synchronization.");
      }
      try {
        const afterLock = await this.remote.get(HEAD_PATH);
        if (isSuccessful(afterLock.status)) return;
        if (afterLock.status !== 404) throw remoteError("read HEAD", afterLock.status);
        await this.createHead(this.conditionalCreate);
        return;
      } finally {
        await this.releaseHeadLease(lease);
      }
    }

    await this.createHead(true);
  }

  private async createHead(conditionalCreate: boolean): Promise<void> {
    const response = await this.remote.put(
      HEAD_PATH,
      canonicalJson({ commit: null, generation: 0 } satisfies HeadReference),
      jsonHeaders(conditionalCreate ? { "If-None-Match": "*" } : {}),
    );
    if (response.status === 412) await this.readHead();
    else assertSuccessful(response.status, "create HEAD");
  }

  private async compareAndSwapHeadWithLock(
    expectedEtag: string,
    next: HeadReference,
  ): Promise<HeadUpdateResult> {
    const lease = await this.acquireHeadLease();
    if (!lease) return { updated: false, reason: "conflict" };

    let releaseLease = true;
    try {
      const current = await this.readHead();
      if (current.etag !== expectedEtag) return { updated: false, reason: "conflict" };
      if (!(await this.stillOwnsHeadLease(lease))) return { updated: false, reason: "conflict" };

      let putResponse: Awaited<ReturnType<RepositoryRemote["put"]>> | null = null;
      let putError: unknown = null;
      try {
        putResponse = await this.remote.put(HEAD_PATH, canonicalJson(next), jsonHeaders({}));
      } catch (error) {
        putError = error;
      }

      if (putResponse && !isSuccessful(putResponse.status) && !isAmbiguousMutationStatus(putResponse.status)) {
        throw remoteError("update HEAD under repository lock", putResponse.status);
      }

      const outcome = await this.reconcileHeadUpdate(current.reference, next);
      if (outcome === "updated") return { updated: true };
      if (outcome === "contradicted" || (putResponse && isSuccessful(putResponse.status))) {
        releaseLease = false;
        throw new Error("Repository HEAD contradicted a successful update; the repository lock was retained.");
      }

      releaseLease = false;
      throw new Error("Repository HEAD update is unresolved; the repository lock was retained.", {
        cause: putError ?? (putResponse ? remoteError("update HEAD under repository lock", putResponse.status) : undefined),
      });
    } finally {
      if (releaseLease) await this.releaseHeadLease(lease);
    }
  }

  private async acquireHeadLease(): Promise<HeadLease | null> {
    if (this.headUpdateStrategy === "move-lock") return this.acquireMoveHeadLease();

    let createdStatus: number | null = null;
    let createError: unknown = null;
    try {
      createdStatus = (await this.remote.makeCollection(HEAD_LOCK_PATH)).status;
    } catch (error) {
      createError = error;
    }
    if (createdStatus === 405 || createdStatus === 412 || createdStatus === 423) return null;
    if (createdStatus !== 201) {
      if (createdStatus !== null && !isAmbiguousMutationStatus(createdStatus)) {
        throw remoteError("acquire repository HEAD lock", createdStatus);
      }
      const outcome = await this.reconcileCreatedLockCollection();
      if (outcome === "contention") return null;
      if (outcome !== "created") {
        throw new Error("Repository HEAD lock acquisition is unresolved; no lock was removed or replayed.", {
          cause: createError ?? (createdStatus === null ? undefined : remoteError("acquire repository HEAD lock", createdStatus)),
        });
      }
    }

    const lease = this.createHeadLease();
    let ownerStatus: number | null = null;
    let ownerError: unknown = null;
    try {
      ownerStatus = (await this.remote.put(
        HEAD_LOCK_OWNER_PATH,
        canonicalJson(lease),
        jsonHeaders({ "If-None-Match": "*" }),
      )).status;
    } catch (error) {
      ownerError = error;
    }
    if (
      ownerStatus !== null &&
      ownerStatus !== 412 &&
      !isSuccessful(ownerStatus) &&
      !isAmbiguousMutationStatus(ownerStatus)
    ) {
      const removed = await this.remote.remove(HEAD_LOCK_PATH);
      if (!isSuccessful(removed.status) && removed.status !== 404) {
        throw new Error(
          `Could not clean up the repository HEAD lock after owner write failed with HTTP ${ownerStatus}.`,
          { cause: remoteError("remove repository HEAD lock", removed.status) },
        );
      }
      throw remoteError("write repository HEAD lock owner", ownerStatus);
    }
    const ownerOutcome = await this.reconcileHeadLeaseOwner(lease);
    if (ownerOutcome === "acquired") return lease;
    if (ownerOutcome === "contention") return null;
    throw new Error("Repository HEAD lock owner write is unresolved; the lock collection was retained.", {
      cause: ownerError ?? (ownerStatus === null ? undefined : remoteError("write repository HEAD lock owner", ownerStatus)),
    });
  }

  private async reconcileHeadUpdate(
    original: HeadReference,
    next: HeadReference,
  ): Promise<"updated" | "unchanged" | "contradicted" | "unresolved"> {
    for (let attempt = 0; attempt < LOCK_CONSISTENCY_POLLS; attempt += 1) {
      let response: Awaited<ReturnType<RepositoryRemote["get"]>>;
      try {
        response = await this.remote.get(HEAD_PATH);
      } catch {
        if (attempt + 1 < LOCK_CONSISTENCY_POLLS) {
          await this.sleep(LOCK_CONSISTENCY_DELAY_MS);
          continue;
        }
        return "unresolved";
      }
      if (isSuccessful(response.status)) {
        let reference: HeadReference;
        try {
          reference = parseHead(response.text);
        } catch {
          return "unresolved";
        }
        if (sameHeadReference(reference, next)) return "updated";
        if (!sameHeadReference(reference, original)) return "contradicted";
        if (attempt + 1 === LOCK_CONSISTENCY_POLLS) return "unchanged";
      } else if (!isRetryableReadStatus(response.status)) {
        return "unresolved";
      }
      if (attempt + 1 < LOCK_CONSISTENCY_POLLS) await this.sleep(LOCK_CONSISTENCY_DELAY_MS);
    }
    return "unresolved";
  }

  private async reconcileCreatedLockCollection(): Promise<"created" | "contention" | "unresolved"> {
    for (let attempt = 0; attempt < LOCK_CONSISTENCY_POLLS; attempt += 1) {
      const [collection, owner] = await Promise.all([
        this.remote.head(HEAD_LOCK_PATH),
        this.remote.get(HEAD_LOCK_OWNER_PATH),
      ]);
      if (isSuccessful(collection.status)) {
        if (isSuccessful(owner.status)) return "contention";
        if (owner.status === 404) return "created";
        return "unresolved";
      }
      if (collection.status !== 404 || owner.status !== 404) return "unresolved";
      if (attempt + 1 < LOCK_CONSISTENCY_POLLS) await this.sleep(LOCK_CONSISTENCY_DELAY_MS);
    }
    return "unresolved";
  }

  private async reconcileHeadLeaseOwner(
    lease: HeadLease,
  ): Promise<"acquired" | "contention" | "unresolved"> {
    for (let attempt = 0; attempt < LOCK_CONSISTENCY_POLLS; attempt += 1) {
      const owner = await this.remote.get(HEAD_LOCK_OWNER_PATH);
      if (isSuccessful(owner.status)) {
        return sameHeadLease(parseHeadLease(owner.text), lease) ? "acquired" : "contention";
      }
      if (owner.status !== 404 && !isRetryableReadStatus(owner.status)) return "unresolved";
      if (attempt + 1 < LOCK_CONSISTENCY_POLLS) await this.sleep(LOCK_CONSISTENCY_DELAY_MS);
    }
    return "unresolved";
  }

  private async acquireMoveHeadLease(): Promise<HeadLease | null> {
    const lease = this.createHeadLease();
    const candidatePath = `${HEAD_LOCK_CANDIDATES_PATH}/${lease.ownerId}.json`;
    const candidate = await this.remote.put(candidatePath, canonicalJson(lease), jsonHeaders({}));
    assertSuccessful(candidate.status, "write repository HEAD lock candidate");

    let moveStatus: number | null = null;
    let moveError: unknown = null;
    try {
      moveStatus = (await this.remote.move(candidatePath, HEAD_LOCK_PATH, false)).status;
    } catch (error) {
      moveError = error;
    }
    if (
      moveStatus !== null &&
      !isSuccessful(moveStatus) &&
      !isMoveContentionStatus(moveStatus) &&
      !isAmbiguousMutationStatus(moveStatus)
    ) {
      const removed = await this.remote.remove(candidatePath);
      if (!isSuccessful(removed.status) && removed.status !== 404) {
        throw new Error(
          `Could not clean up the repository HEAD lock candidate after MOVE failed with HTTP ${moveStatus}.`,
          { cause: remoteError("remove repository HEAD lock candidate", removed.status) },
        );
      }
      throw remoteError("acquire repository HEAD lock", moveStatus);
    }

    const outcome = await this.reconcileMoveHeadLease(candidatePath, lease);
    if (outcome === "acquired") return lease;
    if (outcome === "contention") {
      const removed = await this.remote.remove(candidatePath);
      if (!isSuccessful(removed.status) && removed.status !== 404) {
        throw remoteError("remove repository HEAD lock candidate", removed.status);
      }
      return null;
    }
    throw new Error("Repository MOVE lock acquisition is unresolved; no shared lock was removed.", {
      cause: moveError ?? (moveStatus === null ? undefined : remoteError("acquire repository HEAD lock", moveStatus)),
    });
  }

  private async reconcileMoveHeadLease(
    candidatePath: string,
    lease: HeadLease,
  ): Promise<"acquired" | "contention" | "unresolved"> {
    for (let attempt = 0; attempt < LOCK_CONSISTENCY_POLLS; attempt += 1) {
      const [owner, candidate] = await Promise.all([
        this.remote.get(HEAD_LOCK_PATH),
        this.remote.get(candidatePath),
      ]);
      const currentOwner = isSuccessful(owner.status) ? parseHeadLease(owner.text) : null;
      if (sameHeadLease(currentOwner, lease)) return "acquired";

      const currentCandidate = isSuccessful(candidate.status) ? parseHeadLease(candidate.text) : null;
      if (currentOwner && sameHeadLease(currentCandidate, lease)) return "contention";
      if (
        (isSuccessful(owner.status) && !currentOwner) ||
        (isSuccessful(candidate.status) && !currentCandidate) ||
        ![200, 404].includes(owner.status) ||
        ![200, 404].includes(candidate.status)
      ) {
        return "unresolved";
      }
      await this.sleep(LOCK_CONSISTENCY_DELAY_MS);
    }
    return "unresolved";
  }

  private sleep(milliseconds: number): Promise<void> {
    return this.sleepFor(milliseconds);
  }

  private createHeadLease(): HeadLease {
    return {
      formatVersion: 1,
      ownerId: this.createLockOwnerId(),
      expiresAt: this.now().getTime() + this.lockLeaseMs,
    };
  }

  private async stillOwnsHeadLease(expected: HeadLease): Promise<boolean> {
    if (expected.expiresAt <= this.now().getTime()) return false;
    const response = await this.remote.get(this.headLeaseOwnerPath());
    if (!isSuccessful(response.status)) return false;
    const current = parseHeadLease(response.text);
    return Boolean(
      current &&
      current.ownerId === expected.ownerId &&
      current.expiresAt === expected.expiresAt &&
      current.expiresAt > this.now().getTime()
    );
  }

  private async releaseHeadLease(expected: HeadLease): Promise<void> {
    const owner = await this.remote.get(this.headLeaseOwnerPath());
    if (owner.status === 404) return;
    if (!isSuccessful(owner.status)) throw remoteError("read repository HEAD lock owner", owner.status);
    const current = parseHeadLease(owner.text);
    if (!current || current.ownerId !== expected.ownerId || current.expiresAt !== expected.expiresAt) return;
    const removed = await this.remote.remove(HEAD_LOCK_PATH);
    if (!isSuccessful(removed.status) && removed.status !== 404) {
      throw remoteError("release repository HEAD lock", removed.status);
    }
  }

  private headLeaseOwnerPath(): string {
    return this.headUpdateStrategy === "move-lock" ? HEAD_LOCK_PATH : HEAD_LOCK_OWNER_PATH;
  }

  private async initializeWithHeadLease(now: Date): Promise<RepositoryMetadata> {
    const lease = await this.acquireHeadLease();
    if (!lease) {
      const metadata = await this.tryReadMetadata();
      const head = await this.remote.get(HEAD_PATH);
      if (metadata && isSuccessful(head.status)) {
        this.metadata = metadata;
        return metadata;
      }
      throw new Error("Repository initialization lock is busy; retry synchronization.");
    }

    try {
      let metadata = await this.tryReadMetadata();
      if (!metadata) metadata = await this.createMetadata(now, false);
      const head = await this.remote.get(HEAD_PATH);
      if (head.status === 404) await this.createHead(false);
      else assertSuccessful(head.status, "read HEAD");
      this.metadata = metadata;
      return metadata;
    } finally {
      await this.releaseHeadLease(lease);
    }
  }

  private async createMetadata(now: Date, conditionalCreate: boolean): Promise<RepositoryMetadata> {
    const candidate: RepositoryMetadata = {
      formatVersion: 1,
      repositoryId: crypto.randomUUID(),
      hashAlgorithm: "sha256",
      createdAt: now.toISOString(),
    };
    const response = await this.remote.put(
      REPOSITORY_METADATA_PATH,
      canonicalJson(candidate),
      jsonHeaders(conditionalCreate ? { "If-None-Match": "*" } : {}),
    );
    if (response.status === 412) return this.readMetadata();
    assertSuccessful(response.status, "create repository metadata");
    const stored = await this.readMetadata();
    if (stored.repositoryId !== candidate.repositoryId) {
      throw new Error("Repository metadata changed while it was being initialized.");
    }
    return stored;
  }

  private async ensureCollection(path: string): Promise<void> {
    const response = await this.remote.makeCollection(path);
    if (response.status === 201) return;
    if (response.status === 405 || response.status === 423) {
      const existing = await this.remote.head(path);
      if (isSuccessful(existing.status)) return;
    }
    throw remoteError(`create collection ${path}`, response.status);
  }

  private async tryReadMetadata(): Promise<RepositoryMetadata | null> {
    const response = await this.remote.get(REPOSITORY_METADATA_PATH);
    if (response.status === 404) return null;
    assertSuccessful(response.status, "read repository metadata");
    return parseMetadata(response.text);
  }

  private async readMetadata(): Promise<RepositoryMetadata> {
    const metadata = await this.tryReadMetadata();
    if (!metadata) throw new Error("Repository metadata disappeared during initialization.");
    return metadata;
  }

  private async readAndVerifyPack(path: string, expectedHash: string): Promise<ArrayBuffer> {
    const cached = this.packCache.get(path);
    if (cached) return cached;
    const pack = this.remote.get(path).then(async (response) => {
      assertSuccessful(response.status, "read blob pack");
      if (await sha256Hex(response.arrayBuffer) !== expectedHash) {
        throw new Error(`Blob pack ${expectedHash} failed SHA-256 verification.`);
      }
      return response.arrayBuffer;
    });
    this.packCache.set(path, pack);
    return pack;
  }
}

interface HeadLease {
  formatVersion: 1;
  ownerId: string;
  expiresAt: number;
}

function parseMetadata(text: string): RepositoryMetadata {
  let value: Partial<RepositoryMetadata>;
  try {
    value = JSON.parse(text) as Partial<RepositoryMetadata>;
  } catch {
    throw new Error("Unsupported or malformed repository metadata.");
  }
  if (
    value.formatVersion !== 1 ||
    typeof value.repositoryId !== "string" ||
    value.repositoryId.length === 0 ||
    value.hashAlgorithm !== "sha256" ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("Unsupported or malformed repository metadata.");
  }
  return value as RepositoryMetadata;
}

function parseHead(text: string): HeadReference {
  const value = JSON.parse(text) as Partial<HeadReference>;
  if ((value.commit !== null && typeof value.commit !== "string") || !Number.isInteger(value.generation)) {
    throw new Error("Malformed repository HEAD.");
  }
  return { commit: value.commit ?? null, generation: value.generation as number };
}

function parsePackHash(path: string): string {
  const match = /^packs\/sha256\/[a-f0-9]{2}\/([a-f0-9]{64})\.pack$/.exec(path);
  if (!match) throw new Error("Malformed blob pack path.");
  return match[1] as string;
}

function parseHeadLease(text: string): HeadLease | null {
  try {
    const value = JSON.parse(text) as Partial<HeadLease>;
    if (
      value.formatVersion !== 1 ||
      typeof value.ownerId !== "string" ||
      !value.ownerId ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt ?? 0) < 0
    ) {
      return null;
    }
    return value as HeadLease;
  } catch {
    return null;
  }
}

function sameHeadReference(left: HeadReference, right: HeadReference): boolean {
  return left.commit === right.commit && left.generation === right.generation;
}

function sameHeadLease(left: HeadLease | null, right: HeadLease): boolean {
  return Boolean(
    left &&
    left.ownerId === right.ownerId &&
    left.expiresAt === right.expiresAt
  );
}

function jsonHeaders(extra: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? null;
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function isMoveContentionStatus(status: number): boolean {
  return status === 409 || status === 412 || status === 423;
}

function isAmbiguousMutationStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableReadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function assertSuccessful(status: number, action: string): void {
  if (!isSuccessful(status)) throw remoteError(action, status);
}

function remoteError(action: string, status: number): Error {
  return new Error(`Could not ${action}: WebDAV returned HTTP ${status}.`);
}
