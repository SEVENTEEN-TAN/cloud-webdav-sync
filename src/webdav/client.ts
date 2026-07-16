import { createBasicAuthHeader } from "./auth";
import type {
  CapabilityProbeResult,
  WebDavCapabilities,
  WebDavCredentials,
  WebDavErrorInfo,
  WebDavResponse,
  WebDavTransport,
} from "./types";
import { isAllowedWebDavServerUrl, joinWebDavUrl } from "./url";

export interface WebDavClientConfig {
  serverUrl: string;
  remoteRoot: string;
  credentials: WebDavCredentials;
}

export class WebDavClient {
  constructor(
    private readonly config: WebDavClientConfig,
    private readonly transport: WebDavTransport,
  ) {
    if (!isAllowedWebDavServerUrl(config.serverUrl)) {
      throw new Error("WebDAV requires HTTPS, except for localhost development URLs.");
    }
    if (config.credentials.username.includes(":")) {
      throw new Error("Basic Auth usernames cannot contain a colon.");
    }
  }

  get(relativePath: string): Promise<WebDavResponse> {
    return this.request(relativePath, "GET");
  }

  head(relativePath: string): Promise<WebDavResponse> {
    return this.request(relativePath, "HEAD");
  }

  put(
    relativePath: string,
    body: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    return this.request(relativePath, "PUT", body, headers);
  }

  remove(relativePath: string, headers: Record<string, string> = {}): Promise<WebDavResponse> {
    return this.request(relativePath, "DELETE", undefined, headers);
  }

  makeCollection(relativePath: string): Promise<WebDavResponse> {
    return this.request(relativePath, "MKCOL");
  }

  move(
    sourcePath: string,
    destinationPath: string,
    overwrite = false,
  ): Promise<WebDavResponse> {
    return this.request(sourcePath, "MOVE", undefined, {
      Destination: joinWebDavUrl(
        this.config.serverUrl,
        this.config.remoteRoot,
        destinationPath,
      ),
      Overwrite: overwrite ? "T" : "F",
    });
  }

  async ensureRemoteRoot(): Promise<void> {
    const segments = this.config.remoteRoot.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = await this.requestFromServerRoot(current, "HEAD");
      if (isSuccessful(existing.status)) continue;
      if (existing.status !== 404) {
        throw new Error(`检查远程目录 ${current} 时，WebDAV 返回了 HTTP ${existing.status}。`);
      }

      const created = await this.requestFromServerRoot(current, "MKCOL");
      if (created.status === 201) continue;
      if (created.status === 405 || created.status === 423) {
        const afterContention = await this.requestFromServerRoot(current, "HEAD");
        if (isSuccessful(afterContention.status)) continue;
      }
      throw new Error(`无法创建远程目录 ${current}：WebDAV 返回了 HTTP ${created.status}。`);
    }
  }

  async probeCapabilities(): Promise<CapabilityProbeResult> {
    const capabilities = emptyCapabilities();
    const probeId = `probe-${crypto.randomUUID()}`;
    const probeFile = `${probeId}/etag-test.txt`;
    const lockProbePath = `${probeId}/head-lock-test`;
    const moveProbeTarget = `${probeId}/move-lock-target.txt`;
    let collectionAttempted = false;

    try {
      let options = await this.request("", "OPTIONS");
      if (options.status === 404) {
        await this.ensureRemoteRoot();
        options = await this.request("", "OPTIONS");
      }
      assertStatus(options, [200, 204], "OPTIONS_FAILED");
      capabilities.reachable = true;
      capabilities.webDavClass = getHeader(options, "dav");

      collectionAttempted = true;
      let mkcol = await this.request(probeId, "MKCOL");
      if (mkcol.status === 409) {
        await this.ensureRemoteRoot();
        mkcol = await this.request(probeId, "MKCOL");
      }
      assertStatus(mkcol, [201], "MKCOL_FAILED");

      const originalContent = "obsidian-webdav-probe-v1";
      const replacementContent = "obsidian-webdav-probe-create-race";
      const initialPut = await this.request(
        probeFile,
        "PUT",
        originalContent,
        { "If-None-Match": "*" },
      );
      assertStatus(initialPut, [200, 201, 204], "PUT_FAILED");

      const duplicateCreate = await this.request(
        probeFile,
        "PUT",
        replacementContent,
        { "If-None-Match": "*" },
      );
      const storedAfterDuplicate = await this.request(probeFile, "GET");
      capabilities.conditionalCreate =
        duplicateCreate.status === 412 &&
        isSuccessful(storedAfterDuplicate.status) &&
        storedAfterDuplicate.text === originalContent;
      if (!capabilities.conditionalCreate) {
        capabilities.warnings.push(
          `The server did not safely enforce If-None-Match: * (HTTP ${duplicateCreate.status}).`,
        );
      }

      const initialEtag = await this.getEtag(probeFile);
      capabilities.strongEtag = Boolean(initialEtag && !initialEtag.startsWith("W/"));
      if (!initialEtag) {
        capabilities.warnings.push("The server did not expose an ETag for uploaded files.");
      } else if (!capabilities.strongEtag) {
        capabilities.warnings.push("The server only exposed a weak ETag.");
      }

      if (initialEtag) {
        const conditionalPut = await this.request(
          probeFile,
          "PUT",
          "obsidian-webdav-probe-v2",
          { "If-Match": initialEtag },
        );
        capabilities.conditionalUpdate = isSuccessful(conditionalPut.status);
        if (!capabilities.conditionalUpdate) {
          capabilities.warnings.push(`Conditional update returned HTTP ${conditionalPut.status}.`);
        } else {
          const stalePut = await this.request(
            probeFile,
            "PUT",
            "obsidian-webdav-probe-stale",
            { "If-Match": initialEtag },
          );
          capabilities.staleEtagRejected = stalePut.status === 412;

          if (!capabilities.staleEtagRejected) {
            capabilities.warnings.push(
              `The server accepted a stale ETag update with HTTP ${stalePut.status}.`,
            );
          }
        }
      }

      const lockAttempts = await Promise.all(
        Array.from({ length: 4 }, () => this.request(lockProbePath, "MKCOL")),
      );
      capabilities.atomicCollectionCreate =
        lockAttempts.filter(({ status }) => status === 201).length === 1 &&
        lockAttempts.filter(({ status }) => isSuccessful(status)).length === 1 &&
        lockAttempts.every(({ status }) => status === 201 || status === 405 || status === 423);
      if (!capabilities.atomicCollectionCreate) {
        capabilities.warnings.push(
          `Concurrent MKCOL did not prove exclusive lock creation (${lockAttempts.map(({ status }) => status).join(", ")}).`,
        );
      }

      const moveCandidates = Array.from({ length: 4 }, (_, index) => ({
        path: `${probeId}/move-lock-candidate-${index}.txt`,
        content: `obsidian-webdav-probe-move-candidate-${index}`,
      }));
      const candidateWrites = await Promise.all(
        moveCandidates.map(({ path, content }) => this.put(path, content)),
      );
      for (const candidateWrite of candidateWrites) {
        assertStatus(candidateWrite, [200, 201, 204], "PUT_FAILED");
      }

      const moveAttempts = await Promise.all(
        moveCandidates.map(({ path }) => this.move(path, moveProbeTarget, false)),
      );
      const storedMoveTarget = await this.get(moveProbeTarget);
      const successfulMoveIndexes = moveAttempts.flatMap(({ status }, index) =>
        isSuccessful(status) ? [index] : [],
      );
      capabilities.atomicMoveNoOverwrite =
        successfulMoveIndexes.length === 1 &&
        isSuccessful(storedMoveTarget.status) &&
        storedMoveTarget.text === moveCandidates[successfulMoveIndexes[0]!]?.content;
      if (!capabilities.atomicMoveNoOverwrite) {
        capabilities.warnings.push(
          `Concurrent MOVE with Overwrite: F did not prove exclusive destination creation (${moveAttempts.map(({ status }) => status).join(", ")}).`,
        );
      }

      capabilities.headUpdateStrategy = selectHeadUpdateStrategy(capabilities);
      capabilities.safeConcurrentWrites = capabilities.headUpdateStrategy !== null;

      return { ok: true, capabilities };
    } catch (error) {
      return { ok: false, capabilities, error: normalizeError(error) };
    } finally {
      if (collectionAttempted) {
        try {
          const cleanup = await this.request(probeId, "DELETE");
          capabilities.cleanupSucceeded = [200, 204, 404].includes(cleanup.status);
        } catch {
          capabilities.cleanupSucceeded = false;
        }
        if (!capabilities.cleanupSucceeded) {
          capabilities.warnings.push(`Could not remove the temporary capability probe ${probeId}.`);
        }
      }
    }
  }

  async getEtag(path: string): Promise<string | null> {
    const head = await this.request(path, "HEAD");
    if (isSuccessful(head.status)) {
      const etag = getHeader(head, "etag");
      if (etag) return etag;
    }

    const propfind = await this.request(
      path,
      "PROPFIND",
      '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
      { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    );
    if (!isSuccessful(propfind.status) && propfind.status !== 207) return null;
    return extractEtag(propfind.text);
  }

  private request(
    relativePath: string,
    method: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    return this.transport.request({
      url: joinWebDavUrl(this.config.serverUrl, this.config.remoteRoot, relativePath),
      method,
      body,
      headers: {
        Authorization: createBasicAuthHeader(this.config.credentials),
        ...headers,
      },
    });
  }

  private requestFromServerRoot(
    relativePath: string,
    method: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    return this.transport.request({
      url: joinWebDavUrl(this.config.serverUrl, "", relativePath),
      method,
      body,
      headers: {
        Authorization: createBasicAuthHeader(this.config.credentials),
        ...headers,
      },
    });
  }
}

function emptyCapabilities(): WebDavCapabilities {
  return {
    reachable: false,
    webDavClass: null,
    conditionalCreate: false,
    strongEtag: false,
    conditionalUpdate: false,
    staleEtagRejected: false,
    atomicMoveNoOverwrite: false,
    atomicCollectionCreate: false,
    headUpdateStrategy: null,
    safeConcurrentWrites: false,
    cleanupSucceeded: true,
    warnings: [],
  };
}

function selectHeadUpdateStrategy(capabilities: WebDavCapabilities): WebDavCapabilities["headUpdateStrategy"] {
  if (
    capabilities.conditionalCreate &&
    capabilities.strongEtag &&
    capabilities.conditionalUpdate &&
    capabilities.staleEtagRejected
  ) {
    return "etag";
  }
  if (capabilities.strongEtag && capabilities.atomicMoveNoOverwrite) {
    return "move-lock";
  }
  if (
    capabilities.conditionalCreate &&
    capabilities.strongEtag &&
    capabilities.atomicCollectionCreate
  ) {
    return "mkcol-lock";
  }
  return null;
}

function getHeader(response: WebDavResponse, name: string): string | null {
  const entry = Object.entries(response.headers).find(
    ([header]) => header.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1] ?? null;
}

function extractEtag(xml: string): string | null {
  const match = xml.match(/<(?:[^:>]+:)?getetag[^>]*>([^<]+)<\//i);
  return match?.[1] ? decodeXmlEntities(match[1].trim()) : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function assertStatus(response: WebDavResponse, expected: number[], code: string): void {
  if (expected.includes(response.status)) return;
  throw new WebDavRequestError(code, response.status);
}

class WebDavRequestError extends Error implements WebDavErrorInfo {
  readonly retryable: boolean;

  constructor(readonly code: string, readonly status: number) {
    super(`WebDAV request failed with HTTP ${status}.`);
    this.name = "WebDavRequestError";
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

function normalizeError(error: unknown): WebDavErrorInfo {
  if (isWebDavErrorInfo(error)) return error;
  return {
    code: "NETWORK_ERROR",
    message: error instanceof Error ? error.message : "Unknown WebDAV error.",
    retryable: true,
  };
}

function isWebDavErrorInfo(error: unknown): error is WebDavErrorInfo {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<WebDavErrorInfo>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}
