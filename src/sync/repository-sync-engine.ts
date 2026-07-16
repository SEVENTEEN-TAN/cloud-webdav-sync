import { mapLimitWeighted } from "../concurrency";
import { mergeMarkdown, type MarkdownMergeConflict } from "../merge/markdown-diff3";
import { planTreeSync, type TreePlanItem } from "../planning";
import {
  ContentAddressedRepository,
  createStoredCommit,
  sha256Hex,
  type BlobPackWriteRequest,
  type RepositoryFileEntry,
  type RepositoryTree,
  type StoredCommit,
} from "../repository";

export interface LocalWorkspace {
  scan(onProgress?: ScanProgressReporter): Promise<RepositoryTree>;
  read(path: string): Promise<ArrayBuffer>;
  write(
    path: string,
    data: ArrayBuffer,
    kind: RepositoryFileEntry["kind"],
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void>;
  remove(path: string, expectedCurrent: ArrayBuffer): Promise<void>;
  removeEmptyFolder(path: string): Promise<void>;
}

export type SyncProgressPhase =
  | "initializing"
  | "scanning"
  | "planning"
  | "uploading"
  | "downloading"
  | "merging"
  | "applying"
  | "updating-head";

export interface SyncProgress {
  phase: SyncProgressPhase;
  completed: number;
  total: number;
  message?: string;
}

export type SyncProgressReporter = (progress: SyncProgress) => void;
export type ScanProgressReporter = (completed: number, total: number) => void;

export interface SyncSessionState {
  baseCommitId: string | null;
  deviceId: string;
  repositoryId: string | null;
  pendingApply?: PendingApplyState;
}

export interface PendingApplyState {
  targetCommitId: string;
  sourceBaseCommitId: string | null;
  operationId: string;
}

export interface SyncEngineOptions {
  concurrency?: number;
  now?: () => Date;
  initialSyncPolicy?: InitialSyncPolicy;
  persistSessionState?: (state: SyncSessionState) => Promise<void>;
  assertSafePoint?: () => void;
  maxInFlightBytes?: number;
  reportProgress?: SyncProgressReporter;
}

export type InitialSyncPolicy = "stop" | "prefer-local" | "prefer-remote";

export type ConflictChoice = "local" | "remote";

export interface ConflictResolution {
  choice: ConflictChoice;
  baseBlob: string | null;
  localBlob: string | null;
  remoteBlob: string | null;
}

export type ConflictResolutionMap = Readonly<Record<string, ConflictResolution>>;

export interface MarkdownConflictVersions {
  base: string;
  local: string;
  remote: string;
}

export type RepositorySyncResult =
  | { status: "up-to-date"; state: SyncSessionState }
  | { status: "pushed" | "pulled" | "merged"; state: SyncSessionState; commitId: string }
  | { status: "retry"; state: SyncSessionState }
  | {
      status: "conflict";
      state: SyncSessionState;
      reason:
        | "initial-both-nonempty"
        | "remote-reset"
        | "repository-mismatch"
        | "history-diverged"
        | "pending-apply-local-change"
        | "mass-delete"
        | "tree-conflict";
      plan?: TreePlanItem[];
      markdownConflicts?: Record<string, readonly MarkdownMergeConflict[]>;
      markdownConflictVersions?: Record<string, MarkdownConflictVersions>;
    };

export class RepositorySyncEngine {
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly initialSyncPolicy: InitialSyncPolicy;
  private readonly persistSessionState: (state: SyncSessionState) => Promise<void>;
  private readonly assertSafePoint: () => void;
  private readonly maxInFlightBytes: number;
  private readonly reportProgress: SyncProgressReporter;

  constructor(
    private readonly repository: ContentAddressedRepository,
    private readonly workspace: LocalWorkspace,
    options: SyncEngineOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 4;
    this.now = options.now ?? (() => new Date());
    this.initialSyncPolicy = options.initialSyncPolicy ?? "stop";
    this.persistSessionState = options.persistSessionState ?? (async () => undefined);
    this.assertSafePoint = options.assertSafePoint ?? (() => undefined);
    this.reportProgress = options.reportProgress ?? (() => undefined);
    this.maxInFlightBytes = options.maxInFlightBytes ?? 256 * 1_024 * 1_024;
    if (!Number.isFinite(this.maxInFlightBytes) || this.maxInFlightBytes <= 0) {
      throw new RangeError("maxInFlightBytes must be a positive finite number");
    }
  }

  async sync(
    state: SyncSessionState,
    resolutions: ConflictResolutionMap = {},
  ): Promise<RepositorySyncResult> {
    this.assertSafePoint();
    this.reportProgress({ phase: "initializing", completed: 0, total: 1, message: "初始化远程仓库" });
    const metadata = await this.repository.initialize(this.now());
    this.reportProgress({ phase: "initializing", completed: 1, total: 1, message: "初始化远程仓库" });
    this.assertSafePoint();
    if (state.repositoryId && state.repositoryId !== metadata.repositoryId) {
      return { status: "conflict", state, reason: "repository-mismatch" };
    }
    if (state.pendingApply) {
      return this.resumePendingApply(state, metadata.repositoryId, state.pendingApply);
    }
    const head = await this.repository.readHead();
    const localTree = await this.scanWorkspace();
    this.reportProgress({ phase: "planning", completed: 0, total: 1, message: "规划同步" });

    if (head.reference.commit === null) {
      if (state.baseCommitId !== null) return { status: "conflict", state, reason: "remote-reset" };
      if (Object.keys(localTree).length === 0) {
        this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
        return { status: "up-to-date", state: { ...state, repositoryId: metadata.repositoryId } };
      }
      this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
      return this.pushTree(state, metadata.repositoryId, head.etag, head.reference.generation, localTree, [], {});
    }

    const remoteCommit = await this.repository.readCommit(head.reference.commit);
    if (state.baseCommitId === null) {
      if (Object.keys(localTree).length === 0) {
        this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
        return this.applyCommit(
          "pulled",
          state,
          metadata.repositoryId,
          remoteCommit,
          null,
          localTree,
        );
      }
      if (sameTree(localTree, remoteCommit.files)) {
        this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
        return {
          status: "up-to-date",
          state: { ...state, repositoryId: metadata.repositoryId, baseCommitId: remoteCommit.commitId },
        };
      }
      if (this.initialSyncPolicy === "prefer-remote") {
        if (isMassDelete(localTree, remoteCommit.files)) {
          return { status: "conflict", state, reason: "mass-delete" };
        }
        this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
        const sourceCommitId = await this.writeLocalRecoverySnapshot(
          metadata.repositoryId,
          state.deviceId,
          localTree,
        );
        return this.applyCommit(
          "pulled",
          state,
          metadata.repositoryId,
          remoteCommit,
          sourceCommitId,
          localTree,
        );
      }
      if (this.initialSyncPolicy === "prefer-local") {
        this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
        return this.pushTree(
          state,
          metadata.repositoryId,
          head.etag,
          head.reference.generation,
          localTree,
          [remoteCommit.commitId],
          remoteCommit.files,
        );
      }
      return { status: "conflict", state, reason: "initial-both-nonempty" };
    }

    const baseCommit = await this.repository.readCommit(state.baseCommitId);
    const localChanged = !sameTree(localTree, baseCommit.files);
    const remoteChanged = remoteCommit.commitId !== baseCommit.commitId;

    if (remoteChanged && !(await this.isAncestor(baseCommit.commitId, remoteCommit))) {
      return { status: "conflict", state, reason: "history-diverged" };
    }

    this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });

    if (!localChanged && !remoteChanged) {
      this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
      return { status: "up-to-date", state: { ...state, repositoryId: metadata.repositoryId } };
    }
    if (!localChanged) {
      if (isMassDelete(localTree, remoteCommit.files)) {
        return { status: "conflict", state, reason: "mass-delete" };
      }
      this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
      return this.applyCommit(
        "pulled",
        state,
        metadata.repositoryId,
        remoteCommit,
        baseCommit.commitId,
        localTree,
      );
    }
    if (!remoteChanged) {
      this.reportProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
      return this.pushTree(
        state,
        metadata.repositoryId,
        head.etag,
        head.reference.generation,
        localTree,
        [baseCommit.commitId],
        baseCommit.files,
      );
    }

    return this.mergeTrees(
      state,
      metadata.repositoryId,
      head.etag,
      head.reference.generation,
      baseCommit,
      localTree,
      remoteCommit,
      resolutions,
    );
  }

  private async scanWorkspace(): Promise<RepositoryTree> {
    let reported = false;
    this.reportProgress({ phase: "scanning", completed: 0, total: 1, message: "扫描知识库" });
    const tree = await this.workspace.scan((completed, total) => {
      reported = true;
      this.reportProgress({
        phase: "scanning",
        completed: total > 0 ? completed : 1,
        total: Math.max(total, 1),
        message: "扫描知识库",
      });
    });
    if (!reported) {
      this.reportProgress({ phase: "scanning", completed: 1, total: 1, message: "扫描知识库" });
    }
    return tree;
  }

  private async pushTree(
    state: SyncSessionState,
    repositoryId: string,
    headEtag: string,
    generation: number,
    tree: RepositoryTree,
    parents: string[],
    baseline: RepositoryTree,
  ): Promise<RepositorySyncResult> {
    if (isMassDelete(baseline, tree)) {
      return { status: "conflict", state, reason: "mass-delete" };
    }
    await this.uploadChangedBlobs(tree, baseline, new Map());
    const commit = await this.createCommit(repositoryId, state.deviceId, parents, tree);
    this.reportProgress({ phase: "uploading", completed: 0, total: 1, message: "上传提交记录" });
    await this.repository.writeCommit(commit);
    this.reportProgress({ phase: "uploading", completed: 1, total: 1, message: "上传提交记录" });
    this.assertSafePoint();
    this.reportProgress({ phase: "updating-head", completed: 0, total: 1, message: "更新远程 HEAD" });
    const update = await this.repository.compareAndSwapHead(headEtag, {
      commit: commit.commitId,
      generation: generation + 1,
    });
    this.reportProgress({ phase: "updating-head", completed: 1, total: 1, message: "更新远程 HEAD" });
    return update.updated
      ? this.completed("pushed", state, repositoryId, commit.commitId)
      : { status: "retry", state };
  }

  private async mergeTrees(
    state: SyncSessionState,
    repositoryId: string,
    headEtag: string,
    generation: number,
    base: StoredCommit,
    localTree: RepositoryTree,
    remote: StoredCommit,
    resolutions: ConflictResolutionMap,
  ): Promise<RepositorySyncResult> {
    const plan = planTreeSync(base.files, localTree, remote.files);
    const hardConflicts = plan.filter(
      (item) =>
        item.action.startsWith("conflict-") &&
        item.action !== "conflict-binary" &&
        !hasValidResolution(item, resolutions[item.path]),
    );
    if (hardConflicts.length > 0) return { status: "conflict", state, reason: "tree-conflict", plan };

    const mergedTree = cloneTree(remote.files);
    const reservedPaths = new Set([...Object.keys(localTree), ...Object.keys(remote.files)]);
    const mergedData = new Map<string, ArrayBuffer>();
    const markdownConflicts = Object.create(null) as Record<string, readonly MarkdownMergeConflict[]>;
    const markdownConflictVersions = Object.create(null) as Record<string, MarkdownConflictVersions>;
    let mergedItems = 0;
    const mergeTotal = Math.max(plan.length, 1);
    this.reportProgress({ phase: "merging", completed: 0, total: mergeTotal, message: "合并更改" });

    for (const item of plan) {
      try {
        if (item.action === "upload") mergedTree[item.path] = item.local as RepositoryFileEntry;
        else if (item.action === "delete-remote") delete mergedTree[item.path];
        else if (item.action === "conflict-binary") {
          mergedTree[item.path] = item.local as RepositoryFileEntry;
          const conflictPath = chooseConflictPath(item.path, remote.deviceId, remote.commitId, reservedPaths);
          reservedPaths.add(conflictPath);
          mergedTree[conflictPath] = item.remote as RepositoryFileEntry;
        }
        else if (item.action === "conflict-add-add" || item.action === "conflict-delete-modify") {
          applyResolution(mergedTree, item, resolutions[item.path] as ConflictResolution);
        }
        else if (item.action === "merge-text") {
          const baseText = decode(await this.repository.readFileEntryBlob(item.base as RepositoryFileEntry));
          const localBytes = await this.workspace.read(item.path);
          const remoteText = decode(await this.repository.readFileEntryBlob(item.remote as RepositoryFileEntry));
          const localText = decode(localBytes);
          const merge = mergeMarkdown(baseText, localText, remoteText);
          if (!merge.clean) {
            const resolution = resolutions[item.path];
            if (hasValidResolution(item, resolution)) {
              applyResolution(mergedTree, item, resolution);
              continue;
            }
            markdownConflicts[item.path] = merge.conflicts;
            markdownConflictVersions[item.path] = {
              base: baseText,
              local: localText,
              remote: remoteText,
            };
            continue;
          }
          const bytes = new TextEncoder().encode(merge.content).buffer;
          const blob = await sha256Hex(bytes);
          mergedData.set(item.path, bytes);
          mergedTree[item.path] = { blob, size: bytes.byteLength, kind: "text" };
        }
      } finally {
        mergedItems += 1;
        this.reportProgress({
          phase: "merging",
          completed: mergedItems,
          total: mergeTotal,
          message: "合并更改",
        });
      }
    }

    if (plan.length === 0) {
      this.reportProgress({ phase: "merging", completed: 1, total: 1, message: "合并更改" });
    }

    if (Object.keys(markdownConflicts).length > 0) {
      return {
        status: "conflict",
        state,
        reason: "tree-conflict",
        plan,
        markdownConflicts,
        markdownConflictVersions,
      };
    }

    if (isMassDelete(remote.files, mergedTree) || isMassDelete(localTree, mergedTree)) {
      return { status: "conflict", state, reason: "mass-delete", plan };
    }

    await this.uploadChangedBlobs(localTree, base.files, new Map());
    const localCommit = await this.createCommit(repositoryId, state.deviceId, [base.commitId], localTree);
    this.reportProgress({ phase: "uploading", completed: 0, total: 1, message: "上传本地提交" });
    await this.repository.writeCommit(localCommit);
    this.reportProgress({ phase: "uploading", completed: 1, total: 1, message: "上传本地提交" });
    await this.uploadChangedBlobs(mergedTree, remote.files, mergedData);
    const mergeCommit = await this.createCommit(
      repositoryId,
      state.deviceId,
      [remote.commitId, localCommit.commitId],
      mergedTree,
    );
    this.reportProgress({ phase: "uploading", completed: 0, total: 1, message: "上传合并提交" });
    await this.repository.writeCommit(mergeCommit);
    this.reportProgress({ phase: "uploading", completed: 1, total: 1, message: "上传合并提交" });

    this.assertSafePoint();
    this.reportProgress({ phase: "updating-head", completed: 0, total: 1, message: "更新远程 HEAD" });
    const update = await this.repository.compareAndSwapHead(headEtag, {
      commit: mergeCommit.commitId,
      generation: generation + 1,
    });
    this.reportProgress({ phase: "updating-head", completed: 1, total: 1, message: "更新远程 HEAD" });
    if (!update.updated) return { status: "retry", state };
    return this.applyCommit(
      "merged",
      state,
      repositoryId,
      mergeCommit,
      localCommit.commitId,
      localTree,
      mergedData,
    );
  }

  private async applyCommit(
    status: "pulled" | "merged",
    state: SyncSessionState,
    repositoryId: string,
    targetCommit: StoredCommit,
    sourceBaseCommitId: string | null,
    currentTree: RepositoryTree,
    overrides = new Map<string, ArrayBuffer>(),
  ): Promise<RepositorySyncResult> {
    if (status === "pulled") this.assertSafePoint();
    const pendingState: SyncSessionState = {
      ...state,
      repositoryId,
      pendingApply: {
        targetCommitId: targetCommit.commitId,
        sourceBaseCommitId,
        operationId: crypto.randomUUID(),
      },
    };
    await this.persistSessionState(pendingState);
    await this.applyTree(currentTree, targetCommit.files, overrides);
    const appliedTree = await this.workspace.scan();
    if (!sameTree(appliedTree, targetCommit.files)) {
      throw new Error("Local tree did not match the target commit after applying remote data.");
    }
    return this.completed(status, pendingState, repositoryId, targetCommit.commitId);
  }

  private async resumePendingApply(
    state: SyncSessionState,
    repositoryId: string,
    pending: PendingApplyState,
  ): Promise<RepositorySyncResult> {
    this.assertSafePoint();
    const target = await this.repository.readCommit(pending.targetCommitId);
    const sourceTree = pending.sourceBaseCommitId
      ? (await this.repository.readCommit(pending.sourceBaseCommitId)).files
      : {};
    const currentTree = await this.workspace.scan();
    if (!canResumeApply(currentTree, sourceTree, target.files)) {
      return { status: "conflict", state, reason: "pending-apply-local-change" };
    }
    await this.applyTree(currentTree, target.files);
    const appliedTree = await this.workspace.scan();
    if (!sameTree(appliedTree, target.files)) {
      throw new Error("Local tree did not match the pending target commit after recovery.");
    }
    return this.completed("pulled", state, repositoryId, target.commitId);
  }

  private async writeLocalRecoverySnapshot(
    repositoryId: string,
    deviceId: string,
    tree: RepositoryTree,
  ): Promise<string> {
    await this.uploadChangedBlobs(tree, {}, new Map());
    const commit = await this.createCommit(repositoryId, deviceId, [], tree);
    this.reportProgress({ phase: "uploading", completed: 0, total: 1, message: "上传本地恢复快照" });
    await this.repository.writeCommit(commit);
    this.reportProgress({ phase: "uploading", completed: 1, total: 1, message: "上传本地恢复快照" });
    return commit.commitId;
  }

  private async uploadChangedBlobs(
    tree: RepositoryTree,
    baseline: RepositoryTree,
    overrides: Map<string, ArrayBuffer>,
  ): Promise<void> {
    const baselineEntriesByBlob = new Map<string, RepositoryFileEntry>();
    for (const entry of Object.values(baseline)) {
      if (!baselineEntriesByBlob.has(entry.blob)) baselineEntriesByBlob.set(entry.blob, entry);
    }
    const paths = Object.keys(tree).filter((path) => {
      const entry = ownEntry(tree, path);
      return entry && entry.blob !== ownEntry(baseline, path)?.blob && !baselineEntriesByBlob.has(entry.blob);
    });
    for (const [path, entry] of Object.entries(tree)) {
      const stored = ownEntry(baseline, path)?.blob === entry.blob
        ? ownEntry(baseline, path)
        : baselineEntriesByBlob.get(entry.blob);
      if (stored?.pack) tree[path] = { ...entry, pack: stored.pack };
    }
    const total = Math.max(paths.length, 1);
    let completed = 0;
    const reportUploaded = () => {
      completed += 1;
      this.reportProgress({ phase: "uploading", completed, total, message: "上传文件内容" });
    };
    this.reportProgress({ phase: "uploading", completed, total, message: "上传文件内容" });
    if (paths.length === 0) {
      this.reportProgress({ phase: "uploading", completed: 1, total: 1, message: "上传文件内容" });
      return;
    }
    const packedPaths = paths.filter((path) => this.repository.shouldPackBlob(ownEntry(tree, path)?.size ?? 0));
    const loosePaths = paths.filter((path) => !packedPaths.includes(path));
    await mapLimitWeighted(
      loosePaths,
      this.concurrency,
      this.maxInFlightBytes,
      (path) => ownEntry(tree, path)?.size ?? 0,
      async (path) => {
      const expected = ownEntry(tree, path) as RepositoryFileEntry;
      const data = overrides.get(path) ?? await this.workspace.read(path);
      const actual = await this.repository.writeBlob(data);
      if (actual !== expected.blob) throw new Error(`Local file ${path} changed while being uploaded.`);
      reportUploaded();
      },
    );

    for (const chunk of chunkPackPaths(packedPaths, tree, this.repository.getMaxBlobPackBytes())) {
      const requests = await mapLimitWeighted(
        chunk,
        this.concurrency,
        this.maxInFlightBytes,
        (path) => ownEntry(tree, path)?.size ?? 0,
        async (path): Promise<BlobPackWriteRequest> => {
          const expected = ownEntry(tree, path) as RepositoryFileEntry;
          const data = overrides.get(path) ?? await this.workspace.read(path);
          return {
            id: path,
            data,
            expectedHash: expected.blob,
            size: expected.size,
            kind: expected.kind,
          };
        },
      );
      const entries = await this.repository.writeBlobPack(requests);
      for (const [path, entry] of entries) {
        tree[path] = entry;
        reportUploaded();
      }
    }
  }

  private async applyTree(
    current: RepositoryTree,
    target: RepositoryTree,
    overrides = new Map<string, ArrayBuffer>(),
  ): Promise<void> {
    const writes = Object.keys(target).filter(
      (path) => ownEntry(target, path)?.blob !== ownEntry(current, path)?.blob,
    );
    const deletes = Object.keys(current).filter((path) => !Object.hasOwn(target, path));
    const earlyDeletes = deletes.filter((path) =>
      writes.some((writePath) => isPathPrefix(path, writePath) || isPathPrefix(writePath, path)),
    );
    const remainingDeletes = deletes.filter((path) => !earlyDeletes.includes(path));
    const foldersToRemove = new Set<string>();
    for (const writePath of writes) {
      for (const deletedPath of earlyDeletes) {
        if (!isPathPrefix(writePath, deletedPath)) continue;
        let folder = parentPath(deletedPath);
        while (folder && (folder === writePath || isPathPrefix(writePath, folder))) {
          foldersToRemove.add(folder);
          if (folder === writePath) break;
          folder = parentPath(folder);
        }
      }
    }

    const applyTotal = Math.max(earlyDeletes.length + foldersToRemove.size + writes.length + remainingDeletes.length, 1);
    let applied = 0;
    const reportApplied = () => {
      applied += 1;
      this.reportProgress({ phase: "applying", completed: applied, total: applyTotal, message: "应用远程更改" });
    };
    this.reportProgress({ phase: "applying", completed: 0, total: applyTotal, message: "应用远程更改" });
    if (applyTotal === 1 && earlyDeletes.length + foldersToRemove.size + writes.length + remainingDeletes.length === 0) {
      this.reportProgress({ phase: "applying", completed: 1, total: 1, message: "应用远程更改" });
      return;
    }

    await this.removeFiles(current, earlyDeletes, reportApplied);
    for (const folder of [...foldersToRemove].sort((left, right) => pathDepth(right) - pathDepth(left))) {
      await this.workspace.removeEmptyFolder(folder);
      reportApplied();
    }

    await mapLimitWeighted(
      writes,
      this.concurrency,
      this.maxInFlightBytes,
      (path) => ownEntry(target, path)?.size ?? 0,
      async (path) => {
      const entry = ownEntry(target, path) as RepositoryFileEntry;
      const data = overrides.get(path) ?? await this.repository.readFileEntryBlob(entry);
      const currentEntry = ownEntry(current, path);
      const expectedCurrent = currentEntry ? await this.workspace.read(path) : null;
      if (currentEntry && await sha256Hex(expectedCurrent as ArrayBuffer) !== currentEntry.blob) {
        throw new Error(`Local file ${path} changed while synchronization was applying remote data.`);
      }
      await this.workspace.write(path, data, entry.kind, expectedCurrent);
      reportApplied();
      },
    );
    await this.removeFiles(current, remainingDeletes, reportApplied);
  }

  private async removeFiles(
    current: RepositoryTree,
    paths: readonly string[],
    onRemoved: () => void = () => undefined,
  ): Promise<void> {
    for (const path of paths) {
      const expected = ownEntry(current, path) as RepositoryFileEntry;
      const expectedCurrent = await this.workspace.read(path);
      if (await sha256Hex(expectedCurrent) !== expected.blob) {
        throw new Error(`Local file ${path} changed while synchronization was applying a delete.`);
      }
      await this.workspace.remove(path, expectedCurrent);
      onRemoved();
    }
  }

  private createCommit(
    repositoryId: string,
    deviceId: string,
    parents: string[],
    files: RepositoryTree,
  ): Promise<StoredCommit> {
    return createStoredCommit({
      formatVersion: 1,
      repositoryId,
      parents,
      deviceId,
      createdAt: this.now().toISOString(),
      files: cloneTree(files),
    });
  }

  private async isAncestor(ancestorId: string, descendant: StoredCommit): Promise<boolean> {
    const pending = [...descendant.parents];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const commitId = pending.pop() as string;
      if (commitId === ancestorId) return true;
      if (visited.has(commitId)) continue;
      visited.add(commitId);
      if (visited.size > 10_000) throw new Error("Repository history traversal exceeded 10,000 commits.");
      const commit = await this.repository.readCommit(commitId);
      pending.push(...commit.parents);
    }
    return false;
  }

  private completed(
    status: "pushed" | "pulled" | "merged",
    state: SyncSessionState,
    repositoryId: string,
    commitId: string,
  ): RepositorySyncResult {
    const { pendingApply: _pendingApply, ...stableState } = state;
    return {
      status,
      state: { ...stableState, repositoryId, baseCommitId: commitId },
      commitId,
    };
  }
}

function sameTree(left: RepositoryTree, right: RepositoryTree): boolean {
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...paths].every((path) => ownEntry(left, path)?.blob === ownEntry(right, path)?.blob);
}

function canResumeApply(
  current: RepositoryTree,
  source: RepositoryTree,
  target: RepositoryTree,
): boolean {
  const paths = new Set([
    ...Object.keys(current),
    ...Object.keys(source),
    ...Object.keys(target),
  ]);
  return [...paths].every((path) => {
    const currentBlob = ownEntry(current, path)?.blob;
    return currentBlob === ownEntry(source, path)?.blob ||
      currentBlob === ownEntry(target, path)?.blob;
  });
}

function isPathPrefix(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function cloneTree(tree: RepositoryTree): RepositoryTree {
  const result = Object.create(null) as RepositoryTree;
  for (const [path, entry] of Object.entries(tree)) result[path] = { ...entry };
  return result;
}

function chunkPackPaths(
  paths: readonly string[],
  tree: RepositoryTree,
  maxPackBytes: number,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const size = ownEntry(tree, path)?.size ?? 0;
    if (current.length > 0 && currentBytes + size > maxPackBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function decode(data: ArrayBuffer): string {
  return new TextDecoder().decode(data);
}

function chooseConflictPath(
  path: string,
  deviceId: string,
  commitId: string,
  reservedPaths: ReadonlySet<string>,
): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  const safeDevice = deviceId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 24) || "remote";
  const suffix = `${safeDevice}-${commitId.slice(0, 8)}`;
  let candidate = `${directory}${stem}.conflict-${suffix}${extension}`;
  let counter = 2;
  while (reservedPaths.has(candidate)) {
    candidate = `${directory}${stem}.conflict-${suffix}-${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}

function isMassDelete(current: RepositoryTree, target: RepositoryTree): boolean {
  const currentPaths = Object.keys(current);
  if (currentPaths.length === 0) return false;
  const deleted = currentPaths.filter((path) => !Object.hasOwn(target, path)).length;
  return deleted > 20 || (deleted >= 5 && deleted / currentPaths.length > 0.25);
}

function hasValidResolution(
  item: TreePlanItem,
  resolution: ConflictResolution | undefined,
): resolution is ConflictResolution {
  return Boolean(
    resolution &&
      resolution.baseBlob === (item.base?.blob ?? null) &&
      resolution.localBlob === (item.local?.blob ?? null) &&
      resolution.remoteBlob === (item.remote?.blob ?? null),
  );
}

function applyResolution(
  tree: RepositoryTree,
  item: TreePlanItem,
  resolution: ConflictResolution,
): void {
  const selected = resolution.choice === "local" ? item.local : item.remote;
  if (selected) tree[item.path] = selected;
  else delete tree[item.path];
}

function ownEntry(tree: RepositoryTree, path: string): RepositoryFileEntry | undefined {
  return Object.hasOwn(tree, path) ? tree[path] : undefined;
}
