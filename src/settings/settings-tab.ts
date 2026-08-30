import {
  App,
  ConfirmationModal,
  Notice,
  Plugin,
  PluginSettingTab,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";
import type { WebDavSyncSettings } from "./settings";

export interface SettingsController {
  readonly settings: WebDavSyncSettings;
  getPassword(): string | null;
  savePassword(password: string): Promise<void>;
  clearPassword(): Promise<void>;
  testConnection(): Promise<string>;
  updateSettings(patch: Partial<WebDavSyncSettings>): Promise<void>;
  resetSyncState(): Promise<void>;
  clearRemoteLock(): Promise<void>;
}

export class WebDavSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly owner: Plugin & SettingsController) {
    super(app, owner);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        heading: "WebDAV 同步",
        items: this.getConnectionSettingDefinitions(),
      },
      {
        type: "group",
        heading: "自动同步",
        items: this.getAutomationSettingDefinitions(),
      },
    ];
  }

  private getConnectionSettingDefinitions(): SettingDefinition[] {
    return settingDefinitions([
      {
        name: "服务器 URL",
        desc: "WebDAV 服务端点的 HTTPS 地址。",
        aliases: ["WebDAV", "服务器", "URL"],
        render: (setting) => setting.addText((text) => text
          .setPlaceholder("https://dav.example.com/remote.php/dav/files/user")
          .setValue(this.owner.settings.serverUrl)
          .onChange((value) => this.saveSetting({ serverUrl: value.trim() }))),
      },
      {
        name: "远程文件夹",
        desc: "专用于同步当前知识库的远程文件夹。",
        aliases: ["路径", "目录"],
        render: (setting) => setting.addText((text) => text
          .setValue(this.owner.settings.remoteRoot)
          .onChange((value) => this.saveSetting({ remoteRoot: value.trim() }))),
      },
      {
        name: "用户名",
        aliases: ["账户", "账号"],
        render: (setting) => setting.addText((text) => text
          .setValue(this.owner.settings.username)
          .onChange((value) => this.saveSetting({ username: value }))),
      },
      {
        name: "密码或应用专用密码",
        desc: this.owner.getPassword()
          ? "已在 Obsidian SecretStorage（安全凭据存储）中配置密码。仅在需要替换密码时输入新值。"
          : "密码将保存在 Obsidian SecretStorage（安全凭据存储）中，而不会写入插件的 data.json。",
        aliases: ["密码", "SecretStorage", "凭据"],
        render: (setting) => this.renderPasswordSetting(setting),
      },
      {
        name: "测试连接",
        desc: "通过临时文件探测 ETag（实体标签）和条件写入能力。",
        aliases: ["连接", "能力检测"],
        render: (setting) => setting.addButton((button) => button.setButtonText("测试").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("正在测试…");
          try {
            new Notice(await this.owner.testConnection(), 8_000);
          } catch (error) {
            new Notice(`连接测试失败：${formatError(error)}`, 10_000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("测试");
          }
        })),
      },
      {
        name: "忘记仓库绑定",
        desc: "清除本地仓库标识和基准提交标识，但不会删除知识库或 WebDAV 中的文件。",
        aliases: ["重置", "仓库"],
        render: (setting) => setting.addButton((button) => button
          .setButtonText("忘记绑定")
          .setDestructive()
          .onClick(async () => {
            if (!(await confirmAction(this.app, "忘记仓库绑定", "确定要忘记此设备的 WebDAV 仓库绑定吗？", "忘记绑定"))) return;
            await this.owner.resetSyncState();
            new Notice("已清除本地 WebDAV 仓库绑定。");
          })),
      },
      {
        name: "清除远程同步锁",
        desc: "仅用于紧急恢复。清除遗留的远程锁之前，请先关闭其他所有设备上的 Obsidian。",
        aliases: ["锁", "恢复"],
        render: (setting) => setting.addButton((button) => button
          .setButtonText("清除锁")
          .setDestructive()
          .onClick(async () => {
            if (!(await confirmAction(
              this.app,
              "清除远程同步锁",
              "确定要清除远程 WebDAV 同步锁吗？请仅在其他所有设备均已停止同步后继续。",
              "清除锁",
            ))) return;
            try {
              await this.owner.clearRemoteLock();
              new Notice("已清除远程 WebDAV 同步锁。");
            } catch (error) {
              new Notice(`无法清除远程同步锁：${formatError(error)}`, 10_000);
            }
          })),
      },
    ]);
  }

  private getAutomationSettingDefinitions(): SettingDefinition[] {
    return settingDefinitions([
      {
        name: "启用自动同步",
        desc: "在 Obsidian 运行期间自动检查同步状态。",
        aliases: ["自动同步"],
        render: (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.owner.settings.autoSync)
          .onChange((value) => this.saveSetting({ autoSync: value }))),
      },
      {
        name: "启动时同步",
        aliases: ["启动", "自动同步"],
        render: (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.owner.settings.syncOnStartup)
          .onChange((value) => this.saveSetting({ syncOnStartup: value }))),
      },
      {
        name: "文件变更延迟",
        desc: "检测到最近一次本地文件变更后，等待多少秒再开始同步。",
        aliases: ["延迟", "防抖"],
        render: (setting) => setting.addText((text) => text
          .setValue(String(this.owner.settings.fileChangeDelayMs / 1_000))
          .onChange((value) => {
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds > 0) {
              this.saveSetting({ fileChangeDelayMs: seconds * 1_000 });
            }
          })),
      },
      {
        name: "远程轮询间隔",
        desc: "Obsidian 运行期间，两次轻量级远程检查之间的间隔分钟数。",
        aliases: ["轮询", "间隔"],
        render: (setting) => setting.addText((text) => text
          .setValue(String(this.owner.settings.remotePollMinutes))
          .onChange((value) => {
            const minutes = Number(value);
            if (Number.isFinite(minutes) && minutes > 0) {
              this.saveSetting({ remotePollMinutes: minutes });
            }
          })),
      },
      {
        name: "远程 HEAD 最大重试次数",
        desc: "首次尝试后，远程 HEAD 或同步锁发生竞争时最多重新规划并重试多少次（0～20）。",
        aliases: ["HEAD", "重试"],
        render: (setting) => setting.addText((text) => text
          .setValue(String(this.owner.settings.headUpdateMaxRetries))
          .onChange((value) => {
            const retries = Number(value);
            if (Number.isInteger(retries) && retries >= 0 && retries <= 20) {
              this.saveSetting({ headUpdateMaxRetries: retries });
            }
          })),
      },
      {
        name: "远程 HEAD 重试间隔",
        desc: "两次远程 HEAD 重试之间等待多少秒。设为 0 可立即重试。",
        aliases: ["HEAD", "重试", "间隔"],
        render: (setting) => setting.addText((text) => text
          .setValue(String(this.owner.settings.headUpdateRetryDelayMs / 1_000))
          .onChange((value) => {
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds >= 0) {
              this.saveSetting({ headUpdateRetryDelayMs: seconds * 1_000 });
            }
          })),
      },
      {
        name: "启用实际同步",
        desc: "实验性功能：允许上传和下载仓库内容、将删除的文件安全移至 .trash，以及自动合并无冲突的 Markdown。",
        aliases: ["实际同步", "上传", "下载"],
        render: (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.owner.settings.enableRealSync)
          .onChange((value) => this.saveSetting({ enableRealSync: value }))),
      },
      {
        name: "传输并发数",
        desc: "同时进行哈希计算、上传或下载的最大文件数（1～16）。",
        aliases: ["并发", "传输"],
        render: (setting) => setting.addText((text) => text
          .setValue(String(this.owner.settings.transferConcurrency))
          .onChange((value) => {
            const concurrency = Number(value);
            if (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16) {
              this.saveSetting({ transferConcurrency: concurrency });
            }
          })),
      },
      {
        name: "排除目录",
        desc: "每行一个目录。目录中的文件不会加入待同步列表，也不会上传或下载。",
        aliases: ["排除", "忽略", "目录"],
        render: (setting) => setting.addTextArea((text) => {
          text.inputEl.rows = 5;
          text.setPlaceholder("例如：\n附件缓存\n临时文件/导出");
          text.setValue(this.owner.settings.excludedFolders.join("\n"));
          text.onChange((value) => this.saveSetting({
            excludedFolders: value.split("\n").map((line) => line.trim()),
          }));
        }),
      },
      {
        name: "首次同步时两端均有文件",
        desc: "安全的默认策略是停止同步。优先本地会基于远程历史创建新提交；优先远程会在完成删除检查后替换本地文件。",
        aliases: ["首次同步", "优先本地", "优先远程"],
        render: (setting) => setting.addDropdown((dropdown) => dropdown
          .addOption("stop", "停止同步并显示冲突")
          .addOption("prefer-remote", "使用远程文件树")
          .addOption("prefer-local", "提交本地文件树")
          .setValue(this.owner.settings.initialSyncPolicy)
          .onChange((value) => this.saveSetting({
            initialSyncPolicy: value as WebDavSyncSettings["initialSyncPolicy"],
          }))),
      },
    ]);
  }

  private renderPasswordSetting(setting: Setting): Setting {
    const passwordConfigured = Boolean(this.owner.getPassword());
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder(passwordConfigured ? "已配置密码" : "请输入密码");
      text.setValue("");
      text.onChange((value) => {
        if (!value) return;
        void this.owner.savePassword(value).catch((error: unknown) => {
          new Notice(`无法保存密码：${formatError(error)}`);
        });
      });
    });
    setting.addButton((button) => button
      .setButtonText("清除")
      .setDestructive()
      .setDisabled(!passwordConfigured)
      .onClick(async () => {
        if (!(await confirmAction(this.app, "清除已保存的 WebDAV 密码", "确定要清除已保存的 WebDAV 密码吗？", "清除"))) return;
        try {
          await this.owner.clearPassword();
          this.update();
          new Notice("已清除保存的 WebDAV 密码。");
        } catch (error) {
          new Notice(`无法清除密码：${formatError(error)}`);
        }
      }));
    return setting;
  }

  private saveSetting(patch: Partial<WebDavSyncSettings>): void {
    void this.owner.updateSettings(patch).catch((error: unknown) => {
      new Notice(`无法保存设置：${formatError(error)}`);
    });
  }
}

function settingDefinitions(
  definitions: Array<Omit<Extract<SettingDefinition, { render: unknown }>, "render"> & {
    render: (setting: Setting) => unknown;
  }>,
): SettingDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    render: (setting) => {
      definition.render(setting);
    },
  }));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function confirmAction(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new ConfirmationModal(app)
      .setTitle(title)
      .setContent(message)
      .addCancelButton("取消")
      .addButton((button) => button
        .setButtonText(confirmText)
        .setDestructive()
        .onClick(() => {
          settled = true;
          resolve(true);
        }));
    modal.setCloseCallback(() => {
      if (!settled) resolve(false);
    });
    modal.open();
  });
}
