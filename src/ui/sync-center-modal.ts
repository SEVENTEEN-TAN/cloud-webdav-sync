import { App, ConfirmationModal, Modal, Notice } from "obsidian";
import type { SyncState } from "../core";
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
  openConflictResolver(): void;
  copyDiagnostics(): Promise<void>;
}

type SyncCenterTab = "overview" | "pending" | "history" | "logs" | "capabilities";
type LogFilter = "all" | LogEntry["level"];

const TABS: readonly { id: SyncCenterTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "pending", label: "待同步" },
  { id: "history", label: "历史" },
  { id: "logs", label: "日志" },
  { id: "capabilities", label: "能力" },
];

export class SyncCenterModal extends Modal {
  private activeTab: SyncCenterTab = "overview";
  private logFilter: LogFilter = "all";

  constructor(app: App, private readonly controller: SyncCenterController) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("WebDAV 同步中心");
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
    this.createMetric(metrics, "待同步", String(snapshot.pending.length));
    this.createMetric(metrics, "冲突", String(snapshot.conflicts.length));
    this.createMetric(metrics, "真实同步", snapshot.realSyncEnabled ? "已开启" : "仅规划");

    const actions = header.createDiv({ cls: "webdav-sync-center-actions" });
    const primary = actions.createEl("button", {
      text: snapshot.conflicts.length > 0
        ? `处理 ${snapshot.conflicts.length} 个冲突`
        : snapshot.pendingApply
          ? "继续中断的应用"
          : "立即检查",
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
          new Notice(`WebDAV 检查失败：${formatError(error)}`, 10_000);
          this.render();
        });
    });

    const copyButton = actions.createEl("button", { text: "复制诊断" });
    copyButton.addEventListener("click", () => {
      copyButton.disabled = true;
      void this.controller.copyDiagnostics()
        .then(() => new Notice("已复制 WebDAV 同步诊断信息。"))
        .catch((error: unknown) => new Notice(`无法复制诊断信息：${formatError(error)}`))
        .finally(() => { copyButton.disabled = false; });
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
        text: tab.label,
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
    section.createEl("h3", { text: "同步概览" });
    section.createEl("p", {
      text: snapshot.realSyncEnabled
        ? "已启用真实同步。插件会在提交前校验远程状态，并在冲突时暂停后续自动同步。"
        : "当前为仅规划模式：会检查远程仓库和生成同步计划，但不会改动本地或远程内容。",
    });

    if (isHeadLockRetryFailure(snapshot, latest)) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: "远程 HEAD 或同步锁连续变化" });
      callout.createSpan({ text: "请先确认其他设备已经停止同步；确认后可以清除远程锁并立即重试。" });
      const button = callout.createEl("button", { text: "清除锁并重试", cls: "mod-warning" });
      button.addEventListener("click", () => {
        void confirmAction(
          this.app,
          "清除远程同步锁",
          "请仅在其他所有设备均已停止同步后继续。清除锁后将立即重新运行同步检查。",
          "清除锁并重试",
        ).then((confirmed) => {
          if (!confirmed) return;
          button.disabled = true;
          void this.controller.clearRemoteLock()
            .then(() => this.controller.runManualSync())
            .then(() => this.render())
            .catch((error: unknown) => {
              new Notice(`清除锁或重试失败：${formatError(error)}`, 10_000);
              this.render();
            });
        });
      });
    }

    if (snapshot.conflicts.length > 0) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-error" });
      const resolved = snapshot.conflicts.filter(({ choice }) => choice !== undefined).length;
      callout.createEl("strong", { text: `有 ${snapshot.conflicts.length} 个冲突需要处理` });
      callout.createSpan({ text: `已选择 ${resolved} 个版本；请在冲突解决工作台中完成剩余处理。` });
      const button = callout.createEl("button", { text: "处理冲突", cls: "mod-cta" });
      button.addEventListener("click", () => {
        this.controller.openConflictResolver();
        this.close();
      });
    }

    if (snapshot.pendingApply) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: "可继续上次中断的远程更改应用" });
      callout.createSpan({ text: `目标提交：${snapshot.pendingApply.targetCommitId.slice(0, 12)}…` });
    }

    if (snapshot.capabilities && !snapshot.capabilities.safeConcurrentWrites) {
      const callout = section.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: "远程服务器尚未证明可安全并发写入" });
      callout.createSpan({ text: "请在“能力”页查看 WebDAV 检测结果和警告。" });
    }

    const recent = section.createDiv({ cls: "webdav-sync-overview-detail" });
    recent.createSpan({ text: "最近一次同步" });
    recent.createEl("strong", {
      text: latest
        ? `${formatHistoryOutcome(latest.outcome)} · ${new Date(latest.finishedAt).toLocaleString()}`
        : "尚无记录",
    });
  }

  private renderPending(container: HTMLElement, pending: readonly PendingChange[]): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: "待同步的本地更改" });
    section.createEl("p", { text: "队列会自动合并连续的新建、修改、删除和重命名事件。", cls: "webdav-sync-muted" });
    if (pending.length === 0) {
      section.createEl("p", { text: "当前没有待同步的本地更改。", cls: "webdav-sync-empty" });
      return;
    }
    const list = section.createEl("ul", { cls: "webdav-sync-list webdav-sync-change-list" });
    for (const change of pending) {
      const item = list.createEl("li");
      const label = change.kind === "rename"
        ? `重命名：${change.previousPath} → ${change.path}`
        : `${formatPendingChangeKind(change.kind)}：${change.path}`;
      item.createEl("strong", { text: label });
      item.createSpan({ text: new Date(change.detectedAt).toLocaleTimeString() });
    }
  }

  private renderHistory(container: HTMLElement, history: readonly SyncHistoryEntry[]): void {
    const section = container.createDiv({ cls: "webdav-sync-section" });
    section.createEl("h3", { text: "同步历史" });
    if (history.length === 0) {
      section.createEl("p", { text: "尚无已完成的同步记录。", cls: "webdav-sync-empty" });
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
    section.createEl("h3", { text: "运行日志" });
    const filters = section.createDiv({ cls: "webdav-sync-log-filters" });
    for (const filter of ["all", "info", "warn", "error"] as const) {
      const button = filters.createEl("button", {
        text: filter === "all" ? "全部" : formatLogLevel(filter),
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
      section.createEl("p", { text: "当前筛选条件下没有日志。", cls: "webdav-sync-empty" });
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
    section.createEl("h3", { text: "WebDAV 能力" });
    if (!capabilities) {
      section.createEl("p", { text: "尚未完成连接能力检测。请在设置页点击“测试连接”，或运行一次同步检查。", cls: "webdav-sync-empty" });
      return;
    }

    const summary = section.createDiv({ cls: capabilities.safeConcurrentWrites ? "webdav-sync-callout is-success" : "webdav-sync-callout is-warning" });
    summary.createEl("strong", { text: capabilities.safeConcurrentWrites ? "已验证可安全并发写入" : "尚未验证可安全并发写入" });
    summary.createSpan({ text: `HEAD 更新策略：${formatHeadUpdateStrategy(capabilities.headUpdateStrategy)}` });

    if (capabilities.warnings.length > 0) {
      const warnings = section.createDiv({ cls: "webdav-sync-capability-warnings" });
      warnings.createEl("h4", { text: "警告" });
      const list = warnings.createEl("ul", { cls: "webdav-sync-list" });
      for (const warning of capabilities.warnings) list.createEl("li", { text: formatCapabilityWarning(warning), cls: "is-warning" });
    }

    const details = section.createEl("details", { cls: "webdav-sync-capability-details" });
    details.createEl("summary", { text: "查看检测明细" });
    const list = details.createEl("ul", { cls: "webdav-sync-list" });
    for (const [label, value] of capabilityRows(capabilities)) list.createEl("li", { text: `${label}：${yesNo(value)}` });
  }
}

function capabilityRows(capabilities: WebDavCapabilities): readonly [string, boolean][] {
  return [
    ["可访问", capabilities.reachable],
    ["条件创建", capabilities.conditionalCreate],
    ["强 ETag", capabilities.strongEtag],
    ["条件更新", capabilities.conditionalUpdate],
    ["过期 ETag 被拒绝", capabilities.staleEtagRejected],
    ["原子 MOVE 禁止覆盖", capabilities.atomicMoveNoOverwrite],
    ["排他 MKCOL", capabilities.atomicCollectionCreate],
    ["临时资源已清理", capabilities.cleanupSucceeded],
  ];
}

function stateDescription(snapshot: SyncCenterSnapshot): string {
  if (snapshot.conflicts.length > 0) return "同步已暂停，等待处理冲突。";
  if (snapshot.pendingApply) return "检测到可恢复的中断应用。";
  if (snapshot.pending.length > 0) return "检测到本地更改，等待下一次同步。";
  return snapshot.realSyncEnabled ? "仓库状态已准备就绪。" : "当前处于仅规划模式。";
}

export function formatSyncState(state: SyncState): string {
  const labels: Record<SyncState, string> = {
    unconfigured: "未配置",
    idle: "空闲",
    scanning: "正在扫描",
    "checking-remote": "正在检查远程端",
    planning: "正在生成同步计划",
    uploading: "正在上传",
    downloading: "正在下载",
    merging: "正在合并",
    applying: "正在应用更改",
    "updating-head": "正在更新远程 HEAD",
    paused: "已暂停",
    offline: "离线",
    conflict: "存在冲突",
    error: "错误",
  };
  return labels[state];
}

export function formatConflictAction(action: string): string {
  const labels: Record<string, string> = {
    "repository-mismatch": "仓库标识不匹配",
    "remote-reset": "远程仓库已重置",
    "mass-delete": "触发大量删除保护",
    "initial-both-nonempty": "首次同步时本地与远程均有文件",
    "history-diverged": "同步历史已分叉",
    "tree-conflict": "文件树冲突",
    "pending-apply-local-change": "恢复中断操作时检测到本地修改",
    "markdown-overlap": "Markdown 内容重叠冲突",
    "conflict-add-add": "本地与远程同时新增",
    "conflict-delete-modify": "删除与修改冲突",
  };
  return labels[action] ?? action;
}

function formatHistoryOutcome(outcome: SyncHistoryEntry["outcome"]): string {
  const labels: Record<SyncHistoryEntry["outcome"], string> = {
    planned: "已生成计划",
    "up-to-date": "已是最新",
    pushed: "已推送",
    pulled: "已拉取",
    merged: "已合并",
    conflict: "冲突",
    error: "错误",
  };
  return labels[outcome];
}

function formatLogLevel(level: LogEntry["level"]): string {
  const labels: Record<LogEntry["level"], string> = {
    debug: "调试",
    info: "信息",
    warn: "警告",
    error: "错误",
  };
  return labels[level];
}

function formatPendingChangeKind(kind: Exclude<PendingChange["kind"], "rename">): string {
  const labels: Record<Exclude<PendingChange["kind"], "rename">, string> = {
    create: "新建",
    modify: "修改",
    delete: "删除",
  };
  return labels[kind];
}

function formatHeadUpdateStrategy(strategy: WebDavCapabilities["headUpdateStrategy"]): string {
  if (strategy === "etag") return "ETag 比较并交换";
  if (strategy === "move-lock") return "MOVE 排他锁";
  if (strategy === "mkcol-lock") return "MKCOL 排他锁";
  return "无";
}

function formatCapabilityWarning(warning: string): string {
  const exactWarnings: Record<string, string> = {
    "The server did not expose an ETag for uploaded files.": "服务器没有为已上传文件提供 ETag。",
    "The server only exposed a weak ETag.": "服务器仅提供弱 ETag。",
  };
  const exact = exactWarnings[warning];
  if (exact) return exact;
  let match = /^The server did not safely enforce If-None-Match: \* \(HTTP (\d+)\)\.$/.exec(warning);
  if (match) return `服务器未安全执行 If-None-Match: * 条件（HTTP ${match[1]}）。`;
  match = /^Conditional update returned HTTP (\d+)\.$/.exec(warning);
  if (match) return `条件更新返回 HTTP ${match[1]}。`;
  match = /^The server accepted a stale ETag update with HTTP (\d+)\.$/.exec(warning);
  if (match) return `服务器错误接受了使用过期 ETag 的更新（HTTP ${match[1]}）。`;
  match = /^Concurrent MKCOL did not prove exclusive lock creation \((.+)\)\.$/.exec(warning);
  if (match) return `并发 MKCOL 未能证明锁创建具有排他性（${match[1]}）。`;
  match = /^Concurrent MOVE with Overwrite: F did not prove exclusive destination creation \((.+)\)\.$/.exec(warning);
  if (match) return `使用 Overwrite: F 的并发 MOVE 未能证明目标创建具有排他性（${match[1]}）。`;
  match = /^Could not remove the temporary capability probe (.+)\.$/.exec(warning);
  if (match) return `无法删除临时能力检测目录 ${match[1]}。`;
  return warning;
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

function isHeadLockRetryFailure(
  snapshot: SyncCenterSnapshot,
  latest: SyncHistoryEntry | undefined,
): boolean {
  if (snapshot.state !== "error" || latest?.outcome !== "error") return false;
  return latest.message.includes("远程 HEAD") || latest.message.includes("同步锁");
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
      .addCancelButton("取消")
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
