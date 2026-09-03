import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../../src/i18n/en.ts";
import {
  getLanguage,
  resolveLanguage,
  setLanguage,
  t,
  translate,
} from "../../src/i18n/index.ts";
import { zhCN } from "../../src/i18n/zh-CN.ts";

test("resolveLanguage follows the Obsidian locale for the auto setting", () => {
  assert.equal(resolveLanguage("auto", "zh"), "zh-CN");
  assert.equal(resolveLanguage("auto", "zh-TW"), "zh-CN");
  assert.equal(resolveLanguage("auto", "en"), "en");
  assert.equal(resolveLanguage("auto", "en-US"), "en");
  assert.equal(resolveLanguage("auto", "fr"), "en");
});

test("resolveLanguage honors an explicit language choice", () => {
  assert.equal(resolveLanguage("zh-CN", "en"), "zh-CN");
  assert.equal(resolveLanguage("en", "zh"), "en");
});

test("the english catalog defines every chinese catalog key", () => {
  const missing = Object.keys(zhCN).filter((key) => !(key in en));
  assert.deepEqual(missing, []);
});

test("translate switches catalogs with the active language and interpolates params", () => {
  setLanguage("zh-CN");
  assert.equal(getLanguage(), "zh-CN");
  assert.equal(translate("syncCenter.tab.overview"), "概览");
  assert.equal(t("plugin.notice.syncFailed", { error: "boom" }), "WebDAV 同步失败：boom");

  setLanguage("en");
  assert.equal(getLanguage(), "en");
  assert.equal(translate("syncCenter.tab.overview"), "Overview");
  assert.equal(t("plugin.notice.syncFailed", { error: "boom" }), "WebDAV sync failed: boom");
  assert.equal(t("syncCenter.action.resolveConflicts", { count: 3 }), "Resolve 3 conflicts");

  setLanguage("zh-CN");
});
