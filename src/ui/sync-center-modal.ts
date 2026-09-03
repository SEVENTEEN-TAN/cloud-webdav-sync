import { App, ConfirmationModal, Modal, Notice } from "obsidian";
import type { CommitHistoryEntry } from "../repository";
import type { SyncState } from "../core";
import { matchesMessage, t, type MessageKey } from "../i18n";
import type { LogEntry, SyncHistoryEntry } from "../logging";
import type { ConflictChoice, PendingChange } from "../sync";
import type { WebDavCapabilities } from "../webdav";

export interface SyncCenterConflict {
  path: string;
  action: string;
  canResolve: boolean;
  choice?: ConflictChoice;
  versions?: { base: string; local: string; remote: string };
}

export interface SyncCenterSnapshot {
  state: SyncState;
  pending: PendingChange[];
  logs: LogEntry[];
  capabilities: WebDavCapabilities | null;
  realSyncEnabled: boolean;
  pendingApply: { targetCommitId: string; operationId: string } | null;
  conflicts: SyncCenterConflict[];
  history: SyncHistoryEntry[];
}

export interface SyncCenterController {
  getSnapshot(): SyncCenterSnapshot;
  runManualSync(): Promise<void>;
  clearRemoteLock(): Promise<void>;
  clearHistoryAndLogs(): Promise<void>;
  openConflictResolver(): void;
  copyDiagnostics(): Promise<void>;
  forcePushLocal(): Promise<void>;
  forcePullRemote(): Promise<void>;
  fetchCommitHistory(): Promise<CommitHistoryEntry[]>;
}

type SyncCenterTab = "overview" | "pending" | "versions" | "history" | "logs" | "capabilities";
type LogFilter = "all" | LogEntry["level"];

const TABS: readonly { id: SyncCenterTab; labelKey: MessageKey }[] = [
  { id: "overview", labelKey: "syncCenter.tab.overview" },
  { id: "pending", labelKey: "syncCenter.tab.pending" },
  { id: "versions", labelKey: "syncCenter.tab.versions" },
  { id: "history", labelKey: "syncCenter.tab.history" },
  { id: "logs", labelKey: "syncCenter.tab.logs" },
  { id: "capabilities", labelKey: "syncCenter.tab.capabilities" },
];

export class SyncCenterModal extends Modal {
  private activeTab: SyncCenterTab = "overview";
  private logFilter: LogFilter = "all";
  private commitHistory: CommitHistoryEntry[] | null = null;
  private loadingCommitHistory = false;

  constructor(app: App, private readonly controller: SyncCenterController) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("syncCenter.title"));
    this.modalEl.addClass("webdav-sync-center-modal");
    this.render();
  }

  onClose(): void {
    this.modalEl.removeClass("webdav-sync-center-modal");
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const snapshot = this.controller.getSnapshot();
    this.renderHeader(snapshot);
    this.renderTabs();
    const content = this.contentEl.createDiv({ cls: "webdav-sync-center-content" });
    if (this.activeTab === "overview") this.renderOverview(content, snapshot);
    if (this.activeTab === "pending") this.renderPending(content, snapshot.pending);
    if (this.activeTab === "versions") this.renderVersions(content);
    if (this.activeTab === "history") this.renderHistory(content, snapshot.history);
    if (this.activeTab === "logs") this.renderLogs(content, snapshot.logs);
    if (this.activeTab === "capabilities") this.renderCapabilities(content, snapshot.capabilities);
  }

  private renderHeader(snapshot: SyncCenterSnapshot): void {
    const header = this.contentEl.createDiv({ cls: "webdav-sync-center-header" });
    const state = header.createDiv({ cls: "webdav-sync-center-state" });
    state.createEl("strong", { text: formatSyncState(snapshot.state) });
    state.createSpan({ text: stateDescription(snapshot) });

    const metrics = header.createDiv({ cls: "webdav-sync-center-metrics" });
    this.createMetric(metrics, t("syncCenter.metric.pending"), String(snapshot.pending.length));
    this.createMetric(metrics, t("syncCenter.metric.conflicts"), String(snapshot.conflicts.length));
    this.createMetric(
      metrics,
      t("syncCenter.metric.realSync"),
      snapshot.realSyncEnabled ? t("syncCenter.metric.realSyncOn") : t("syncCenter.metric.realSyncPlanning"),
    );

    const actions = header.createDiv({ cls: "webdav-sync-center-actions" });
    const primary = actions.createEl("button", {
      text: snapshot.conflicts.length > 0
        ? t("syncCenter.action.resolveConflicts", { count: snapshot.conflicts.length })
        : snapshot.pendingApply
          ? t("syncCenter.action.resumeApply")
          : t("syncCenter.action.checkNow"),
      cls: "mod-cta",
    });
    primary.addEventListener("click", () => {
      if (snapshot.conflicts.length > 0) {
        this.controller.openConflictResolver();
        this.close();
        return;
      }
      primary.disabled = true;
      void this.controller.runManualSync()
        .then(() => this.render())
        .catch((error: unknown) => {
          new Notice(t("syncCenter.notice.checkFailed", { error: formatError(error) }), 10_000);
          this.render();
        });
    });

    const copyButton = actions.createEl("button", { text: t("syncCenter.action.copyDiagnostics") });
    copyButton.addEventListener("click", () => {
      copyButton.disabled = true;
      void this.controller.copyDiagnostics()
        .then(() => new Notice(t("syncCenter.notice.diagnosticsCopied")))
        .catch((error: unknown) => new Notice(t("syncCenter.notice.copyFailed", { error: formatError(error) })))
        .finally(() => { copyButton.disabled = false; });
    });

    const clearButton = actions.createEl("button", { text: t("syncCenter.action.clearHistory") });
    clearButton.addEventListener("click", () => {
      void confirmAction(
        this.app,
        t("syncCenter.confirm.clearHistoryTitle"),
        t("syncCenter.confirm.clearHistoryBody"),
        t("syncCenter.confirm.clear"),
      ).then((confirmed) => {
        if (!confirmed) return;
        clearButton.disabled = true;
        void this.controller.clearHistoryAndLogs()
          .then(() => {
            new Notice(t("syncCenter.notice.historyCleared"));
            this.render();
          })
          .catch((error: unknown) => {
            new Notice(t("syncCenter.notice.clearHistoryFailed", { error: formatError(error) }), 10_000);
            clearButton.disabled = false;
          });
      });
    });
  }

  private createMetric(container: HTMLElement, label: string, value: string): void {
    const metric = container.createDiv({ cls: "webdav-sync-center-metric" });
    metric.createSpan({ text: label });
    metric.createEl("strong", { text: value });
  }

  private renderTabs(): void {
    const tabs = this.contentEl.createDiv({ cls: "webdav-sync-tabs", attr: { role: "tablist" } });
    for (const tab of TABS) {
      const button = tabs.createEl("button", {
        text: t(tab.labelKey),
        cls: tab.id === this.activeTab ? "is-active" : undefined,
        attr: { role: "tab", "aria-selected": String(tab.id === this.activeTab) },
      });
      button.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.render();
      });
    }
  }

  private renderOverview(container: HTMLElement, snapshot: SyncCenterSnapshot): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    const latest = snapshot.history.at(-1);
    section.createEl("h3", { text: t("syncCenter.overview.title") });
    section.createEl("p", {
      text: snapshot.realSyncEnabled
        ? t("syncCenter.overview.realSyncDesc")
        : t("syncCenter.overview.planningDesc"),
    });

    if (isHeadLockRetryFailure(snapshot, latest)) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: t("syncCenter.callout.headChurnTitle") });
      callout.createSpan({ text: t("syncCenter.callout.headChurnBody") });
      const button = callout.createEl("button", { text: t("syncCenter.action.clearLockRetry"), cls: "mod-warning" });
      button.addEventListener("click", () => {
        void confirmAction(
          this.app,
          t("syncCenter.confirm.clearLockTitle"),
          t("syncCenter.confirm.clearLockBody"),
          t("syncCenter.action.clearLockRetry"),
        ).then((confirmed) => {
          if (!confirmed) return;
          button.disabled = true;
          void this.controller.clearRemoteLock()
            .then(() => this.controller.runManualSync())
            .then(() => this.render())
            .catch((error: unknown) => {
              new Notice(t("syncCenter.notice.clearLockFailed", { error: formatError(error) }), 10_000);
              this.render();
            });
        });
      });
    }

    if (snapshot.conflicts.length > 0) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-error" });
      const resolved = snapshot.conflicts.filter(({ choice }) => choice !== undefined).length;
      callout.createEl("strong", { text: t("syncCenter.callout.conflictsTitle", { count: snapshot.conflicts.length }) });
      callout.createSpan({ text: t("syncCenter.callout.conflictsBody", { resolved }) });
      const button = callout.createEl("button", { text: t("syncCenter.action.resolve"), cls: "mod-cta" });
      button.addEventListener("click", () => {
        this.controller.openConflictResolver();
        this.close();
      });
    }

    if (snapshot.conflicts.length > 0 || snapshot.state === "conflict") {
      this.renderRecoveryActions(section, snapshot.realSyncEnabled);
    }

    if (snapshot.pendingApply) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: t("syncCenter.callout.pendingApplyTitle") });
      callout.createSpan({
        text: t("syncCenter.callout.pendingApplyBody", { commitId: snapshot.pendingApply.targetCommitId.slice(0, 12) }),
      });
    }

    if (snapshot.capabilities && !snapshot.capabilities.safeConcurrentWrites) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: t("syncCenter.callout.capabilitiesTitle") });
      callout.createSpan({ text: t("syncCenter.callout.capabilitiesBody") });
    }

    const recent = section.createDiv({ cls: "webdav-sync-overview-detail" });
    recent.createSpan({ text: t("syncCenter.overview.latest") });
    recent.createEl("strong", {
      text: latest
        ? `${formatHistoryOutcome(latest.outcome)} · ${new Date(latest.finishedAt).toLocaleString()}`
        : t("syncCenter.overview.noHistory"),
    });
  }

  private renderRecoveryActions(section: HTMLElement, realSyncEnabled: boolean): void {
    const recovery = section.createDiv({ cls: "webdav-sync-callout" });
    recovery.createEl("strong", { text: t("syncCenter.recovery.title") });
    recovery.createSpan({
      text: realSyncEnabled
        ? t("syncCenter.recovery.desc")
        : t("syncCenter.recovery.descPlanning"),
    });
    const actions = recovery.createDiv({ cls: "webdav-sync-recovery-actions" });
    const pushButton = actions.createEl("button", { text: t("syncCenter.action.forcePush"), cls: "mod-warning" });
    const pullButton = actions.createEl("button", { text: t("syncCenter.action.forcePull"), cls: "mod-warning" });
    pushButton.disabled = !realSyncEnabled;
    pullButton.disabled = !realSyncEnabled;
    const runForced = (direction: "push" | "pull") => {
      pushButton.disabled = true;
      pullButton.disabled = true;
      const request = direction === "push"
        ? this.controller.forcePushLocal()
        : this.controller.forcePullRemote();
      void request
        .then(() => this.render())
        .catch((error: unknown) => {
          new Notice(t("syncCenter.notice.forceFailed", { error: formatError(error) }), 10_000);
          this.render();
        });
    };
    pushButton.addEventListener("click", () => {
      void confirmAction(
        this.app,
        t("syncCenter.action.forcePush"),
        t("syncCenter.confirm.forcePushBody"),
        t("syncCenter.confirm.forcePush"),
      ).then((confirmed) => {
        if (confirmed) runForced("push");
      });
    });
    pullButton.addEventListener("click", () => {
      void confirmAction(
        this.app,
        t("syncCenter.action.forcePull"),
        t("syncCenter.confirm.forcePullBody"),
        t("syncCenter.confirm.forcePull"),
      ).then((confirmed) => {
        if (confirmed) runForced("pull");
      });
    });
  }

  private renderVersions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: t("syncCenter.versions.title") });
    section.createEl("p", {
      text: t("syncCenter.versions.desc"),
      cls: "webdav-sync-muted",
    });
    const refresh = section.createEl("button", {
      text: this.loadingCommitHistory ? t("syncCenter.versions.loading") : t("syncCenter.versions.refresh"),
    });
    refresh.disabled = this.loadingCommitHistory;
    refresh.addEventListener("click", () => {
      this.loadingCommitHistory = true;
      this.render();
      void this.controller.fetchCommitHistory()
        .then((entries) => {
          this.commitHistory = entries;
        })
        .catch((error: unknown) => {
          this.commitHistory = null;
          new Notice(t("syncCenter.versions.loadFailed", { error: formatError(error) }), 10_000);
        })
        .finally(() => {
          this.loadingCommitHistory = false;
          this.render();
        });
    });

    if (this.commitHistory === null) {
      section.createEl("p", {
        text: t("syncCenter.versions.empty"),
        cls: "webdav-sync-empty",
      });
      return;
    }
    if (this.commitHistory.length === 0) {
      section.createEl("p", { text: t("syncCenter.versions.noCommits"), cls: "webdav-sync-empty" });
      return;
    }
    const list = section.createEl("ul", { cls: "webdav-sync-list webdav-sync-commit-list" });
    for (const entry of this.commitHistory) {
      const item = list.createEl("li");
      const title = item.createDiv({ cls: "webdav-sync-commit-title" });
      title.createEl("strong", { text: entry.commitId.slice(0, 12) });
      title.createSpan({ text: new Date(entry.createdAt).toLocaleString() });
      item.createDiv({ cls: "webdav-sync-commit-meta", text:
        t("syncCenter.versions.meta", {
          deviceId: entry.deviceId,
          fileCount: entry.fileCount,
          parents: entry.parents.map((parent) => parent.slice(0, 8)).join(", ") || t("syncCenter.versions.noParents"),
        }) });
    }
  }

  private renderPending(container: HTMLElement, pending: readonly PendingChange[]): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: t("syncCenter.pending.title") });
    section.createEl("p", { text: t("syncCenter.pending.desc"), cls: "webdav-sync-muted" });
    if (pending.length === 0) {
      section.createEl("p", { text: t("syncCenter.pending.empty"), cls: "webdav-sync-empty" });
      return;
    }
    const list = section.createEl("ul", { cls: "webdav-sync-list webdav-sync-change-list" });
    for (const change of pending) {
      const item = list.createEl("li");
      const label = change.kind === "rename"
        ? t("syncCenter.pending.rename", { from: change.previousPath, to: change.path })
        : `${formatPendingChangeKind(change.kind)}：${change.path}`;
      item.createEl("strong", { text: label });
      item.createSpan({ text: new Date(change.detectedAt).toLocaleTimeString() });
    }
  }

  private renderHistory(container: HTMLElement, history: readonly SyncHistoryEntry[]): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: t("syncCenter.history.title") });
    if (history.length === 0) {
      section.createEl("p", { text: t("syncCenter.history.empty"), cls: "webdav-sync-empty" });
      return;
    }
    const list = section.createEl("ul", { cls: "webdav-sync-list webdav-sync-history-list" });
    for (const entry of history.slice(-20).reverse()) {
      const item = list.createEl("li", {
        cls: entry.outcome === "error" || entry.outcome === "conflict" ? "is-error" : undefined,
      });
      item.createEl("strong", { text: formatHistoryOutcome(entry.outcome) });
      item.createSpan({ text: new Date(entry.finishedAt).toLocaleString() });
      item.createSpan({ text: entry.message });
    }
  }

  private renderLogs(container: HTMLElement, logs: readonly LogEntry[]): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: t("syncCenter.logs.title") });
    const filters = section.createDiv({ cls: "webdav-sync-log-filters" });
    for (const filter of ["all", "info", "warn", "error"] as const) {
      const button = filters.createEl("button", {
        text: filter === "all" ? t("syncCenter.logs.filter.all") : formatLogLevel(filter),
        cls: filter === this.logFilter ? "is-active" : undefined,
      });
      button.addEventListener("click", () => {
        this.logFilter = filter;
        this.render();
      });
    }
    const visible = logs
      .filter(({ level }) => this.logFilter === "all" || level === this.logFilter)
      .filter(({ level }) => level !== "debug")
      .slice(-100)
      .reverse();
    if (visible.length === 0) {
      section.createEl("p", { text: t("syncCenter.logs.empty"), cls: "webdav-sync-empty" });
      return;
    }
    const list = section.createEl("ul", { cls: "webdav-sync-list webdav-sync-log-list" });
    for (const entry of visible) {
      const item = list.createEl("li", { cls: entry.level === "error" ? "is-error" : entry.level === "warn" ? "is-warning" : undefined });
      item.createEl("strong", { text: formatLogLevel(entry.level) });
      item.createSpan({ text: new Date(entry.timestamp).toLocaleTimeString() });
      item.createSpan({ text: entry.message });
    }
  }

  private renderCapabilities(container: HTMLElement, capabilities: WebDavCapabilities | null): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: t("syncCenter.capabilities.title") });
    if (!capabilities) {
      section.createEl("p", { text: t("syncCenter.capabilities.empty"), cls: "webdav-sync-empty" });
      return;
    }

    const summary = section.createDiv({ cls: capabilities.safeConcurrentWrites ? "webdav-sync-callout is-success" : "webdav-sync-callout is-warning" });
    summary.createEl("strong", { text: capabilities.safeConcurrentWrites ? t("syncCenter.capabilities.safe") : t("syncCenter.capabilities.unsafe") });
    summary.createSpan({ text: t("syncCenter.capabilities.headStrategy", { strategy: formatHeadUpdateStrategy(capabilities.headUpdateStrategy) }) });

    if (capabilities.warnings.length > 0) {
      const warnings = section.createDiv({ cls: "webdav-sync-capability-warnings" });
      warnings.createEl("h4", { text: t("syncCenter.capabilities.warnings") });
      const list = warnings.createEl("ul", { cls: "webdav-sync-list" });
      for (const warning of capabilities.warnings) list.createEl("li", { text: formatCapabilityWarning(warning), cls: "is-warning" });
    }

    const details = section.createEl("details", { cls: "webdav-sync-capability-details" });
    details.createEl("summary", { text: t("syncCenter.capabilities.details") });
    const list = details.createEl("ul", { cls: "webdav-sync-list" });
    for (const [label, value] of capabilityRows(capabilities)) list.createEl("li", { text: `${label}：${yesNo(value)}` });
  }
}

function capabilityRows(capabilities: WebDavCapabilities): readonly [string, boolean][] {
  return [
    [t("syncCenter.capabilityRow.reachable"), capabilities.reachable],
    [t("syncCenter.capabilityRow.conditionalCreate"), capabilities.conditionalCreate],
    [t("syncCenter.capabilityRow.strongEtag"), capabilities.strongEtag],
    [t("syncCenter.capabilityRow.conditionalUpdate"), capabilities.conditionalUpdate],
    [t("syncCenter.capabilityRow.staleEtagRejected"), capabilities.staleEtagRejected],
    [t("syncCenter.capabilityRow.atomicMoveNoOverwrite"), capabilities.atomicMoveNoOverwrite],
    [t("syncCenter.capabilityRow.atomicCollectionCreate"), capabilities.atomicCollectionCreate],
    [t("syncCenter.capabilityRow.cleanupSucceeded"), capabilities.cleanupSucceeded],
  ];
}

function stateDescription(snapshot: SyncCenterSnapshot): string {
  if (snapshot.conflicts.length > 0) return t("syncCenter.stateDescription.conflict");
  if (snapshot.pendingApply) return t("syncCenter.stateDescription.apply");
  if (snapshot.pending.length > 0) return t("syncCenter.stateDescription.pending");
  return snapshot.realSyncEnabled
    ? t("syncCenter.stateDescription.ready")
    : t("syncCenter.stateDescription.readyPlanning");
}

export function formatSyncState(state: SyncState): string {
  const keys: Record<SyncState, MessageKey> = {
    unconfigured: "syncCenter.syncState.unconfigured",
    idle: "syncCenter.syncState.idle",
    scanning: "syncCenter.syncState.scanning",
    "checking-remote": "syncCenter.syncState.checking-remote",
    planning: "syncCenter.syncState.planning",
    uploading: "syncCenter.syncState.uploading",
    downloading: "syncCenter.syncState.downloading",
    merging: "syncCenter.syncState.merging",
    applying: "syncCenter.syncState.applying",
    "updating-head": "syncCenter.syncState.updating-head",
    paused: "syncCenter.syncState.paused",
    offline: "syncCenter.syncState.offline",
    conflict: "syncCenter.syncState.conflict",
    error: "syncCenter.syncState.error",
  };
  return t(keys[state]);
}

export function formatConflictAction(action: string): string {
  const keys: Record<string, MessageKey> = {
    "repository-mismatch": "syncCenter.conflictAction.repository-mismatch",
    "remote-reset": "syncCenter.conflictAction.remote-reset",
    "mass-delete": "syncCenter.conflictAction.mass-delete",
    "initial-both-nonempty": "syncCenter.conflictAction.initial-both-nonempty",
    "history-diverged": "syncCenter.conflictAction.history-diverged",
    "tree-conflict": "syncCenter.conflictAction.tree-conflict",
    "pending-apply-local-change": "syncCenter.conflictAction.pending-apply-local-change",
    "markdown-overlap": "syncCenter.conflictAction.markdown-overlap",
    "conflict-add-add": "syncCenter.conflictAction.conflict-add-add",
    "conflict-delete-modify": "syncCenter.conflictAction.conflict-delete-modify",
  };
  const key = keys[action];
  return key ? t(key) : action;
}

function formatHistoryOutcome(outcome: SyncHistoryEntry["outcome"]): string {
  const keys: Record<SyncHistoryEntry["outcome"], MessageKey> = {
    planned: "syncCenter.history.outcome.planned",
    "up-to-date": "syncCenter.history.outcome.up-to-date",
    pushed: "syncCenter.history.outcome.pushed",
    pulled: "syncCenter.history.outcome.pulled",
    merged: "syncCenter.history.outcome.merged",
    conflict: "syncCenter.history.outcome.conflict",
    error: "syncCenter.history.outcome.error",
  };
  return t(keys[outcome]);
}

function formatLogLevel(level: LogEntry["level"]): string {
  const keys: Record<LogEntry["level"], MessageKey> = {
    debug: "syncCenter.logs.level.debug",
    info: "syncCenter.logs.level.info",
    warn: "syncCenter.logs.level.warn",
    error: "syncCenter.logs.level.error",
  };
  return t(keys[level]);
}

function formatPendingChangeKind(kind: Exclude<PendingChange["kind"], "rename">): string {
  const keys: Record<Exclude<PendingChange["kind"], "rename">, MessageKey> = {
    create: "syncCenter.pending.kind.create",
    modify: "syncCenter.pending.kind.modify",
    delete: "syncCenter.pending.kind.delete",
  };
  return t(keys[kind]);
}

function formatHeadUpdateStrategy(strategy: WebDavCapabilities["headUpdateStrategy"]): string {
  if (strategy === "etag") return t("syncCenter.strategy.etag");
  if (strategy === "move-lock") return t("syncCenter.strategy.moveLock");
  if (strategy === "mkcol-lock") return t("syncCenter.strategy.mkcolLock");
  return t("syncCenter.strategy.none");
}

function formatCapabilityWarning(warning: string): string {
  const exactWarnings: Record<string, MessageKey> = {
    "The server did not expose an ETag for uploaded files.": "syncCenter.capabilityWarning.noEtag",
    "The server only exposed a weak ETag.": "syncCenter.capabilityWarning.weakEtag",
  };
  const exact = exactWarnings[warning];
  if (exact) return t(exact);
  let match = /^The server did not safely enforce If-None-Match: \* \(HTTP (\d+)\)\.$/.exec(warning);
  if (match) return t("syncCenter.capabilityWarning.noConditionalCreate", { code: match[1] ?? warning });
  match = /^Conditional update returned HTTP (\d+)\.$/.exec(warning);
  if (match) return t("syncCenter.capabilityWarning.conditionalUpdate", { code: match[1] ?? warning });
  match = /^The server accepted a stale ETag update with HTTP (\d+)\.$/.exec(warning);
  if (match) return t("syncCenter.capabilityWarning.staleEtagAccepted", { code: match[1] ?? warning });
  match = /^Concurrent MKCOL did not prove exclusive lock creation \((.+)\)\.$/.exec(warning);
  if (match) return t("syncCenter.capabilityWarning.mkcolNotExclusive", { sequence: match[1] ?? warning });
  match = /^Concurrent MOVE with Overwrite: F did not prove exclusive destination creation \((.+)\)\.$/.exec(warning);
  if (match) return t("syncCenter.capabilityWarning.moveNotExclusive", { sequence: match[1] ?? warning });
  match = /^Could not remove the temporary capability probe (.+)\.$/.exec(warning);
  if (match) return t("syncCenter.capabilityWarning.probeCleanup", { path: match[1] ?? warning });
  return warning;
}

function yesNo(value: boolean): string {
  return value ? t("syncCenter.common.yes") : t("syncCenter.common.no");
}

function isHeadLockRetryFailure(
  snapshot: SyncCenterSnapshot,
  latest: SyncHistoryEntry | undefined,
): boolean {
  if (snapshot.state !== "error" || latest?.outcome !== "error") return false;
  return matchesMessage("plugin.error.headChurn", latest.message) ||
    latest.message.includes("远程 HEAD") ||
    latest.message.includes("同步锁");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function confirmAction(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app)
      .setTitle(title)
      .setContent(message)
      .addCancelButton(t("common.cancel"))
      .addButton((button) => button
        .setButtonText(confirmText)
        .setDestructive()
        .onClick(() => {
          settled = true;
          resolve(true);
        }));
    modal.setCloseCallback(() => {
      if (!settled) resolve(false);
    });
    modal.open();
  });
}
