import { TFile, TFolder, type FileManager, type Vault } from "obsidian";
import { mapLimitWeighted } from "../concurrency";
import { sha256Hex, type RepositoryTree } from "../repository";
import type { LocalWorkspace, ScanProgressReporter } from "../sync/repository-sync-engine";

export class ObsidianWorkspace implements LocalWorkspace {
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
    private readonly shouldTrack: (path: string) => boolean,
    private readonly concurrency = 4,
    private readonly onMutation: (path: string, active: boolean) => void = () => undefined,
    private readonly maxInFlightBytes = 256 * 1_024 * 1_024,
  ) {}

  async scan(onProgress?: ScanProgressReporter): Promise<RepositoryTree> {
    const files = this.vault.getFiles().filter((file) => this.shouldTrack(file.path));
    let completed = 0;
    onProgress?.(completed, files.length);
    const entries = await mapLimitWeighted(
      files,
      this.concurrency,
      this.maxInFlightBytes,
      (file) => file.stat.size,
      async (file) => {
        const data = await this.vault.readBinary(file);
        const entry = [file.path, {
          blob: await sha256Hex(data),
          size: data.byteLength,
          kind: isMarkdown(file.path) ? "text" as const : "binary" as const,
        }] as const;
        completed += 1;
        onProgress?.(completed, files.length);
        return entry;
      },
    );
    return Object.fromEntries(entries);
  }

  async read(path: string): Promise<ArrayBuffer> {
    this.assertTracked(path);
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Local file ${path} does not exist.`);
    return this.vault.readBinary(file);
  }

  async write(
    path: string,
    data: ArrayBuffer,
    kind: "text" | "binary",
    expectedCurrent: ArrayBuffer | null,
  ): Promise<void> {
    this.assertTracked(path);
    this.onMutation(path, true);
    try {
      await this.ensureParentFolders(path);
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFile)) {
        throw new Error(`Cannot write ${path} because a folder exists at that path.`);
      }
      if (existing && expectedCurrent === null) {
        throw new Error(`Local file ${path} appeared while synchronization was running.`);
      }
      if (!existing && expectedCurrent !== null) {
        throw new Error(`Local file ${path} disappeared while synchronization was running.`);
      }
      if (!existing) {
        await this.vault.createBinary(path, data);
        return;
      }
      if (kind === "text") {
        const content = new TextDecoder().decode(data);
        const expectedText = new TextDecoder().decode(expectedCurrent as ArrayBuffer);
        await this.vault.process(existing, (current) => {
          if (current !== expectedText) {
            throw new Error(`Local file ${path} changed while synchronization was running.`);
          }
          return content;
        });
      } else {
        const current = await this.vault.readBinary(existing);
        if (!equalBytes(current, expectedCurrent as ArrayBuffer)) {
          throw new Error(`Local file ${path} changed while synchronization was running.`);
        }
        await this.vault.modifyBinary(existing, data);
      }
    } finally {
      this.onMutation(path, false);
    }
  }

  async remove(path: string, expectedCurrent: ArrayBuffer): Promise<void> {
    this.assertTracked(path);
    this.onMutation(path, true);
    try {
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        throw new Error(`Local file ${path} disappeared while synchronization was running.`);
      }
      const current = await this.vault.readBinary(file);
      if (!equalBytes(current, expectedCurrent)) {
        throw new Error(`Local file ${path} changed while synchronization was applying a delete.`);
      }
      await this.fileManager.trashFile(file);
    } finally {
      this.onMutation(path, false);
    }
  }

  async removeEmptyFolder(path: string): Promise<void> {
    this.assertTracked(path);
    this.onMutation(path, true);
    try {
      const folder = this.vault.getAbstractFileByPath(path);
      if (!folder) return;
      if (!(folder instanceof TFolder)) {
        throw new Error(`Cannot replace ${path} with a file because it is no longer a folder.`);
      }
      if (folder.children.length > 0) {
        throw new Error(`Cannot replace non-empty folder ${path} with a file.`);
      }
      await this.fileManager.trashFile(folder);
    } finally {
      this.onMutation(path, false);
    }
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`Cannot create folder ${current} because a file exists at that path.`);
      }
      if (!existing) {
        try {
          await this.vault.createFolder(current);
        } catch {
          if (!this.vault.getAbstractFileByPath(current)) throw new Error(`Could not create folder ${current}.`);
        }
      }
    }
  }

  private assertTracked(path: string): void {
    if (!this.shouldTrack(path)) throw new Error(`Refusing to access excluded vault path: ${path}`);
  }
}

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}
