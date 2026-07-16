import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./hash";
import type { CommitContent, StoredCommit } from "./types";
import { validateCommitContent } from "./validation";

export async function createStoredCommit(content: CommitContent): Promise<StoredCommit> {
  validateCommitContent(content);
  const commitId = await sha256Hex(canonicalJson(content));
  return { ...content, commitId };
}

export async function verifyStoredCommit(commit: StoredCommit): Promise<boolean> {
  const { commitId, ...content } = commit;
  validateCommitContent(content);
  return commitId === await sha256Hex(canonicalJson(content));
}
