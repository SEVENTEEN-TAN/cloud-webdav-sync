export interface FileChange {
  readonly kind: "create" | "modify" | "delete";
  readonly path: string;
  readonly detectedAt: number;
}

export interface RenameChange {
  readonly kind: "rename";
  readonly previousPath: string;
  readonly path: string;
  readonly detectedAt: number;
}

export type PendingChange = FileChange | RenameChange;

function assertPath(path: string, field: string): void {
  if (path.length === 0) {
    throw new TypeError(field + " must not be empty");
  }
}

function copyChange(change: PendingChange): PendingChange {
  return { ...change };
}

export class ChangeQueue {
  readonly #changes = new Map<string, PendingChange>();

  get size(): number {
    return this.#changes.size;
  }

  enqueue(change: PendingChange): void {
    assertPath(change.path, "path");
    if (change.kind === "rename") {
      assertPath(change.previousPath, "previousPath");
      this.#enqueueRename(change);
      return;
    }

    const existing = this.#changes.get(change.path);
    if (!existing) {
      this.#changes.set(change.path, copyChange(change));
      return;
    }

    if (existing.kind === "rename") {
      this.#mergeAfterRename(existing, change);
      return;
    }

    if (existing.kind === "create" && change.kind === "delete") {
      this.#changes.delete(change.path);
      return;
    }

    const nextKind =
      existing.kind === "create"
        ? "create"
        : existing.kind === "delete" && change.kind === "create"
          ? "modify"
          : change.kind;

    this.#changes.set(change.path, {
      kind: nextKind,
      path: change.path,
      detectedAt: change.detectedAt
    });
  }

  snapshot(): PendingChange[] {
    return [...this.#changes.values()].map(copyChange);
  }

  drain(): PendingChange[] {
    const changes = this.snapshot();
    this.#changes.clear();
    return changes;
  }

  acknowledge(processed: readonly PendingChange[]): void {
    for (const change of processed) {
      const current = this.#changes.get(change.path);
      if (current && sameChange(current, change)) this.#changes.delete(change.path);
    }
  }

  clear(): void {
    this.#changes.clear();
  }

  #enqueueRename(change: RenameChange): void {
    if (change.previousPath === change.path) {
      return;
    }

    const previous = this.#changes.get(change.previousPath);
    if (previous) {
      this.#changes.delete(change.previousPath);
    }

    if (previous?.kind === "create") {
      this.#changes.set(change.path, {
        kind: "create",
        path: change.path,
        detectedAt: change.detectedAt
      });
      return;
    }

    this.#changes.set(change.path, {
      kind: "rename",
      previousPath: previous?.kind === "rename" ? previous.previousPath : change.previousPath,
      path: change.path,
      detectedAt: change.detectedAt
    });
  }

  #mergeAfterRename(existing: RenameChange, change: FileChange): void {
    if (change.kind === "delete") {
      this.#changes.delete(change.path);
      this.#changes.set(existing.previousPath, {
        kind: "delete",
        path: existing.previousPath,
        detectedAt: change.detectedAt
      });
      return;
    }

    this.#changes.set(change.path, {
      ...existing,
      detectedAt: change.detectedAt
    });
  }
}

function sameChange(left: PendingChange, right: PendingChange): boolean {
  if (left.kind !== right.kind || left.path !== right.path || left.detectedAt !== right.detectedAt) {
    return false;
  }
  return left.kind !== "rename" ||
    (right.kind === "rename" && left.previousPath === right.previousPath);
}
