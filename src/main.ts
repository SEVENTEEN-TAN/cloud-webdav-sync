import { moment, Notice, Platform, Plugin, TFile } from "obsidian";
import { SyncStateMachine, type SyncState } from "./core";
import { resolveLanguage, setLanguage, t, type MessageKey } from "./i18n";
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
  decideHeadReplanRetry,
  type ConflictChoice,
  type ConflictResolution,
  type ForceSyncDirection,
  type RepositorySyncResult,
  type SyncProgress,
  type SyncSessionState,
  type SyncTrigger,
} from "./sync";
import { SyncCenterModal, type SyncCenterController, type SyncCenterSnapshot } from "./ui/sync-center-modal";
import { ConflictResolverModal, type ConflictResolverController } from "./ui/conflict-resolver-modal";
import {
  ObsidianWebDavTransport,
  RetryingWebDavTransport,
  WebDavClient,
  type CapabilityProbeResult,
  type HeadUpdateStrategy,
  type WebDavCapabilities,
} from "./webdav";
import { ContentAddressedRepository, HEAD_LOCK_PATH, type CommitHistoryEntry } from "./repository";
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
    this.applyLanguage();
    this.syncSession = loadSyncSession(storedData);
    this.syncHistory = loadSyncHistory(storedData);
    this.lastRemotePollAt = Date.now();
    await this.persistData();
    this.refreshConfiguredState();

    this.register(this.state.subscribe(() => this.updateStatusSurfaces()));
    this.ribbonEl = this.addRibbonIcon("refresh-cw", t("plugin.ribbonTooltip"), () => {
      void this.runManualSync()
        .then(() => new Notice(t("plugin.notice.syncDone")))
        .catch((error: unknown) => new Notice(t("plugin.notice.syncFailed", { error: formatError(error) }), 10_000));
    });

    if (Platform.isDesktop) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addEventListener("click", () => this.openStatusTarget());
    }

    this.addCommand({
      id: "sync-now",
      name: t("plugin.command.syncNow"),
      callback: () => void this.runManualSync().catch((error: unknown) => {
        new Notice(t("plugin.notice.syncFailed", { error: formatError(error) }), 10_000);
      }),
    });
    this.addCommand({
      id: "open-sync-center",
      name: t("plugin.command.openSyncCenter"),
      callback: () => this.openSyncCenter(),
    });
    this.addCommand({
      id: "resolve-conflicts",
      name: t("plugin.command.resolveConflicts"),
      callback: () => this.openConflictResolver(),
    });
    this.addCommand({
      id: "rescan-vault",
      name: t("plugin.command.rescan"),
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
          this.log.warn(t("plugin.log.resumeFailed"), error);
        });
      }
    });

    this.registerInterval(window.setInterval(() => this.handlePollTick(), 60_000));
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      if (this.settings.autoSync && this.settings.syncOnStartup && this.isConfigured()) {
        void this.scheduler.request("startup").catch((error: unknown) => {
          this.log.warn(t("plugin.log.startupFailed"), error);
        });
      }
    });

    this.updateStatusSurfaces();
    this.log.info(t("plugin.log.loaded"));
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
    if (patch.language !== undefined) this.applyLanguage();
    if (connectionChanged) this.invalidateCapabilities();
    if (!this.settings.autoSync) this.cancelFileChangeSync();
    if (patch.remotePollMinutes !== undefined) this.lastRemotePollAt = Date.now();
    await this.persistData();
    this.refreshConfiguredState();
  }

  private applyLanguage(): void {
    setLanguage(resolveLanguage(this.settings.language, moment.locale()));
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
      throw new Error(t("plugin.error.clearLockBusy"));
    }
    const settings = { ...this.settings };
    const password = this.getPassword();
    const client = this.createWebDavClient(settings, password);
    const response = await client.remove(HEAD_LOCK_PATH);
    if (![200, 204, 404].includes(response.status)) {
      throw new Error(t("plugin.error.clearLockStatus", { status: response.status }));
    }
  }

  async clearHistoryAndLogs(): Promise<void> {
    if (!["idle", "error", "conflict", "offline"].includes(this.state.current)) {
      throw new Error(t("plugin.error.clearHistoryBusy"));
    }
    this.syncHistory = [];
    this.log.clear();
    await this.persistData();
    this.log.info(t("plugin.log.historyCleared"));
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
      throw new Error(result.error?.message ?? t("plugin.testConnection.unknownError"));
    }
    this.capabilityConfigKey = connectionConfigKey(settings);
    return result.capabilities.safeConcurrentWrites
      ? t("plugin.testConnection.success", {
          strategy: describeHeadUpdateStrategy(result.capabilities.headUpdateStrategy),
        })
      : t("plugin.testConnection.unsafe");
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
      new Notice(t("plugin.notice.noConflicts"));
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
        this.log.warn(t("plugin.log.fileChangeFailed"), error);
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
      this.log.warn(t("plugin.log.intervalFailed"), error);
    });
  }

  private async runOneSync(triggers: readonly SyncTrigger[]): Promise<void> {
    if (!this.isConfigured()) {
      this.refreshConfiguredState();
      this.log.warn(t("plugin.log.skippedUnconfigured"));
      throw new Error(t("plugin.error.configureFirst"));
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
      this.setSyncProgress({ phase: "scanning", completed: 0, total: 1, message: t("plugin.progress.queue") });
      const pending = this.changes.snapshot();
      pendingCount = pending.length;
      this.setSyncProgress({ phase: "scanning", completed: 1, total: 1, message: t("plugin.progress.queue") });
      this.log.info(t("plugin.log.syncStarted"), { triggers, pendingChanges: pending.length });

      this.state.transitionTo("checking-remote");
      this.setSyncProgress({ phase: "initializing", completed: 0, total: 3, message: t("plugin.progress.connecting") });
      this.lastRemotePollAt = Date.now();
      const client = this.createWebDavClient(runSettings, runPassword);
      this.setSyncProgress({ phase: "initializing", completed: 1, total: 3, message: t("plugin.progress.connecting") });
      const capabilityKey = connectionConfigKey(runSettings);
      const cachedCapabilities = this.capabilityConfigKey === capabilityKey
        ? this.capabilities
        : null;
      if (cachedCapabilities) {
        this.setSyncProgress({ phase: "initializing", completed: 2, total: 3, message: t("plugin.progress.confirmRoot") });
        await client.ensureRemoteRoot();
      } else {
        this.setSyncProgress({ phase: "initializing", completed: 2, total: 3, message: t("plugin.progress.probing") });
      }
      const result: CapabilityProbeResult =
        cachedCapabilities
          ? { ok: true, capabilities: cachedCapabilities }
          : await client.probeCapabilities();
      this.setSyncProgress({ phase: "initializing", completed: 3, total: 3, message: t("plugin.progress.probing") });
      this.assertRunConfiguration(revision);
      this.capabilities = result.capabilities;
      if (!result.ok) {
        this.capabilityConfigKey = null;
        throw new Error(result.error?.message ?? t("plugin.error.probeFailed"));
      }
      this.capabilityConfigKey = capabilityKey;

      this.state.transitionTo("planning");
      this.setSyncProgress({ phase: "planning", completed: 0, total: 1, message: t("plugin.progress.planning") });
      if (!runSettings.enableRealSync) {
        this.setSyncProgress({ phase: "planning", completed: 1, total: 1, message: t("plugin.progress.planning") });
        this.log.info(t("plugin.log.planningDone"), {
          pendingChanges: pending.length,
          safeConcurrentWrites: result.capabilities.safeConcurrentWrites,
          warnings: result.capabilities.warnings,
        });
        this.addHistory(triggers, "planned", startedAt, pendingCount, t("plugin.history.planned"));
        historyRecorded = true;
        await this.persistData();
        this.clearSyncProgress();
        this.state.transitionTo("idle");
        return;
      }

      const headUpdateStrategy = result.capabilities.headUpdateStrategy;
      if (!result.capabilities.safeConcurrentWrites || !headUpdateStrategy) {
        throw new Error(t("plugin.error.realSyncRequirements"));
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
        throw new Error(t("plugin.error.headChurn"));
      }
      if (syncResult.status === "conflict") {
        this.captureConflicts(syncResult);
        this.log.warn(t("plugin.log.conflictNeedsAttention"), {
          reason: syncResult.reason,
          plan: syncResult.plan?.map(({ path, action }) => ({ path, action })),
          markdownConflictPaths: Object.keys(syncResult.markdownConflicts ?? {}),
        });
        this.addHistory(
          triggers,
          "conflict",
          startedAt,
          pendingCount,
          t("plugin.history.conflict", { reason: describeConflictReason(syncResult.reason) }),
        );
        historyRecorded = true;
        await this.persistData();
        this.state.transitionTo("conflict");
        throw new Error(t("plugin.error.conflict", { reason: describeConflictReason(syncResult.reason) }));
      }

      this.syncSession = syncResult.state;
      this.lastConflicts = [];
      for (const path of Object.keys(this.conflictResolutions)) delete this.conflictResolutions[path];
      this.addHistory(
        triggers,
        syncResult.status,
        startedAt,
        pendingCount,
        t("plugin.history.completed", { status: describeSyncResultStatus(syncResult.status) }),
        "commitId" in syncResult ? syncResult.commitId : undefined,
      );
      historyRecorded = true;
      await this.persistData();
      this.changes.acknowledge(pending);
      this.log.info(t("plugin.log.syncCompleted"), {
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
      this.log.error(t("plugin.log.syncFailed"), error);
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
          this.log.error(t("plugin.log.historyPersistFailed"), persistError);
        }
      }
      throw error;
    }
  }

  private buildRepositoryEngine(
    client: WebDavClient,
    headUpdateStrategy: Exclude<HeadUpdateStrategy, null>,
    conditionalCreate: boolean,
    settings: WebDavSyncSettings,
    revision: number,
  ): RepositorySyncEngine {
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
    return new RepositorySyncEngine(repository, workspace, {
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
  }

  private async runRepositorySync(
    client: WebDavClient,
    headUpdateStrategy: Exclude<HeadUpdateStrategy, null>,
    conditionalCreate: boolean,
    settings: WebDavSyncSettings,
    revision: number,
  ): Promise<RepositorySyncResult> {
    const engine = this.buildRepositoryEngine(client, headUpdateStrategy, conditionalCreate, settings, revision);

    let result: RepositorySyncResult = { status: "retry", state: this.syncSession };
    for (let attempt = 0; ; attempt += 1) {
      result = await engine.sync(this.syncSession, this.conflictResolutions);
      if (result.status !== "retry") return result;
      const retry = decideHeadReplanRetry(attempt, settings.headUpdateMaxRetries);
      if (!retry.shouldRetry) return result;
      this.log.warn(t("plugin.log.replan"), {
        retry: retry.retryNumber,
        maxRetries: retry.maxRetries,
        retryDelayMs: settings.headUpdateRetryDelayMs,
      });
      if (settings.headUpdateRetryDelayMs > 0) {
        await sleep(settings.headUpdateRetryDelayMs);
      }
      this.assertRunConfiguration(revision);
    }
  }

  forcePushLocal(): Promise<void> {
    return this.scheduler.requestExclusive(() => this.runForcedSync("push-local"));
  }

  forcePullRemote(): Promise<void> {
    return this.scheduler.requestExclusive(() => this.runForcedSync("pull-remote"));
  }

  async fetchCommitHistory(): Promise<CommitHistoryEntry[]> {
    if (!this.isConfigured()) {
      throw new Error(t("plugin.error.configureFirst"));
    }
    const settings = { ...this.settings };
    const client = this.createWebDavClient(settings, this.getPassword());
    const repository = new ContentAddressedRepository(client);
    return repository.listCommitHistory();
  }

  private async runForcedSync(direction: ForceSyncDirection): Promise<void> {
    if (!this.settings.enableRealSync) {
      throw new Error(t("plugin.error.forceRequiresRealSync"));
    }
    if (!this.isConfigured()) {
      throw new Error(t("plugin.error.configureFirst"));
    }
    const startedAt = Date.now();
    const revision = this.configRevision;
    const runSettings = { ...this.settings };
    const runPassword = this.getPassword();
    try {
      this.moveToIdleIfRecoverable();
      this.state.transitionTo("scanning");
      this.setSyncProgress({ phase: "initializing", completed: 0, total: 3, message: t("plugin.progress.connecting") });
      const client = this.createWebDavClient(runSettings, runPassword);
      const capabilityKey = connectionConfigKey(runSettings);
      const cachedCapabilities = this.capabilityConfigKey === capabilityKey
        ? this.capabilities
        : null;
      if (cachedCapabilities) {
        this.setSyncProgress({ phase: "initializing", completed: 2, total: 3, message: t("plugin.progress.confirmRoot") });
        await client.ensureRemoteRoot();
      } else {
        this.setSyncProgress({ phase: "initializing", completed: 2, total: 3, message: t("plugin.progress.probing") });
      }
      const probe = cachedCapabilities
        ? { ok: true as const, capabilities: cachedCapabilities }
        : await client.probeCapabilities();
      this.setSyncProgress({ phase: "initializing", completed: 3, total: 3, message: t("plugin.progress.probing") });
      this.assertRunConfiguration(revision);
      this.capabilities = probe.capabilities;
      if (!probe.ok) {
        this.capabilityConfigKey = null;
        throw new Error(probe.error?.message ?? t("plugin.error.probeFailed"));
      }
      this.capabilityConfigKey = capabilityKey;
      const headUpdateStrategy = probe.capabilities.headUpdateStrategy;
      if (!probe.capabilities.safeConcurrentWrites || !headUpdateStrategy) {
        throw new Error(t("plugin.error.forceRequirements"));
      }
      const engine = this.buildRepositoryEngine(
        client,
        headUpdateStrategy,
        probe.capabilities.conditionalCreate,
        runSettings,
        revision,
      );
      this.state.transitionTo("planning");
      this.setSyncProgress({ phase: "planning", completed: 0, total: 1, message: t("plugin.progress.planning") });
      let result: RepositorySyncResult = { status: "retry", state: this.syncSession };
      for (let attempt = 0; ; attempt += 1) {
        result = await engine.forceSync(this.syncSession, direction);
        if (result.status !== "retry") break;
        const retry = decideHeadReplanRetry(attempt, runSettings.headUpdateMaxRetries);
        if (!retry.shouldRetry) break;
        this.log.warn(t("plugin.log.forceReplan"), {
          direction,
          retry: retry.retryNumber,
          maxRetries: retry.maxRetries,
          retryDelayMs: runSettings.headUpdateRetryDelayMs,
        });
        if (runSettings.headUpdateRetryDelayMs > 0) {
          await sleep(runSettings.headUpdateRetryDelayMs);
        }
        this.assertRunConfiguration(revision);
      }
      if (result.status === "retry") {
        throw new Error(t("plugin.error.forceChurn"));
      }
      if (result.status === "conflict") {
        throw new Error(t("plugin.error.forceConflict", { reason: describeConflictReason(result.reason) }));
      }
      this.syncSession = result.state;
      this.lastConflicts = [];
      for (const path of Object.keys(this.conflictResolutions)) delete this.conflictResolutions[path];
      this.changes.acknowledge(this.changes.snapshot());
      this.addHistory(
        ["manual"],
        result.status,
        startedAt,
        0,
        direction === "push-local" ? t("plugin.history.forcedPush") : t("plugin.history.forcedPull"),
        result.status === "up-to-date" ? undefined : result.commitId,
      );
      await this.persistData();
      this.log.info(t("plugin.log.forceCompleted"), {
        direction,
        ...(result.status === "up-to-date" ? {} : { commitId: result.commitId }),
      });
      this.clearSyncProgress();
      this.state.transitionTo("idle");
    } catch (error) {
      this.clearSyncProgress();
      if (this.state.current !== "conflict" && this.state.canTransitionTo("error")) {
        this.state.transitionTo("error");
      }
      this.log.error(t("plugin.log.forceFailed"), error);
      try {
        await this.persistData();
      } catch (persistError) {
        this.log.error(t("plugin.log.historyPersistFailed"), persistError);
      }
      throw error;
    }
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
      throw new Error(t("plugin.error.connectionIncomplete"));
    }
    return new WebDavClient(
      {
        serverUrl: settings.serverUrl,
        remoteRoot: settings.remoteRoot,
        credentials: { username: settings.username, password },
      },
      new RetryingWebDavTransport(new ObsidianWebDavTransport(), {
        maxRetries: 2,
        onRetry: (info) => {
          const detail = info.reason === "network"
            ? t("plugin.log.retryDetail.network", { error: redactLogText(info.error?.message ?? String(info.error)) })
            : t("plugin.log.retryDetail.http", { status: info.status ?? 0 });
          this.log.warn(t("plugin.log.webdavRetry", { method: info.method, attempt: info.attempt }), { detail });
        },
      }),
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
    if (this.disposed) throw new Error(t("plugin.error.disposed"));
    if (revision !== this.configRevision) {
      throw new Error(t("plugin.error.settingsChanged"));
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
    this.log.info(t("plugin.log.rescanDone"), { count: this.changes.size });
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
  const prefix = t("plugin.status.prefix");
  if (state === "unconfigured") return { icon: "settings", text: prefix + t("plugin.status.unconfigured") };
  if (state === "error") return { icon: "triangle-alert", text: prefix + t("plugin.status.failed") };
  if (state === "offline") return { icon: "cloud-off", text: prefix + t("plugin.status.offline") };
  if (state === "conflict") return { icon: "git-merge", text: prefix + t("plugin.status.conflict") };
  if (state === "paused") return { icon: "pause", text: prefix + t("plugin.status.paused") };
  if (state !== "idle") {
    const label = progress?.message ?? describeSyncState(state);
    const suffix = progress ? ` ${formatProgressPercent(progress)}%` : "";
    return { icon: "refresh-cw", text: `${prefix}${label}${suffix}` };
  }
  if (pendingCount > 0) return { icon: "cloud-upload", text: prefix + t("plugin.status.pending", { count: pendingCount }) };
  return { icon: "cloud-check", text: prefix + t("plugin.status.ready") };
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function describeHeadUpdateStrategy(strategy: HeadUpdateStrategy): string {
  if (strategy === "etag") return t("plugin.headStrategy.etag");
  if (strategy === "move-lock") return t("plugin.headStrategy.moveLock");
  if (strategy === "mkcol-lock") return t("plugin.headStrategy.mkcolLock");
  return t("plugin.headStrategy.none");
}

function describeSyncState(state: SyncState): string {
  const keys: Record<SyncState, MessageKey> = {
    unconfigured: "plugin.syncState.unconfigured",
    idle: "plugin.syncState.idle",
    scanning: "plugin.syncState.scanning",
    "checking-remote": "plugin.syncState.checking-remote",
    planning: "plugin.syncState.planning",
    uploading: "plugin.syncState.uploading",
    downloading: "plugin.syncState.downloading",
    merging: "plugin.syncState.merging",
    applying: "plugin.syncState.applying",
    "updating-head": "plugin.syncState.updating-head",
    paused: "plugin.syncState.paused",
    offline: "plugin.syncState.offline",
    conflict: "plugin.syncState.conflict",
    error: "plugin.syncState.error",
  };
  return t(keys[state]);
}

function describeSyncResultStatus(status: RepositorySyncResult["status"]): string {
  const keys: Record<RepositorySyncResult["status"], MessageKey> = {
    "up-to-date": "plugin.syncResult.up-to-date",
    pushed: "plugin.syncResult.pushed",
    pulled: "plugin.syncResult.pulled",
    merged: "plugin.syncResult.merged",
    retry: "plugin.syncResult.retry",
    conflict: "plugin.syncResult.conflict",
  };
  return t(keys[status]);
}

function describeConflictReason(
  reason: Extract<RepositorySyncResult, { status: "conflict" }>["reason"],
): string {
  const keys: Record<
    Extract<RepositorySyncResult, { status: "conflict" }>["reason"],
    MessageKey
  > = {
    "initial-both-nonempty": "plugin.conflictReason.initial-both-nonempty",
    "remote-reset": "plugin.conflictReason.remote-reset",
    "repository-mismatch": "plugin.conflictReason.repository-mismatch",
    "history-diverged": "plugin.conflictReason.history-diverged",
    "pending-apply-local-change": "plugin.conflictReason.pending-apply-local-change",
    "mass-delete": "plugin.conflictReason.mass-delete",
    "tree-conflict": "plugin.conflictReason.tree-conflict",
  };
  return t(keys[reason]);
}

function connectionConfigKey(settings: WebDavSyncSettings): string {
  return JSON.stringify([
    settings.serverUrl,
    settings.remoteRoot,
    settings.username,
  ]);
}
