import assert from "node:assert/strict";
import test from "node:test";
import { createBasicAuthHeader } from "../../src/webdav/auth";
import { encodeWebDavPath, isAllowedWebDavServerUrl, joinWebDavUrl } from "../../src/webdav/url";

test("encodes each WebDAV path segment without encoding separators", () => {
  assert.equal(encodeWebDavPath("知识库/My Note #1.md"), "%E7%9F%A5%E8%AF%86%E5%BA%93/My%20Note%20%231.md");
});

test("rejects dot path segments", () => {
  assert.throws(() => encodeWebDavPath("vault/../secret"), /dot segments/);
});

test("joins a server base path, remote root, and relative path", () => {
  assert.equal(
    joinWebDavUrl("https://dav.example.com/webdav/", "Obsidian Vault", "Notes/a.md"),
    "https://dav.example.com/webdav/Obsidian%20Vault/Notes/a.md",
  );
});

test("builds Basic authorization with UTF-8 credentials", () => {
  const header = createBasicAuthHeader({ username: "用户", password: "密钥" });
  const decoded = new TextDecoder().decode(
    Uint8Array.from(globalThis.atob(header.slice(6)), (character) => character.charCodeAt(0)),
  );
  assert.equal(decoded, "用户:密钥");
});

test("allows HTTPS and localhost HTTP WebDAV endpoints only", () => {
  assert.equal(isAllowedWebDavServerUrl("https://dav.example.com/webdav"), true);
  assert.equal(isAllowedWebDavServerUrl("http://localhost:8080/webdav"), true);
  assert.equal(isAllowedWebDavServerUrl("http://127.0.0.1:8080/webdav"), true);
  assert.equal(isAllowedWebDavServerUrl("http://[::1]:8080/webdav"), true);
  assert.equal(isAllowedWebDavServerUrl("http://dav.example.com/webdav"), false);
  assert.equal(isAllowedWebDavServerUrl("ftp://dav.example.com/webdav"), false);
  assert.equal(isAllowedWebDavServerUrl("https://user:secret@dav.example.com/webdav"), false);
});

test("rejects Basic Auth usernames containing a colon", () => {
  assert.throws(
    () => createBasicAuthHeader({ username: "user:other", password: "secret" }),
    /cannot contain a colon/i,
  );
});
