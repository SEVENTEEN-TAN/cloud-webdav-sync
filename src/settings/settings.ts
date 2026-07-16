import type { InitialSyncPolicy } from "../sync";
import { isAllowedWebDavServerUrl } from "../webdav/url";

export const PASSWORD_SECRET_ID = "webdav-sync-password";

export interface WebDavSyncSettings {
  serverUrl: string;
  remoteRoot: string;
  username: string;
  autoSync: boolean;
  syncOnStartup: boolean;
  fileChangeDelayMs: number;
  remotePollMinutes: number;
  headUpdateMaxRetries: number;
  headUpdateRetryDelayMs: number;
  enableRealSync: boolean;
  transferConcurrency: number;
  initialSyncPolicy: InitialSyncPolicy;
  excludedFolders: string[];
}

export const DEFAULT_SETTINGS: Readonly<WebDavSyncSettings> = Object.freeze({
  serverUrl: "",
  remoteRoot: "obsidian-webdav-sync",
  username: "",
  autoSync: true,
  syncOnStartup: true,
  fileChangeDelayMs: 10_000,
  remotePollMinutes: 5,
  headUpdateMaxRetries: 3,
  headUpdateRetryDelayMs: 1_000,
  enableRealSync: false,
  transferConcurrency: 4,
  initialSyncPolicy: "stop",
  excludedFolders: [],
});

export function normalizeSettings(value: unknown): WebDavSyncSettings {
  const input = isRecord(value) ? value : {};
  return {
    serverUrl: readString(input.serverUrl, DEFAULT_SETTINGS.serverUrl),
    remoteRoot: readString(input.remoteRoot, DEFAULT_SETTINGS.remoteRoot),
    username: readString(input.username, DEFAULT_SETTINGS.username),
    autoSync: readBoolean(input.autoSync, DEFAULT_SETTINGS.autoSync),
    syncOnStartup: readBoolean(input.syncOnStartup, DEFAULT_SETTINGS.syncOnStartup),
    fileChangeDelayMs: readPositiveNumber(input.fileChangeDelayMs, DEFAULT_SETTINGS.fileChangeDelayMs),
    remotePollMinutes: readPositiveNumber(input.remotePollMinutes, DEFAULT_SETTINGS.remotePollMinutes),
    headUpdateMaxRetries: readBoundedInteger(input.headUpdateMaxRetries, DEFAULT_SETTINGS.headUpdateMaxRetries, 1, 20),
    headUpdateRetryDelayMs: readNonNegativeNumber(
      input.headUpdateRetryDelayMs,
      DEFAULT_SETTINGS.headUpdateRetryDelayMs,
    ),
    enableRealSync: readBoolean(input.enableRealSync, DEFAULT_SETTINGS.enableRealSync),
    transferConcurrency: readTransferConcurrency(input.transferConcurrency),
    initialSyncPolicy: readInitialSyncPolicy(input.initialSyncPolicy),
    excludedFolders: readExcludedFolders(input.excludedFolders),
  };
}

export function isPathInExcludedFolders(path: string, excludedFolders: readonly string[]): boolean {
  return excludedFolders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

export function hasConnectionSettings(settings: WebDavSyncSettings, password: string | null): boolean {
  return Boolean(
    isAllowedWebDavServerUrl(settings.serverUrl.trim()) &&
      settings.remoteRoot.trim() &&
      settings.username.trim() &&
      !settings.username.includes(":") &&
      password,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback;
  if ((value as number) < minimum) return fallback;
  return Math.min(value as number, maximum);
}

function readTransferConcurrency(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) return DEFAULT_SETTINGS.transferConcurrency;
  return Math.min(value as number, 16);
}

function readInitialSyncPolicy(value: unknown): InitialSyncPolicy {
  return value === "prefer-local" || value === "prefer-remote" ? value : "stop";
}

function readExcludedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.excludedFolders];
  const folders = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const folder = normalizeFolderPath(item);
    if (folder) folders.add(folder);
  }
  return [...folders];
}

function normalizeFolderPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC");
  if (!normalized || normalized.includes("//")) return null;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}
