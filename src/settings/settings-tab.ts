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
import { t } from "../i18n";
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
        heading: t("settings.group.connection"),
        items: this.getConnectionSettingDefinitions(),
      },
      {
        type: "group",
        heading: t("settings.group.automation"),
        items: this.getAutomationSettingDefinitions(),
      },
      {
        type: "group",
        heading: t("settings.group.interface"),
        items: this.getInterfaceSettingDefinitions(),
      },
    ];
  }

  private getConnectionSettingDefinitions(): SettingDefinition[] {
    return settingDefinitions([
      {
        name: t("settings.serverUrl.name"),
        desc: t("settings.serverUrl.desc"),
        aliases: ["WebDAV", "server", "URL", "服务器"],
        render: (setting) => setting.addText((text) => text
          .setPlaceholder("https://dav.example.com/remote.php/dav/files/user")
          .setValue(this.owner.settings.serverUrl)
          .onChange((value) => this.saveSetting({ serverUrl: value.trim() }))),
      },
      {
        name: t("settings.remoteRoot.name"),
        desc: t("settings.remoteRoot.desc"),
        aliases: ["path", "folder", "路径", "目录"],
        render: (setting) => setting.addText((text) => text
          .setValue(this.owner.settings.remoteRoot)
          .onChange((value) => this.saveSetting({ remoteRoot: value.trim() }))),
      },
      {
        name: t("settings.username.name"),
        aliases: ["user", "account", "账户", "账号"],
        render: (setting) => setting.addText((text) => text
          .setValue(this.owner.settings.username)
          .onChange((value) => this.saveSetting({ username: value }))),
      },
      {
        name: t("settings.password.name"),
        desc: this.owner.getPassword()
          ? t("settings.password.desc.configured")
          : t("settings.password.desc.missing"),
        aliases: ["password", "SecretStorage", "credential", "密码", "凭据"],
        render: (setting) => this.renderPasswordSetting(setting),
      },
      {
        name: t("settings.testConnection.name"),
        desc: t("settings.testConnection.desc"),
        aliases: ["connection", "test", "probe", "连接", "能力检测"],
        render: (setting) => setting.addButton((button) => button.setButtonText(t("settings.testConnection.button")).onClick(async () => {
          button.setDisabled(true);
          button.setButtonText(t("settings.testConnection.testing"));
          try {
            new Notice(await this.owner.testConnection(), 8_000);
          } catch (error) {
            new Notice(t("settings.testConnection.failed", { error: formatError(error) }), 10_000);
          } finally {
            button.setDisabled(false);
            button.setButtonText(t("settings.testConnection.button"));
          }
        })),
      },
      {
        name: t("settings.forgetBinding.name"),
        desc: t("settings.forgetBinding.desc"),
        aliases: ["reset", "repository", "binding", "重置", "仓库"],
        render: (setting) => setting.addButton((button) => button
          .setButtonText(t("settings.forgetBinding.button"))
          .setDestructive()
          .onClick(async () => {
            if (!(await confirmAction(
              this.app,
              t("settings.forgetBinding.confirm.title"),
              t("settings.forgetBinding.confirm.body"),
              t("settings.forgetBinding.button"),
            ))) return;
            await this.owner.resetSyncState();
            new Notice(t("settings.forgetBinding.done"));
          })),
      },
      {
        name: t("settings.clearLock.name"),
        desc: t("settings.clearLock.desc"),
        aliases: ["lock", "recovery", "锁", "恢复"],
        render: (setting) => setting.addButton((button) => button
          .setButtonText(t("settings.clearLock.button"))
          .setDestructive()
          .onClick(async () => {
            if (!(await confirmAction(
              this.app,
              t("settings.clearLock.confirm.title"),
              t("settings.clearLock.confirm.body"),
              t("settings.clearLock.button"),
            ))) return;
            try {
              await this.owner.clearRemoteLock();
              new Notice(t("settings.clearLock.done"));
            } catch (error) {
              new Notice(t("settings.clearLock.failed", { error: formatError(error) }), 10_000);
            }
          })),
      },
    ]);
  }

  private getAutomationSettingDefinitions(): SettingDefinition[] {
    return settingDefinitions([
      {
        name: t("settings.autoSync.name"),
        desc: t("settings.autoSync.desc"),
        aliases: ["auto sync", "自动同步"],
        render: (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.owner.settings.autoSync)
          .onChange((value) => this.saveSetting({ autoSync: value }))),
      },
      {
        name: t("settings.syncOnStartup.name"),
        aliases: ["startup", "启动"],
        render: (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.owner.settings.syncOnStartup)
          .onChange((value) => this.saveSetting({ syncOnStartup: value }))),
      },
      {
        name: t("settings.fileChangeDelay.name"),
        desc: t("settings.fileChangeDelay.desc"),
        aliases: ["delay", "debounce", "延迟", "防抖"],
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
        name: t("settings.remotePollMinutes.name"),
        desc: t("settings.remotePollMinutes.desc"),
        aliases: ["polling", "interval", "轮询", "间隔"],
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
        name: t("settings.headRetries.name"),
        desc: t("settings.headRetries.desc"),
        aliases: ["HEAD", "retry", "重试"],
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
        name: t("settings.headRetryDelay.name"),
        desc: t("settings.headRetryDelay.desc"),
        aliases: ["HEAD", "retry", "delay", "重试", "间隔"],
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
        name: t("settings.enableRealSync.name"),
        desc: t("settings.enableRealSync.desc"),
        aliases: ["real sync", "upload", "download", "实际同步", "上传", "下载"],
        render: (setting) => setting.addToggle((toggle) => toggle
          .setValue(this.owner.settings.enableRealSync)
          .onChange((value) => this.saveSetting({ enableRealSync: value }))),
      },
      {
        name: t("settings.transferConcurrency.name"),
        desc: t("settings.transferConcurrency.desc"),
        aliases: ["concurrency", "transfer", "并发", "传输"],
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
        name: t("settings.excludedFolders.name"),
        desc: t("settings.excludedFolders.desc"),
        aliases: ["exclude", "ignore", "folder", "排除", "忽略", "目录"],
        render: (setting) => setting.addTextArea((text) => {
          text.inputEl.rows = 5;
          text.setPlaceholder(t("settings.excludedFolders.placeholder"));
          text.setValue(this.owner.settings.excludedFolders.join("\n"));
          text.onChange((value) => this.saveSetting({
            excludedFolders: value.split("\n").map((line) => line.trim()),
          }));
        }),
      },
      {
        name: t("settings.initialSyncPolicy.name"),
        desc: t("settings.initialSyncPolicy.desc"),
        aliases: ["first sync", "prefer local", "prefer remote", "首次同步", "优先本地", "优先远程"],
        render: (setting) => setting.addDropdown((dropdown) => dropdown
          .addOption("stop", t("settings.initialSyncPolicy.stop"))
          .addOption("prefer-remote", t("settings.initialSyncPolicy.preferRemote"))
          .addOption("prefer-local", t("settings.initialSyncPolicy.preferLocal"))
          .setValue(this.owner.settings.initialSyncPolicy)
          .onChange((value) => this.saveSetting({
            initialSyncPolicy: value as WebDavSyncSettings["initialSyncPolicy"],
          }))),
      },
    ]);
  }

  private getInterfaceSettingDefinitions(): SettingDefinition[] {
    return settingDefinitions([
      {
        name: t("settings.language.name"),
        desc: t("settings.language.desc"),
        aliases: ["language", "interface", "Chinese", "English", "语言", "界面", "中文"],
        render: (setting) => setting.addDropdown((dropdown) => dropdown
          .addOption("auto", t("settings.language.option.auto"))
          .addOption("zh-CN", t("settings.language.option.zh"))
          .addOption("en", t("settings.language.option.en"))
          .setValue(this.owner.settings.language)
          .onChange((value) => {
            this.saveSetting({ language: value as WebDavSyncSettings["language"] });
            this.update();
          })),
      },
    ]);
  }

  private renderPasswordSetting(setting: Setting): Setting {
    const passwordConfigured = Boolean(this.owner.getPassword());
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder(passwordConfigured
        ? t("settings.password.placeholder.configured")
        : t("settings.password.placeholder.missing"));
      text.setValue("");
      text.onChange((value) => {
        if (!value) return;
        void this.owner.savePassword(value).catch((error: unknown) => {
          new Notice(t("settings.password.saveFailed", { error: formatError(error) }));
        });
      });
    });
    setting.addButton((button) => button
      .setButtonText(t("settings.password.clearButton"))
      .setDestructive()
      .setDisabled(!passwordConfigured)
      .onClick(async () => {
        if (!(await confirmAction(
          this.app,
          t("settings.password.clearConfirm.title"),
          t("settings.password.clearConfirm.body"),
          t("settings.password.clearButton"),
        ))) return;
        try {
          await this.owner.clearPassword();
          this.update();
          new Notice(t("settings.password.cleared"));
        } catch (error) {
          new Notice(t("settings.password.clearFailed", { error: formatError(error) }));
        }
      }));
    return setting;
  }

  private saveSetting(patch: Partial<WebDavSyncSettings>): void {
    void this.owner.updateSettings(patch).catch((error: unknown) => {
      new Notice(t("settings.saveFailed", { error: formatError(error) }));
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
      .addCancelButton(t("common.cancel"))
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
