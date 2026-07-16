import { App, Modal, Notice } from "obsidian";
import type { ConflictChoice } from "../sync";
import {
  chooseInitialConflictPath,
  filterConflicts,
  getConflictResolutionProgress,
  moveConflictSelection,
  type ConflictFilter,
} from "./conflict-resolution-model";
import { buildThreeWayDiff, type DiffLine } from "./diff-lines";
import { formatConflictAction, type SyncCenterConflict, type SyncCenterSnapshot } from "./sync-center-modal";

export interface ConflictResolverController {
  getSnapshot(): SyncCenterSnapshot;
  chooseConflict(path: string, choice: ConflictChoice): void;
  runManualSync(): Promise<void>;
}

export class ConflictResolverModal extends Modal {
  private selectedPath: string | null = null;
  private filter: ConflictFilter = "all";

  constructor(app: App, private readonly controller: ConflictResolverController) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("处理同步冲突");
    this.modalEl.addClass("webdav-conflict-resolver-modal");
    this.render();
  }

  onClose(): void {
    this.modalEl.removeClass("webdav-conflict-resolver-modal");
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const snapshot = this.controller.getSnapshot();
    const progress = getConflictResolutionProgress(snapshot.conflicts);
    if (!this.selectedPath || !snapshot.conflicts.some(({ path }) => path === this.selectedPath)) {
      this.selectedPath = chooseInitialConflictPath(snapshot.conflicts);
    }

    const header = this.contentEl.createDiv({ cls: "webdav-conflict-resolver-header" });
    header.createEl("strong", { text: "解决同步冲突" });
    header.createSpan({
      text: progress.total > 0
        ? `已处理 ${progress.resolved} / ${progress.total}`
        : "当前冲突需要手动检查",
    });
    header.createSpan({ text: progress.canContinue ? "全部冲突已选择处理方式" : `还有 ${progress.unresolved} 个冲突未处理` });

    const layout = this.contentEl.createDiv({ cls: "webdav-conflict-resolver-layout" });
    const visible = filterConflicts(snapshot.conflicts, this.filter);
    this.renderSidebar(layout, snapshot.conflicts, visible, progress.resolved, progress.total);
    const main = layout.createDiv({ cls: "webdav-conflict-resolver-main" });
    const selected = snapshot.conflicts.find(({ path }) => path === this.selectedPath) ?? null;
    this.renderConflictDetail(main, selected, snapshot.conflicts);
    this.renderFooter(snapshot, progress.canContinue);
  }

  private renderSidebar(
    layout: HTMLElement,
    allConflicts: readonly SyncCenterConflict[],
    visible: readonly SyncCenterConflict[],
    resolved: number,
    total: number,
  ): void {
    const sidebar = layout.createDiv({ cls: "webdav-conflict-resolver-sidebar" });
    const sidebarHeader = sidebar.createDiv({ cls: "webdav-conflict-sidebar-header" });
    sidebarHeader.createEl("strong", { text: "冲突文件" });
    sidebarHeader.createSpan({ text: total > 0 ? `${resolved} / ${total}` : String(allConflicts.length) });

    const filters = sidebar.createDiv({ cls: "webdav-conflict-filters" });
    for (const [filter, label] of [["all", "全部"], ["unresolved", "未处理"], ["resolved", "已处理"]] as const) {
      const button = filters.createEl("button", {
        text: label,
        cls: filter === this.filter ? "is-active" : undefined,
      });
      button.addEventListener("click", () => {
        this.filter = filter;
        const nextVisible = filterConflicts(allConflicts, this.filter);
        if (!nextVisible.some(({ path }) => path === this.selectedPath)) {
          this.selectedPath = chooseInitialConflictPath(nextVisible);
        }
        this.render();
      });
    }

    const list = sidebar.createDiv({ cls: "webdav-conflict-file-list" });
    if (visible.length === 0) {
      list.createEl("p", { text: "当前筛选条件下没有文件。", cls: "webdav-sync-empty" });
      return;
    }
    for (const conflict of visible) {
      const item = list.createEl("button", {
        cls: conflict.path === this.selectedPath ? "is-active" : undefined,
        attr: { type: "button" },
      });
      const title = item.createDiv({ cls: "webdav-conflict-file-title" });
      title.createSpan({ text: conflict.path });
      title.createSpan({ text: conflictStatus(conflict), cls: conflict.choice ? "is-resolved" : "is-unresolved" });
      item.createSpan({ text: formatConflictAction(conflict.action), cls: "webdav-conflict-file-action" });
      item.addEventListener("click", () => {
        this.selectedPath = conflict.path;
        this.render();
      });
    }
  }

  private renderConflictDetail(
    container: HTMLElement,
    conflict: SyncCenterConflict | null,
    conflicts: readonly SyncCenterConflict[],
  ): void {
    if (!conflict) {
      container.createEl("p", { text: "没有可展示的冲突。", cls: "webdav-sync-empty" });
      return;
    }
    const heading = container.createDiv({ cls: "webdav-conflict-detail-heading" });
    heading.createEl("h3", { text: conflict.path });
    heading.createSpan({ text: formatConflictAction(conflict.action) });

    if (!conflict.canResolve) {
      const callout = container.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: "该冲突不能通过选择文件版本自动处理" });
      callout.createSpan({ text: "请检查仓库配置、同步历史或大量删除保护提示，然后重新运行同步。" });
      return;
    }

    const explanation = container.createDiv({ cls: "webdav-conflict-explanation" });
    explanation.createSpan({ text: conflict.choice ? `当前选择：${formatChoice(conflict.choice)}` : "请选择要保留的文件版本。" });
    if (conflict.versions) {
      explanation.createSpan({ text: "以下内容只保留在当前运行内存中，不会写入插件设置或诊断报告。" });
      this.renderTextVersions(container, conflict.versions);
    } else {
      const empty = container.createDiv({ cls: "webdav-sync-callout" });
      empty.createEl("strong", { text: "此冲突没有可合并的 Markdown 正文" });
      empty.createSpan({ text: "选择本地或远程版本后，插件会在下一次同步中按选择处理该路径。" });
    }

    const actions = container.createDiv({ cls: "webdav-conflict-choice-actions" });
    for (const choice of ["local", "remote"] as const) {
      const button = actions.createEl("button", {
        text: formatChoice(choice),
        cls: conflict.choice === choice ? "mod-cta is-selected" : undefined,
      });
      button.addEventListener("click", () => {
        const nextPath = nextUnresolvedPath(conflicts, conflict.path);
        this.controller.chooseConflict(conflict.path, choice);
        this.selectedPath = nextPath ?? conflict.path;
        this.render();
      });
    }
  }

  private renderTextVersions(
    container: HTMLElement,
    versions: NonNullable<SyncCenterConflict["versions"]>,
  ): void {
    const diff = buildThreeWayDiff(versions.base, versions.local, versions.remote);
    if (diff.simplified) {
      const warning = container.createDiv({ cls: "webdav-sync-callout is-warning" });
      warning.createSpan({ text: "文件较大，已使用简化文本视图；不会计算完整行级高亮。" });
    }
    const columns = container.createDiv({ cls: "webdav-conflict-version-columns" });
    const documents: HTMLElement[] = [];
    for (const [label, lines] of [["本地版本", diff.local], ["远程版本", diff.remote]] as const) {
      const column = columns.createDiv({ cls: "webdav-conflict-version-column" });
      column.createEl("h4", { text: label });
      documents.push(this.renderLineNumberedText(column, lines));
    }
    this.synchronizeDocumentScroll(documents);
  }

  private renderLineNumberedText(container: HTMLElement, lines: readonly DiffLine[]): HTMLElement {
    const documentEl = container.createDiv({ cls: "webdav-conflict-document" });
    for (const line of lines) {
      const row = documentEl.createDiv({ cls: `webdav-conflict-document-line is-${line.kind}` });
      row.createSpan({ text: String(line.lineNumber), cls: "webdav-conflict-line-number" });
      row.createSpan({ text: line.text || " ", cls: "webdav-conflict-line-text" });
    }
    return documentEl;
  }

  private synchronizeDocumentScroll(documents: readonly HTMLElement[]): void {
    let syncing = false;
    for (const source of documents) {
      source.addEventListener("scroll", () => {
        if (syncing) return;
        syncing = true;
        for (const target of documents) {
          if (target !== source) target.scrollTop = source.scrollTop;
        }
        syncing = false;
      });
    }
  }

  private renderFooter(snapshot: SyncCenterSnapshot, canContinue: boolean): void {
    const footer = this.contentEl.createDiv({ cls: "webdav-conflict-resolver-footer" });
    const previous = footer.createEl("button", { text: "上一个" });
    previous.addEventListener("click", () => {
      this.selectedPath = moveConflictSelection(snapshot.conflicts, this.selectedPath, -1);
      this.render();
    });
    const next = footer.createEl("button", { text: "下一个" });
    next.addEventListener("click", () => {
      this.selectedPath = moveConflictSelection(snapshot.conflicts, this.selectedPath, 1);
      this.render();
    });
    const spacer = footer.createDiv({ cls: "webdav-conflict-footer-spacer" });
    spacer.createSpan({ text: canContinue ? "所有冲突已处理，可以继续同步。" : "全部冲突处理完成后才能继续同步。" });
    const complete = footer.createEl("button", {
      text: "完成并继续同步",
      cls: "mod-cta",
    });
    complete.disabled = !canContinue;
    complete.addEventListener("click", () => {
      if (!canContinue) return;
      complete.disabled = true;
      void this.controller.runManualSync()
        .then(() => {
          const updated = this.controller.getSnapshot();
          if (updated.state !== "conflict") {
            new Notice("冲突选择已应用，同步已完成。", 6_000);
            this.close();
            return;
          }
          this.render();
        })
        .catch((error: unknown) => {
          new Notice(`同步尚未完成：${formatError(error)}`, 10_000);
          this.render();
        });
    });
  }
}

function nextUnresolvedPath(conflicts: readonly SyncCenterConflict[], currentPath: string): string | null {
  const currentIndex = conflicts.findIndex(({ path }) => path === currentPath);
  const ordered = currentIndex < 0
    ? conflicts
    : [...conflicts.slice(currentIndex + 1), ...conflicts.slice(0, currentIndex)];
  return ordered.find(({ choice }) => choice === undefined)?.path ?? null;
}

function conflictStatus(conflict: SyncCenterConflict): string {
  if (!conflict.canResolve) return "需检查";
  if (conflict.choice === "local") return "已选本地";
  if (conflict.choice === "remote") return "已选远程";
  return "未处理";
}

function formatChoice(choice: ConflictChoice): string {
  return choice === "local" ? "使用本地版本" : "使用远程版本";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
