import type { RepositoryFileEntry, RepositoryTree } from "../repository";

export type TreePlanAction =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "merge-text"
  | "conflict-add-add"
  | "conflict-delete-modify"
  | "conflict-binary";

export interface TreePlanItem {
  path: string;
  action: TreePlanAction;
  base?: RepositoryFileEntry;
  local?: RepositoryFileEntry;
  remote?: RepositoryFileEntry;
}

export function planTreeSync(
  base: RepositoryTree,
  local: RepositoryTree,
  remote: RepositoryTree,
): TreePlanItem[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const plan: TreePlanItem[] = [];

  for (const path of [...paths].sort()) {
    const baseEntry = ownEntry(base, path);
    const localEntry = ownEntry(local, path);
    const remoteEntry = ownEntry(remote, path);
    if (same(localEntry, remoteEntry)) continue;

    if (same(baseEntry, remoteEntry)) {
      plan.push(item(path, localEntry ? "upload" : "delete-remote", baseEntry, localEntry, remoteEntry));
      continue;
    }
    if (same(baseEntry, localEntry)) {
      plan.push(item(path, remoteEntry ? "download" : "delete-local", baseEntry, localEntry, remoteEntry));
      continue;
    }

    if (!baseEntry && localEntry && remoteEntry) {
      plan.push(item(path, "conflict-add-add", baseEntry, localEntry, remoteEntry));
      continue;
    }
    if (!localEntry || !remoteEntry) {
      plan.push(item(path, "conflict-delete-modify", baseEntry, localEntry, remoteEntry));
      continue;
    }
    if (localEntry.kind === "text" && remoteEntry.kind === "text" && baseEntry?.kind === "text") {
      plan.push(item(path, "merge-text", baseEntry, localEntry, remoteEntry));
      continue;
    }
    plan.push(item(path, "conflict-binary", baseEntry, localEntry, remoteEntry));
  }

  return plan;
}

function same(left: RepositoryFileEntry | undefined, right: RepositoryFileEntry | undefined): boolean {
  if (!left || !right) return left === right;
  return left.blob === right.blob;
}

function ownEntry(tree: RepositoryTree, path: string): RepositoryFileEntry | undefined {
  return Object.hasOwn(tree, path) ? tree[path] : undefined;
}

function item(
  path: string,
  action: TreePlanAction,
  base?: RepositoryFileEntry,
  local?: RepositoryFileEntry,
  remote?: RepositoryFileEntry,
): TreePlanItem {
  return { path, action, base, local, remote };
}
