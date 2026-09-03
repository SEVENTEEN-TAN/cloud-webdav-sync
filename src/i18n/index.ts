import { en } from "./en";
import { zhCN, type MessageKey } from "./zh-CN";

export type { MessageKey } from "./zh-CN";

export type Language = "zh-CN" | "en";

/** Stored setting value; "auto" follows the Obsidian app language. */
export type LanguageSetting = "auto" | Language;

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "auto" || value === "zh-CN" || value === "en";
}

const catalogs: Record<Language, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  en,
};

let activeLanguage: Language = "zh-CN";

export function resolveLanguage(setting: LanguageSetting, obsidianLocale: string): Language {
  if (setting !== "auto") return setting;
  return obsidianLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function setLanguage(language: Language): void {
  activeLanguage = language;
}

export function getLanguage(): Language {
  return activeLanguage;
}

export type TranslatorParams = Record<string, string | number>;

export function translate(key: MessageKey, params?: TranslatorParams): string {
  let text: string = catalogs[activeLanguage][key] ?? zhCN[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export const t = translate;

/**
 * Whether a persisted message (sync history, logs) was produced from the given
 * key in either language — entries keep the language active when they were
 * written, so UI heuristics must not match on one locale's text only.
 */
export function matchesMessage(key: MessageKey, message: string): boolean {
  return message === zhCN[key] || message === en[key];
}
