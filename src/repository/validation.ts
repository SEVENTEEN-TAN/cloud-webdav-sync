import type { CommitContent, RepositoryFileEntry, RepositoryTree, StoredCommit } from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const PACK_PATH = /^packs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.pack$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const EXCLUDED_ROOTS = new Set([".obsidian", ".trash", ".git"]);

export function validateCommitContent(value: CommitContent, expectedRepositoryId?: string): void {
  if (value.formatVersion !== 1) throw new Error("Unsupported commit format version.");
  if (!value.repositoryId || (expectedRepositoryId && value.repositoryId !== expectedRepositoryId)) {
    throw new Error("Commit repository identity does not match the configured repository.");
  }
  if (!Array.isArray(value.parents) || value.parents.some((parent) => !SHA256.test(parent))) {
    throw new Error("Commit contains an invalid parent ID.");
  }
  if (typeof value.deviceId !== "string" || !value.deviceId) throw new Error("Commit device ID is invalid.");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("Commit timestamp is invalid.");
  }
  validateRepositoryTree(value.files);
}

export function validateStoredCommitShape(
  value: StoredCommit,
  expectedCommitId: string,
  expectedRepositoryId?: string,
): void {
  if (!SHA256.test(value.commitId) || value.commitId !== expectedCommitId) {
    throw new Error("Stored commit ID does not match its repository path.");
  }
  validateCommitContent(value, expectedRepositoryId);
}

export function validateRepositoryTree(tree: RepositoryTree): void {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("Commit file tree is invalid.");
  }
  const paths = Object.keys(tree);
  const collisionKeys = new Set<string>();
  const pathSet = new Set(paths);

  for (const path of paths) {
    validateVaultPath(path);
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (collisionKeys.has(collisionKey)) throw new Error(`Vault path collision: ${path}`);
    collisionKeys.add(collisionKey);
    validateFileEntry(path, tree[path]);

    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (pathSet.has(ancestor)) throw new Error(`Vault file/folder collision: ${ancestor}`);
    }
  }
}

export function validateVaultPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`Unsafe vault path: ${path}`);
  }
  if (path !== path.normalize("NFC")) throw new Error(`Vault path is not Unicode NFC: ${path}`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe vault path: ${path}`);
  }
  if (EXCLUDED_ROOTS.has(segments[0] as string)) throw new Error(`Excluded vault path: ${path}`);
  for (const segment of segments) {
    if (segment.endsWith(".") || segment.endsWith(" ") || /[<>:"|?*]/.test(segment)) {
      throw new Error(`Cross-platform unsafe vault path: ${path}`);
    }
    if (WINDOWS_RESERVED.test(segment)) throw new Error(`Windows-reserved vault path: ${path}`);
  }
}

function validateFileEntry(path: string, entry: RepositoryFileEntry | undefined): void {
  if (!entry || !SHA256.test(entry.blob)) throw new Error(`Invalid blob ID for ${path}.`);
  if (!Number.isInteger(entry.size) || entry.size < 0) throw new Error(`Invalid file size for ${path}.`);
  if (entry.kind !== "text" && entry.kind !== "binary") throw new Error(`Invalid file kind for ${path}.`);
  if (entry.pack !== undefined) {
    if (!PACK_PATH.test(entry.pack.path)) throw new Error(`Invalid blob pack path for ${path}.`);
    if (!Number.isSafeInteger(entry.pack.offset) || entry.pack.offset < 0) {
      throw new Error(`Invalid blob pack offset for ${path}.`);
    }
    if (!Number.isSafeInteger(entry.pack.length) || entry.pack.length !== entry.size) {
      throw new Error(`Invalid blob pack length for ${path}.`);
    }
  }
}
