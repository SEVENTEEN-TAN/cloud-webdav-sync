import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDiagnosticConflicts } from "../../src/logging/diagnostics";

test("diagnostic conflicts omit note excerpts and hash vault paths", async () => {
  const secret = "UNIQUE_PRIVATE_NOTE_CONTENT_7d82f3";
  const result = await sanitizeDiagnosticConflicts([{
    path: `Private/${secret}.md`,
    action: "markdown-overlap",
    canResolve: true,
    choice: "local",
    details: { base: secret, local: secret, remote: secret },
    versions: { base: secret, local: secret, remote: secret },
  }]);
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes(secret), false);
  assert.equal(Object.hasOwn(result[0] ?? {}, "path"), false);
  assert.equal(Object.hasOwn(result[0] ?? {}, "details"), false);
  assert.equal(Object.hasOwn(result[0] ?? {}, "versions"), false);
  assert.match(result[0]?.pathHash ?? "", /^sha256:[a-f0-9]{16}$/);
});
