export const REPOSITORY_METADATA_PATH = "repo.json";
export const HEAD_PATH = "refs/head.json";
export const HEAD_LOCK_PATH = "refs/head.lock";
export const HEAD_LOCK_OWNER_PATH = `${HEAD_LOCK_PATH}/owner.json`;
export const HEAD_LOCK_CANDIDATES_PATH = "refs/head-lock-candidates";

export function packPath(hash: string): string {
  assertHash(hash);
  return `packs/sha256/${hash.slice(0, 2)}/${hash}.pack`;
}

export function blobPath(hash: string): string {
  assertHash(hash);
  return `objects/sha256/${hash.slice(0, 2)}/${hash}`;
}

export function commitPath(commitId: string): string {
  assertHash(commitId);
  return `commits/${commitId}.json`;
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Expected a lowercase SHA-256 hex digest.");
  }
}
