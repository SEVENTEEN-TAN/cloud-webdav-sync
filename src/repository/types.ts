import type { HeadUpdateStrategy, WebDavResponse } from "../webdav";

export interface RepositoryRemote {
  get(path: string): Promise<WebDavResponse>;
  getEtag(path: string): Promise<string | null>;
  head(path: string): Promise<WebDavResponse>;
  put(path: string, body: string | ArrayBuffer, headers?: Record<string, string>): Promise<WebDavResponse>;
  move(sourcePath: string, destinationPath: string, overwrite?: boolean): Promise<WebDavResponse>;
  remove(path: string, headers?: Record<string, string>): Promise<WebDavResponse>;
  makeCollection(path: string): Promise<WebDavResponse>;
}

export interface RepositoryMetadata {
  formatVersion: 1;
  repositoryId: string;
  hashAlgorithm: "sha256";
  createdAt: string;
}

export interface RepositoryOptions {
  headUpdateStrategy?: Exclude<HeadUpdateStrategy, null>;
  conditionalCreate?: boolean;
  lockLeaseMs?: number;
  lockOwnerId?: string;
  now?: () => Date;
  enableBlobPacks?: boolean;
  maxPackedBlobBytes?: number;
  maxBlobPackBytes?: number;
}

export interface RepositoryBlobPackLocation {
  path: string;
  offset: number;
  length: number;
}

export interface RepositoryFileEntry {
  blob: string;
  size: number;
  kind: "text" | "binary";
  pack?: RepositoryBlobPackLocation;
}

export type RepositoryTree = Record<string, RepositoryFileEntry>;

export interface CommitContent {
  formatVersion: 1;
  repositoryId: string;
  parents: string[];
  deviceId: string;
  createdAt: string;
  files: RepositoryTree;
}

export interface StoredCommit extends CommitContent {
  commitId: string;
}

export interface HeadReference {
  commit: string | null;
  generation: number;
}

export interface HeadSnapshot {
  reference: HeadReference;
  etag: string;
}

export type HeadUpdateResult =
  | { updated: true }
  | { updated: false; reason: "conflict" };
