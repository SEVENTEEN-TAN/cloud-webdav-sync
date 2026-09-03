import { App, Modal, Notice } from "obsidian";
import type { ConflictChoice } from "../sync";
import { t } from "../i18n";
import {
  chooseAllConflictPaths,
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
    this.setTitle(t("conflict.title"));
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
    header.createEl("strong", { text: t("conflict.header") });
    header.createSpan({
      text: progress.total > 0
        ? t("conflict.progress", { resolved: progress.resolved, total: progress.total })
        : t("conflict.progress.manual"),
    });
    header.createSpan({
      text: progress.canContinue
        ? t("conflict.progress.canContinue")
        : t("conflict.progress.unresolved", { count: progress.unresolved }),
    });

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
    sidebarHeader.createEl("strong", { text: t("conflict.sidebar.title") });
    sidebarHeader.createSpan({ text: total > 0 ? `${resolved} / ${total}` : String(allConflicts.length) });

    const filters = sidebar.createDiv({ cls: "webdav-conflict-filters" });
    const filterLabels: readonly [ConflictFilter, string][] = [
      ["all", t("conflict.filter.all")],
      ["unresolved", t("conflict.filter.unresolved")],
      ["resolved", t("conflict.filter.resolved")],
    ];
    for (const [filter, label] of filterLabels) {
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
      list.createEl("p", { text: t("conflict.sidebar.empty"), cls: "webdav-sync-empty" });
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
      container.createEl("p", { text: t("conflict.detail.empty"), cls: "webdav-sync-empty" });
      return;
    }
    const heading = container.createDiv({ cls: "webdav-conflict-detail-heading" });
    heading.createEl("h3", { text: conflict.path });
    heading.createSpan({ text: formatConflictAction(conflict.action) });

    if (!conflict.canResolve) {
      const callout = container.createDiv({ cls: "webdav-sync-callout is-warning" });
      callout.createEl("strong", { text: t("conflict.detail.cannotResolveTitle") });
      callout.createSpan({
        text: t("conflict.detail.cannotResolveBody"),
      });
      return;
    }

    const explanation = container.createDiv({ cls: "webdav-conflict-explanation" });
    explanation.createSpan({
      text: conflict.choice
        ? t("conflict.detail.currentChoice", { choice: formatChoice(conflict.choice) })
        : t("conflict.detail.choosePrompt"),
    });
    if (conflict.versions) {
      explanation.createSpan({ text: t("conflict.detail.memoryOnly") });
      this.renderTextVersions(container, conflict.versions);
    } else {
      const empty = container.createDiv({ cls: "webdav-sync-callout" });
      empty.createEl("strong", { text: t("conflict.detail.noMarkdownTitle") });
      empty.createSpan({ text: t("conflict.detail.noMarkdownBody") });
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
      warning.createSpan({ text: t("conflict.detail.simplified") });
    }
    const columns = container.createDiv({ cls: "webdav-conflict-version-columns" });
    const documents: HTMLElement[] = [];
    const columnLabels: readonly [string, readonly DiffLine[]][] = [
      [t("conflict.column.local"), diff.local],
      [t("conflict.column.remote"), diff.remote],
    ];
    for (const [label, lines] of columnLabels) {
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
    const previous = footer.createEl("button", { text: t("conflict.footer.previous") });
    previous.addEventListener("click", () => {
      this.selectedPath = moveConflictSelection(snapshot.conflicts, this.selectedPath, -1);
      this.render();
    });
    const next = footer.createEl("button", { text: t("conflict.footer.next") });
    next.addEventListener("click", () => {
      this.selectedPath = moveConflictSelection(snapshot.conflicts, this.selectedPath, 1);
      this.render();
    });
    const progress = getConflictResolutionProgress(snapshot.conflicts);
    for (const choice of ["local", "remote"] as const) {
      const bulk = footer.createEl("button", {
        text: choice === "local" ? t("conflict.footer.allLocal") : t("conflict.footer.allRemote"),
        cls: "webdav-conflict-bulk-choice",
      });
      bulk.disabled = progress.unresolved === 0;
      bulk.addEventListener("click", () => {
        for (const path of chooseAllConflictPaths(snapshot.conflicts, choice)) {
          this.controller.chooseConflict(path, choice);
        }
        this.render();
      });
    }
    const spacer = footer.createDiv({ cls: "webdav-conflict-footer-spacer" });
    spacer.createSpan({
      text: canContinue ? t("conflict.footer.canContinue") : t("conflict.footer.cannotContinue"),
    });
    const complete = footer.createEl("button", {
      text: t("conflict.footer.complete"),
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
            new Notice(t("conflict.notice.applied"), 6_000);
            this.close();
            return;
          }
          this.render();
        })
        .catch((error: unknown) => {
          new Notice(t("conflict.notice.incomplete", { error: formatError(error) }), 10_000);
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
  if (!conflict.canResolve) return t("conflict.status.needsReview");
  if (conflict.choice === "local") return t("conflict.status.local");
  if (conflict.choice === "remote") return t("conflict.status.remote");
  return t("conflict.status.unresolved");
}

function formatChoice(choice: ConflictChoice): string {
  return choice === "local" ? t("conflict.choice.local") : t("conflict.choice.remote");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
