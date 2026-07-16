import { Notice, Platform, Plugin, TFile } from "obsidian";
import { SyncStateMachine, type SyncState } from "./core";
import {
  BoundedMemoryLog,
  appendSyncHistory,
  loadSyncHistory,
  redactLogText,
  sanitizeDiagnosticConflicts,
  type SyncHistoryEntry,
  type SyncHistoryOutcome,
} from "./logging";
import {
  PASSWORD_SECRET_ID,
  hasConnectionSettings,
  isPathInExcludedFolders,
  normalizeSettings,
  type WebDavSyncSettings,
} from "./settings/settings";
import { loadSyncSession, serializePluginData } from "./settings/persisted-data";
import { WebDavSyncSettingTab, type SettingsController } from "./settings/settings-tab";
import {
  ChangeQueue,
  RepositorySyncEngine,
  SingleFlightSyncScheduler,
  type ConflictChoice,
  type ConflictResolution,
  type RepositorySyncResult,
  type SyncProgress,
  type SyncSessionState,
  type SyncTrigger,
} from "./sync";
import { SyncCenterModal, type SyncCenterController, type SyncCenterSnapshot } from "./ui/sync-center-modal";
import { ConflictResolverModal, type ConflictResolverController } from "./ui/conflict-resolver-modal";
import {
  ObsidianWebDavTransport,
  WebDavClient,
  type CapabilityProbeResult,
  type HeadUpdateStrategy,
  type WebDavCapabilities,
} from "./webdav";
import { ContentAddressedRepository, HEAD_LOCK_PATH } from "./repository";
import { ObsidianWorkspace } from "./vault";

interface PendingConflict {
  path: string;
  action: string;
  canResolve: boolean;
  choice?: ConflictChoice;
  baseBlob: string | null;
  localBlob: string | null;
  remoteBlob: string | null;
  versions?: { base: string; local: string; remote: string };
}

export default class WebDavSyncPlugin extends Plugin implements SettingsController, SyncCenterController, ConflictResolverController {
  declare settings: WebDavSyncSettings;

  private readonly changes = new ChangeQueue();
  private readonly log = new BoundedMemoryLog({ maxEntries: 500, maxBytes: 512 * 1_024 });
  private readonly state = new SyncStateMachine("unconfigured");
  private readonly scheduler = new SingleFlightSyncScheduler((triggers) => this.runOneSync(triggers));
  private ribbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private fileChangeTimer: number | null = null;
  private fileChangeBurstStartedAt: number | null = null;
  private lastRemotePollAt = 0;
  private capabilities: WebDavCapabilities | null = null;
  private capabilityConfigKey: string | null = null;
  private configRevision = 0;
  private disposed = false;
  private syncSession!: SyncSessionState;
  private lastConflicts: PendingConflict[] = [];
  private readonly conflictResolutions = Object.create(null) as Record<string, ConflictResolution>;
  private readonly remoteMutationPaths = new Set<string>();
  private syncHistory: SyncHistoryEntry[] = [];
  private currentProgress: SyncProgress | null = null;

  async onload(): Promise<void> {
    const storedData: unknown = await this.loadData();
    this.settings = normalizeSettings(storedData);
    this.syncSession = loadSyncSession(storedData);
    this.syncHistory = loadSyncHistory(storedData);
    this.lastRemotePollAt = Date.now();
    await this.persistData();
    this.refreshConfiguredState();

    this.register(this.state.subscribe(() => this.updateStatusSurfaces()));
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "立即运行 WebDAV 同步", () => {
      void this.runManualSync()
        .then(() => new Notice("WebDAV 同步完成。"))
        .catch((error: unknown) => new Notice(`WebDAV 同步失败：${formatError(error)}`, 10_000));
    });

    if (Platform.isDesktop) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addEventListener("click", () => this.openStatusTarget());
    }

    this.addCommand({
      id: "sync-now",
      name: "立即运行同步",
      callback: () => void this.runManualSync().catch((error: unknown) => {
        new Notice(`WebDAV 同步失败：${formatError(error)}`, 10_000);
      }),
    });
    this.addCommand({
      id: "open-sync-center",
      name: "打开同步中心",
      callback: () => this.openSyncCenter(),
    });
    this.addCommand({
      id: "resolve-conflicts",
      name: "处理同步冲突",
      callback: () => this.openConflictResolver(),
    });
    this.addCommand({
      id: "rescan-vault",
      name: "重新扫描知识库并打开同步中心",
      callback: () => {
        this.rescanVault();
        this.openSyncCenter();
      },
    });

    this.addSettingTab(new WebDavSyncSettingTab(this.app, this));
    this.register(() => {
      this.disposed = true;
      this.cancelFileChangeSync();
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (
        !document.hidden &&
        this.settings.autoSync &&
        this.state.current !== "conflict" &&
        this.isConfigured()
      ) {
        void this.scheduler.request("resume").catch((error: unknown) => {
          this.log.warn("恢复到前台后的同步检查失败。", error);
        });
      }
    });

    this.registerInterval(window.setInterval(() => this.handlePollTick(), 60_000));
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      if (this.settings.autoSync && this.settings.syncOnStartup && this.isConfigured()) {
        void this.scheduler.request("startup").catch((error: unknown) => {
          this.log.warn("启动时同步检查失败。", error);
        });
      }
    });

    this.updateStatusSurfaces();
    this.log.info("WebDAV 同步插件已加载，当前默认为仅规划安全模式。");
  }

  getPassword(): string | null {
    return this.app.secretStorage.getSecret(PASSWORD_SECRET_ID);
  }

  async savePassword(password: string): Promise<void> {
    this.app.secretStorage.setSecret(PASSWORD_SECRET_ID, password);
    this.connectionConfigurationChanged();
    this.refreshConfiguredState();
  }

  async clearPassword(): Promise<void> {
    this.app.secretStorage.setSecret(PASSWORD_SECRET_ID, "");
    this.connectionConfigurationChanged();
    this.refreshConfiguredState();
  }

  async updateSettings(patch: Partial<WebDavSyncSettings>): Promise<void> {
    const connectionChanged = patch.serverUrl !== undefined ||
      patch.remoteRoot !== undefined ||
      patch.username !== undefined;
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.configRevision += 1;
    if (connectionChanged) this.invalidateCapabilities();
    if (!this.settings.autoSync) this.cancelFileChangeSync();
    if (patch.remotePollMinutes !== undefined) this.lastRemotePollAt = Date.now();
    await this.persistData();
    this.refreshConfiguredState();
  }

  async resetSyncState(): Promise<void> {
    const { pendingApply: _pendingApply, ...stableSession } = this.syncSession;
    this.syncSession = {
      ...stableSession,
      baseCommitId: null,
      repositoryId: null,
    };
    this.lastConflicts = [];
    for (const path of Object.keys(this.conflictResolutions)) delete this.conflictResolutions[path];
    await this.persistData();
    this.refreshConfiguredState();
  }

  async clearRemoteLock(): Promise<void> {
    if (!["idle", "error", "conflict", "offline"].includes(this.state.current)) {
      throw new Error("请等待当前同步任务停止后再清除远程锁。");
    }
    const settings = { ...this.settings };
    const password = this.getPassword();
    const client = this.createWebDavClient(settings, password);
    const response = await client.remove(HEAD_LOCK_PATH);
    if (![200, 204, 404].includes(response.status)) {
      throw new Error(`清除远程同步锁时，WebDAV 返回了 HTTP ${response.status}。`);
    }
  }

  async testConnection(): Promise<string> {
    const revision = this.configRevision;
    const settings = { ...this.settings };
    const password = this.getPassword();
    const client = this.createWebDavClient(settings, password);
    const result = await client.probeCapabilities();
    this.assertRunConfiguration(revision);
    this.capabilities = result.capabilities;
    this.updateStatusSurfaces();
    if (!result.ok) {
      this.capabilityConfigKey = null;
      throw new Error(result.error?.message ?? "WebDAV 能力检测发生未知错误。");
    }
    this.capabilityConfigKey = connectionConfigKey(settings);
    return result.capabilities.safeConcurrentWrites
      ? `连接成功。HEAD 更新策略：${describeHeadUpdateStrategy(result.capabilities.headUpdateStrategy)}。`
      : "连接成功，但尚未证明并发写入安全。请查看同步中心中的警告。";
  }

  getSnapshot(): SyncCenterSnapshot {
    return {
      state: this.state.current,
      pending: this.changes.snapshot(),
      logs: this.log.snapshot(),
      capabilities: this.capabilities,
      realSyncEnabled: this.settings.enableRealSync,
      pendingApply: this.syncSession.pendingApply
        ? {
            targetCommitId: this.syncSession.pendingApply.targetCommitId,
            operationId: this.syncSession.pendingApply.operationId,
          }
        : null,
      conflicts: this.lastConflicts.map(({ path, action, canResolve, choice, versions }) => ({
        path,
        action,
        canResolve,
        ...(choice ? { choice } : {}),
        ...(versions ? { versions: { ...versions } } : {}),
      })),
      history: this.syncHistory.map((entry) => ({ ...entry, triggers: [...entry.triggers] })),
    };
  }

  runManualSync(): Promise<void> {
    return this.scheduler.request("manual");
  }

  chooseConflict(path: string, choice: ConflictChoice): void {
    const conflict = this.lastConflicts.find((item) => item.path === path && item.canResolve);
    if (!conflict) return;
    this.conflictResolutions[path] = {
      choice,
      baseBlob: conflict.baseBlob,
      localBlob: conflict.localBlob,
      remoteBlob: conflict.remoteBlob,
    };
    conflict.choice = choice;
  }

  openConflictResolver(): void {
    if (this.lastConflicts.length === 0) {
      new Notice("当前没有需要处理的同步冲突。");
      return;
    }
    new ConflictResolverModal(this.app, this).open();
  }

  async copyDiagnostics(): Promise<void> {
    const conflicts = await sanitizeDiagnosticConflicts(this.getSnapshot().conflicts);
    const diagnostics = {
      pluginVersion: this.manifest.version,
      state: this.state.current,
      configured: this.isConfigured(),
      realSyncEnabled: this.settings.enableRealSync,
      repositoryId: this.syncSession.repositoryId,
      baseCommitId: this.syncSession.baseCommitId,
      pendingApply: this.syncSession.pendingApply
        ? {
            targetCommitId: this.syncSession.pendingApply.targetCommitId,
            operationId: this.syncSession.pendingApply.operationId,
          }
        : null,
      capabilities: this.capabilities,
      conflicts,
      history: this.syncHistory,
      logs: this.log.snapshot(),
    };
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && this.shouldTrack(file.path) && !this.isRemoteMutation(file.path)) {
        this.changes.enqueue({ kind: "create", path: file.path, detectedAt: Date.now() });
        this.scheduleFileChangeSync();
      }
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && this.shouldTrack(file.path) && !this.isRemoteMutation(file.path)) {
        this.changes.enqueue({ kind: "modify", path: file.path, detectedAt: Date.now() });
        this.scheduleFileChangeSync();
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && this.shouldTrack(file.path) && !this.isRemoteMutation(file.path)) {
        this.changes.enqueue({ kind: "delete", path: file.path, detectedAt: Date.now() });
        this.scheduleFileChangeSync();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (
        file instanceof TFile &&
        !this.isRemoteMutation(file.path) &&
        !this.isRemoteMutation(oldPath) &&
        (this.shouldTrack(file.path) || this.shouldTrack(oldPath))
      ) {
        this.changes.enqueue({
          kind: "rename",
          previousPath: oldPath,
          path: file.path,
          detectedAt: Date.now(),
        });
        this.scheduleFileChangeSync();
      }
    }));
  }

  private scheduleFileChangeSync(): void {
    if (!this.settings.autoSync || this.state.current === "conflict" || !this.isConfigured()) return;
    const now = Date.now();
    this.fileChangeBurstStartedAt ??= now;
    const maxWaitMs = Math.max(this.settings.fileChangeDelayMs, 60_000);
    const remainingMaxWait = Math.max(0, maxWaitMs - (now - this.fileChangeBurstStartedAt));
    const delayMs = Math.min(this.settings.fileChangeDelayMs, remainingMaxWait);
    this.clearFileChangeTimer();
    this.fileChangeTimer = window.setTimeout(() => {
      this.fileChangeTimer = null;
      this.fileChangeBurstStartedAt = null;
      void this.scheduler.request("file-change").catch((error: unknown) => {
        this.log.warn("文件变更触发的同步检查失败。", error);
      });
    }, delayMs);
    this.updateStatusSurfaces();
  }

  private clearFileChangeTimer(): void {
    if (this.fileChangeTimer !== null) {
      window.clearTimeout(this.fileChangeTimer);
      this.fileChangeTimer = null;
    }
  }

  private cancelFileChangeSync(): void {
    this.clearFileChangeTimer();
    this.fileChangeBurstStartedAt = null;
  }

  private handlePollTick(): void {
    if (!this.settings.autoSync || this.state.current === "conflict" || !this.isConfigured()) return;
    const intervalMs = this.settings.remotePollMinutes * 60_000;
    if (Date.now() - this.lastRemotePollAt < intervalMs) return;
    this.lastRemotePollAt = Date.now();
    void this.scheduler.request("interval").catch((error: unknown) => {
      this.log.warn("定时同步检查失败。", error);
    });
  }

  private async runOneSync(triggers: readonly SyncTrigger[]): Promise<void> {
    if (!this.isConfigured()) {
      this.refreshConfiguredState();
      this.log.warn("由于尚未配置 WebDAV，本次同步已跳过。");
      throw new Error("请先配置 WebDAV 服务器、远程目录、用户名和密码。");
    }

    const startedAt = Date.now();
    const revision = this.configRevision;
    const runSettings = { ...this.settings };
    const runPassword = this.getPassword();
    let historyRecorded = false;
    let pendingCount = this.changes.size;

    try {
      this.moveToIdleIfRecoverable();
      this.state.transitionTo("scanning");
      this.setSyncProgress({ phase: "scanning", completed: 0, total: 1, message: "读取待同步队列" });
      const pending = this.changes.snapshot();
      pendingCount = pending.length;
      this.setSyncProgress({ phase: "scanning", completed: 1, total: 1, message: "读取待同步队列" });
      this.log.info("同步检查已开始。", { triggers, pendingChanges: pending.length });

      this.state.transitionTo("checking-remote");
      this.setSyncProgress({ phase: "initializing", completed: 0, total: 3, message: "准备远程连接" });
      this.lastRemotePollAt = Date.now();
      const client = this.createWebDavClient(runSettings, runPassword);
      this.setSyncProgress({ phase: "initializing", completed: 1, total: 3, message: "准备远程连接" });
      const capabilityKey = connectionConfigKey(runSettings);
      const cachedCapabilities = this.capabilityConfigKey === capabilityKey
        ? this.capabilities
        : null;
      if (cachedCapabilities) {
        this.setSyncProgress({ phase: "initializing", completed: 2, total: 3, message: "确认远程目录" });
        await client.ensureRemoteRoot();
      } else {
        this.setSyncProgress({ phase: "initializing", completed: 2, total: 3, message: "检测远程能力" });
      }
      const result: CapabilityProbeResult =
        cachedCapabilities
          ? { ok: true, capabilities: cachedCapabilities }
          : await client.probeCapabilities();
      this.setSyncProgress({ phase: "initializing", completed: 3, total: 3, message: "检测远程能力" });
      this.assertRunConfiguration(revision);
      this.capabilities = result.capabilities;
      if (!result.ok) {
        this.capabilityConfigKey = null;
        throw new Error(result.error?.message ?? "WebDAV 能力检测失败。");
      }
      this.capabilityConfigKey = capabilityKey;

      this.state.transitionTo("planning");
      this.setSyncProgress({ phase: "planning", completed: 0, total: 1, message: "规划同步" });
      if (!runSettings.enableRealSync) {
        this.setSyncProgress({ phase: "planning", completed: 1, total: 1, message: "规划同步" });
        this.log.info("仅规划模式的同步检查已完成。", {
          pendingChanges: pending.length,
          safeConcurrentWrites: result.capabilities.safeConcurrentWrites,
          warnings: result.capabilities.warnings,
        });
        this.addHistory(triggers, "planned", startedAt, pendingCount, "仅规划模式检查完成。");
        historyRecorded = true;
        await this.persistData();
        this.clearSyncProgress();
        this.state.transitionTo("idle");
        return;
      }

      const headUpdateStrategy = result.capabilities.headUpdateStrategy;
      if (!result.capabilities.safeConcurrentWrites || !headUpdateStrategy) {
        throw new Error(
          "真实同步需要安全的条件创建能力，以及经过验证的 HEAD 更新策略。",
        );
      }

      const syncResult = await this.runRepositorySync(
        client,
        headUpdateStrategy,
        result.capabilities.conditionalCreate,
        runSettings,
        revision,
      );
      this.assertRunConfiguration(revision);
      if (syncResult.status === "retry") {
        throw new Error("远程 HEAD 连续发生变化，请重新运行同步。");
      }
      if (syncResult.status === "conflict") {
        this.captureConflicts(syncResult);
        this.log.warn("同步需要处理冲突。", {
          reason: syncResult.reason,
          plan: syncResult.plan?.map(({ path, action }) => ({ path, action })),
          markdownConflictPaths: Object.keys(syncResult.markdownConflicts ?? {}),
        });
        this.addHistory(
          triggers,
          "conflict",
          startedAt,
          pendingCount,
          `同步冲突：${describeConflictReason(syncResult.reason)}。`,
        );
        historyRecorded = true;
        await this.persistData();
        this.state.transitionTo("conflict");
        throw new Error(`同步冲突：${describeConflictReason(syncResult.reason)}。`);
      }

      this.syncSession = syncResult.state;
      this.lastConflicts = [];
      for (const path of Object.keys(this.conflictResolutions)) delete this.conflictResolutions[path];
      this.addHistory(
        triggers,
        syncResult.status,
        startedAt,
        pendingCount,
        `仓库同步完成：${describeSyncResultStatus(syncResult.status)}。`,
        "commitId" in syncResult ? syncResult.commitId : undefined,
      );
      historyRecorded = true;
      await this.persistData();
      this.changes.acknowledge(pending);
      this.log.info("仓库同步已完成。", {
        result: syncResult.status,
        baseCommitId: syncResult.state.baseCommitId,
      });
      this.clearSyncProgress();
      this.state.transitionTo("idle");
    } catch (error) {
      this.clearSyncProgress();
      if (this.state.current !== "conflict" && this.state.canTransitionTo("error")) {
        this.state.transitionTo("error");
      }
      this.log.error("同步检查失败。", error);
      if (!historyRecorded) {
        this.addHistory(
          triggers,
          "error",
          startedAt,
          pendingCount,
          redactLogText(formatError(error)),
        );
        try {
          await this.persistData();
        } catch (persistError) {
          this.log.error("无法保存同步历史。", persistError);
        }
      }
      throw error;
    }
  }

  private async runRepositorySync(
    client: WebDavClient,
    headUpdateStrategy: Exclude<HeadUpdateStrategy, null>,
    conditionalCreate: boolean,
    settings: WebDavSyncSettings,
    revision: number,
  ): Promise<RepositorySyncResult> {
    const transferConcurrency = Platform.isMobile
      ? Math.min(settings.transferConcurrency, 2)
      : settings.transferConcurrency;
    const maxInFlightBytes = Platform.isMobile
      ? 32 * 1_024 * 1_024
      : 256 * 1_024 * 1_024;
    const repository = new ContentAddressedRepository(client, {
      headUpdateStrategy,
      conditionalCreate,
    });
    const workspace = new ObsidianWorkspace(
      this.app.vault,
      this.app.fileManager,
      (path) => this.shouldTrack(path),
      transferConcurrency,
      (path, active) => {
        if (active) this.remoteMutationPaths.add(path);
        else window.setTimeout(() => this.remoteMutationPaths.delete(path), 0);
      },
      maxInFlightBytes,
    );
    const engine = new RepositorySyncEngine(repository, workspace, {
      concurrency: transferConcurrency,
      initialSyncPolicy: settings.initialSyncPolicy,
      assertSafePoint: () => this.assertRunConfiguration(revision),
      maxInFlightBytes,
      reportProgress: (progress) => this.setSyncProgress(progress),
      persistSessionState: async (state) => {
        this.syncSession = state;
        await this.persistData();
      },
    });

    let result: RepositorySyncResult = { status: "retry", state: this.syncSession };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await engine.sync(this.syncSession, this.conflictResolutions);
      if (result.status !== "retry") return result;
      this.log.warn("提交期间远程 HEAD 已变化，正在重新规划。", { attempt: attempt + 1 });
    }
    return result;
  }

  private captureConflicts(result: Extract<RepositorySyncResult, { status: "conflict" }>): void {
    const markdownPaths = new Set(Object.keys(result.markdownConflicts ?? {}));
    const resolvable = (result.plan ?? []).filter(({ path, action }) =>
      action === "conflict-add-add" ||
      action === "conflict-delete-modify" ||
      markdownPaths.has(path),
    );

    if (resolvable.length === 0) {
      this.lastConflicts = [{
        path: "repository",
        action: result.reason,
        canResolve: false,
        baseBlob: null,
        localBlob: null,
        remoteBlob: null,
      }];
      return;
    }

    this.lastConflicts = resolvable.map((item) => {
      const versions = result.markdownConflictVersions?.[item.path];
      const identity = {
        baseBlob: item.base?.blob ?? null,
        localBlob: item.local?.blob ?? null,
        remoteBlob: item.remote?.blob ?? null,
      };
      const existing = this.conflictResolutions[item.path];
      const choice = existing &&
        existing.baseBlob === identity.baseBlob &&
        existing.localBlob === identity.localBlob &&
        existing.remoteBlob === identity.remoteBlob
        ? existing.choice
        : undefined;
      if (!choice) delete this.conflictResolutions[item.path];
      return {
        path: item.path,
        action: markdownPaths.has(item.path) ? "markdown-overlap" : item.action,
        canResolve: true,
        ...(choice ? { choice } : {}),
        ...(markdownPaths.has(item.path) && versions
          ? { versions: { ...versions } }
          : {}),
        ...identity,
      };
    });
  }

  private addHistory(
    triggers: readonly SyncTrigger[],
    outcome: SyncHistoryOutcome,
    startedAt: number,
    pendingChanges: number,
    message: string,
    commitId?: string,
  ): void {
    this.syncHistory = appendSyncHistory(this.syncHistory, {
      id: crypto.randomUUID(),
      startedAt,
      finishedAt: Date.now(),
      triggers: [...triggers],
      outcome,
      pendingChanges,
      ...(commitId ? { commitId } : {}),
      message,
    });
  }

  private createWebDavClient(
    settings: WebDavSyncSettings,
    password: string | null,
  ): WebDavClient {
    if (!password || !hasConnectionSettings(settings, password)) {
      throw new Error("WebDAV 连接设置不完整。");
    }
    return new WebDavClient(
      {
        serverUrl: settings.serverUrl,
        remoteRoot: settings.remoteRoot,
        credentials: { username: settings.username, password },
      },
      new ObsidianWebDavTransport(),
    );
  }

  private persistData(): Promise<void> {
    return this.saveData(serializePluginData(this.settings, this.syncSession, this.syncHistory));
  }

  private connectionConfigurationChanged(): void {
    this.configRevision += 1;
    this.invalidateCapabilities();
  }

  private invalidateCapabilities(): void {
    this.capabilities = null;
    this.capabilityConfigKey = null;
  }

  private assertRunConfiguration(revision: number): void {
    if (this.disposed) throw new Error("同步过程中 WebDAV 同步插件已被卸载。");
    if (revision !== this.configRevision) {
      throw new Error("同步过程中 WebDAV 设置已改变，请使用新配置重新同步。");
    }
  }

  private rescanVault(): void {
    this.changes.clear();
    const detectedAt = Date.now();
    for (const file of this.app.vault.getFiles()) {
      if (this.shouldTrack(file.path)) {
        this.changes.enqueue({ kind: "modify", path: file.path, detectedAt });
      }
    }
    this.log.info("知识库重新扫描完成，文件已加入检查队列。", { count: this.changes.size });
    this.updateStatusSurfaces();
  }

  private shouldTrack(path: string): boolean {
    const configDir = `${this.app.vault.configDir}/`;
    return !(
      path.startsWith(".trash/") ||
      path.startsWith(".git/") ||
      path.startsWith(configDir) ||
      isPathInExcludedFolders(path, this.settings.excludedFolders)
    );
  }

  private isRemoteMutation(path: string): boolean {
    return this.remoteMutationPaths.has(path);
  }

  private isConfigured(): boolean {
    return hasConnectionSettings(this.settings, this.getPassword());
  }

  private refreshConfiguredState(): void {
    const target: SyncState = this.isConfigured() ? "idle" : "unconfigured";
    if (this.state.current !== target && this.state.canTransitionTo(target)) {
      this.state.transitionTo(target);
    }
    this.updateStatusSurfaces();
  }

  private moveToIdleIfRecoverable(): void {
    if (this.state.current !== "idle" && this.state.canTransitionTo("idle")) {
      this.state.transitionTo("idle");
    }
  }

  private openSyncCenter(): void {
    new SyncCenterModal(this.app, this).open();
  }

  private openStatusTarget(): void {
    if (this.state.current === "conflict") this.openConflictResolver();
    else this.openSyncCenter();
  }

  private setSyncProgress(progress: SyncProgress): void {
    this.currentProgress = progress;
    const target = syncStateForProgress(progress);
    if (this.state.current !== target && this.state.canTransitionTo(target)) {
      this.state.transitionTo(target);
    }
    this.updateStatusSurfaces();
  }

  private clearSyncProgress(): void {
    this.currentProgress = null;
    this.updateStatusSurfaces();
  }

  private updateStatusSurfaces(): void {
    const status = describeState(this.state.current, this.changes.size, this.currentProgress);
    if (this.ribbonEl) {
      this.ribbonEl.setAttribute("aria-label", status.text);
    }
    this.statusBarEl?.setText(status.text);
  }
}

function describeState(
  state: SyncState,
  pendingCount: number,
  progress: SyncProgress | null = null,
): { icon: string; text: string } {
  if (state === "unconfigured") return { icon: "settings", text: "WebDAV：需要配置" };
  if (state === "error") return { icon: "triangle-alert", text: "WebDAV：同步失败" };
  if (state === "offline") return { icon: "cloud-off", text: "WebDAV：离线" };
  if (state === "conflict") return { icon: "git-merge", text: "WebDAV：存在冲突" };
  if (state === "paused") return { icon: "pause", text: "WebDAV：已暂停" };
  if (state !== "idle") {
    const label = progress?.message ?? describeSyncState(state);
    const suffix = progress ? ` ${formatProgressPercent(progress)}%` : "";
    return { icon: "refresh-cw", text: `WebDAV：${label}${suffix}` };
  }
  if (pendingCount > 0) return { icon: "cloud-upload", text: `WebDAV：${pendingCount} 项待同步` };
  return { icon: "cloud-check", text: "WebDAV：已就绪" };
}

function syncStateForProgress(progress: SyncProgress): SyncState {
  if (progress.phase === "initializing") return "checking-remote";
  return progress.phase;
}

function formatProgressPercent(progress: SyncProgress): number {
  const total = Math.max(1, progress.total);
  const completed = Math.min(Math.max(0, progress.completed), total);
  return Math.round((completed / total) * 100);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeHeadUpdateStrategy(strategy: HeadUpdateStrategy): string {
  if (strategy === "etag") return "强 ETag 比较并交换";
  if (strategy === "move-lock") return "原子 MOVE 租约锁";
  if (strategy === "mkcol-lock") return "排他 MKCOL 租约锁";
  return "无可用策略";
}

function describeSyncState(state: SyncState): string {
  const labels: Record<SyncState, string> = {
    unconfigured: "需要配置",
    idle: "空闲",
    scanning: "正在扫描知识库",
    "checking-remote": "正在检查远程仓库",
    planning: "正在规划同步",
    uploading: "正在上传",
    downloading: "正在下载",
    merging: "正在合并",
    applying: "正在应用远程更改",
    "updating-head": "正在更新远程 HEAD",
    paused: "已暂停",
    offline: "离线",
    conflict: "存在冲突",
    error: "发生错误",
  };
  return labels[state];
}

function describeSyncResultStatus(status: RepositorySyncResult["status"]): string {
  const labels: Record<RepositorySyncResult["status"], string> = {
    "up-to-date": "已经是最新状态",
    pushed: "已推送本地更改",
    pulled: "已拉取远程更改",
    merged: "已完成合并",
    retry: "需要重试",
    conflict: "存在冲突",
  };
  return labels[status];
}

function describeConflictReason(
  reason: Extract<RepositorySyncResult, { status: "conflict" }>["reason"],
): string {
  const labels: Record<
    Extract<RepositorySyncResult, { status: "conflict" }>["reason"],
    string
  > = {
    "initial-both-nonempty": "首次连接时本地和远程都包含不同内容",
    "remote-reset": "远程仓库历史已被重置",
    "repository-mismatch": "当前设备绑定了另一个远程仓库",
    "history-diverged": "本地基线与远程历史已经分叉",
    "pending-apply-local-change": "中断恢复期间检测到新的本地编辑",
    "mass-delete": "本次操作包含大量删除",
    "tree-conflict": "文件树存在无法自动处理的冲突",
  };
  return labels[reason];
}

function connectionConfigKey(settings: WebDavSyncSettings): string {
  return JSON.stringify([
    settings.serverUrl,
    settings.remoteRoot,
    settings.username,
  ]);
}
