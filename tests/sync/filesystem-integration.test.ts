import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

import {
  ContentAddressedRepository,
  sha256Hex,
  type RepositoryRemote,
  type RepositoryTree,
} from "../../src/repository";
import {
  RepositorySyncEngine,
  type LocalWorkspace,
  type SyncSessionState,
} from "../../src/sync";
import type { WebDavResponse } from "../../src/webdav";

class MemoryRemote implements RepositoryRemote {
  private readonly resources = new Map<string, { body: string | ArrayBuffer; etag: string }>();
  private readonly collections = new Set<string>();
  private version = 0;

  async get(path: string): Promise<WebDavResponse> {
    const value = this.resources.get(path);
    return value ? response(200, { ETag: value.etag }, value.body) : response(404);
  }

  async getEtag(path: string): Promise<string | null> {
    return this.resources.get(path)?.etag ?? null;
  }

  async head(path: string): Promise<WebDavResponse> {
    const value = this.resources.get(path);
    if (value) return response(200, { ETag: value.etag });
    return response(this.collections.has(path) ? 200 : 404);
  }

  async put(
    path: string,
    body: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<WebDavResponse> {
    const current = this.resources.get(path);
    if (headers["If-None-Match"] === "*" && current) return response(412);
    if (headers["If-Match"] && headers["If-Match"] !== current?.etag) return response(412);
    const etag = `"${++this.version}"`;
    this.resources.set(path, { body: copy(body), etag });
    return response(current ? 204 : 201, { ETag: etag });
  }

  async move(sourcePath: string, destinationPath: string, overwrite = true): Promise<WebDavResponse> {
    const source = this.resources.get(sourcePath);
    if (!source) return response(404);
    if (!overwrite && this.resources.has(destinationPath)) return response(423);
    this.resources.set(destinationPath, source);
    this.resources.delete(sourcePath);
    return response(201, { ETag: source.etag });
  }

  async remove(path: string): Promise<WebDavResponse> {
    for (const key of [...this.resources.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.resources.delete(key);
    }
    for (const key of [...this.collections]) {
      if (key === path || key.startsWith(`${path}/`)) this.collections.delete(key);
    }
    return response(204);
  }

  async makeCollection(path: string): Promise<WebDavResponse> {
    if (this.collections.has(path)) return response(405);
    this.collections.add(path);
    return response(201);
  }
}

class DiskWorkspace implements LocalWorkspace {
  constructor(private readonly root: string) {}

  async scan(): Promise<RepositoryTree> {
    const tree: RepositoryTree = {};
    await this.walk(this.root, tree);
    return tree;
  }

  async read(path: string): Promise<ArrayBuffer> {
    return toArrayBuffer(await readFile(this.absolute(path)));
  }

  async write(
    path: string,
    data: ArrayBuffer,
    _kind: "text" | "binary",
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void> {
    const absolute = this.absolute(path);
    const current = await readFileIfPresent(absolute);
    if (current && expectedCurrent === null) throw new Error(`Unexpected existing file ${path}`);
    if (!current && expectedCurrent !== null) throw new Error(`Missing expected file ${path}`);
    if (current && expectedCurrent && !equalBytes(toArrayBuffer(current), expectedCurrent)) {
      throw new Error(`File changed during write ${path}`);
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, new Uint8Array(data));
  }

  async remove(path: string, expectedCurrent: ArrayBuffer): Promise<void> {
    const absolute = this.absolute(path);
    const current = await readFile(absolute);
    if (!equalBytes(toArrayBuffer(current), expectedCurrent)) {
      throw new Error(`File changed during delete ${path}`);
    }
    await rm(absolute);
  }

  async removeEmptyFolder(path: string): Promise<void> {
    try {
      await rmdir(this.absolute(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async walk(directory: string, tree: RepositoryTree): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await this.walk(absolute, tree);
      else if (entry.isFile()) {
        const data = toArrayBuffer(await readFile(absolute));
        const path = relative(this.root, absolute).split(sep).join("/");
        tree[path] = {
          blob: await sha256Hex(data),
          size: data.byteLength,
          kind: path.toLowerCase().endsWith(".md") ? "text" : "binary",
        };
      }
    }
  }

  private absolute(path: string): string {
    return join(this.root, ...path.split("/"));
  }
}

test("synchronizes real Windows file-to-folder and folder-to-file transitions", async () => {
  const parent = await mkdtemp(join(tmpdir(), "obsidian-webdav-fs-"));
  const sourceRoot = join(parent, "source");
  const targetRoot = join(parent, "target");
  await mkdir(sourceRoot);
  await mkdir(targetRoot);

  try {
    await writeFile(join(sourceRoot, "a"), "base file");
    const remote = new MemoryRemote();
    const sourceWorkspace = new DiskWorkspace(sourceRoot);
    const targetWorkspace = new DiskWorkspace(targetRoot);
    const source = new RepositorySyncEngine(
      new ContentAddressedRepository(remote),
      sourceWorkspace,
      { concurrency: 2 },
    );
    const target = new RepositorySyncEngine(
      new ContentAddressedRepository(remote),
      targetWorkspace,
      { concurrency: 2 },
    );
    let sourceState = (await source.sync(initialState("source"))).state;
    let targetState = (await target.sync(initialState("target"))).state;
    assert.equal((await stat(join(targetRoot, "a"))).isFile(), true);

    await rm(join(sourceRoot, "a"));
    await mkdir(join(sourceRoot, "a"));
    await writeFile(join(sourceRoot, "a", "note.md"), "nested note");
    sourceState = (await source.sync(sourceState)).state;
    targetState = (await target.sync(targetState)).state;
    assert.equal((await stat(join(targetRoot, "a"))).isDirectory(), true);
    assert.equal(await readFile(join(targetRoot, "a", "note.md"), "utf8"), "nested note");

    await rm(join(sourceRoot, "a"), { recursive: true });
    await writeFile(join(sourceRoot, "a"), "replacement file");
    sourceState = (await source.sync(sourceState)).state;
    targetState = (await target.sync(targetState)).state;
    assert.equal((await stat(join(targetRoot, "a"))).isFile(), true);
    assert.equal(await readFile(join(targetRoot, "a"), "utf8"), "replacement file");
    assert.deepEqual(await targetWorkspace.scan(), await sourceWorkspace.scan());
    assert.equal(targetState.baseCommitId, sourceState.baseCommitId);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function initialState(deviceId: string): SyncSessionState {
  return { baseCommitId: null, deviceId, repositoryId: null };
}

async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EISDIR") return null;
    throw error;
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  return left.byteLength === right.byteLength &&
    new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body: string | ArrayBuffer = "",
): WebDavResponse {
  const arrayBuffer = typeof body === "string" ? new TextEncoder().encode(body).buffer : body.slice(0);
  return { status, headers, text: typeof body === "string" ? body : new TextDecoder().decode(body), arrayBuffer };
}

function copy(body: string | ArrayBuffer): string | ArrayBuffer {
  return typeof body === "string" ? body : body.slice(0);
}
