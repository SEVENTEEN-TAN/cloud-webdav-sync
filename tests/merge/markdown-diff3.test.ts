import assert from "node:assert/strict";
import test from "node:test";

import { mergeMarkdown } from "../../src/merge/markdown-diff3.ts";

test("returns identical Markdown unchanged", () => {
  const markdown = "# Note\n\nSame content.\n";

  assert.deepEqual(mergeMarkdown(markdown, markdown, markdown), {
    clean: true,
    content: markdown,
    conflicts: []
  });
});

test("accepts a local-only change", () => {
  const base = "# Note\n\nOriginal.\n";
  const local = "# Note\n\nChanged locally.\n";

  assert.deepEqual(mergeMarkdown(base, local, base), {
    clean: true,
    content: local,
    conflicts: []
  });
});

test("accepts a remote-only change", () => {
  const base = "# Note\n\nOriginal.\n";
  const remote = "# Note\n\nChanged remotely.\n";

  assert.deepEqual(mergeMarkdown(base, base, remote), {
    clean: true,
    content: remote,
    conflicts: []
  });
});

test("automatically merges changes to different line ranges", () => {
  const base = "alpha\nbravo\ncharlie\ndelta\n";
  const local = "alpha\nBRAVO local\ncharlie\ndelta\n";
  const remote = "alpha\nbravo\ncharlie\nDELTA remote\n";

  assert.deepEqual(mergeMarkdown(base, local, remote), {
    clean: true,
    content: "alpha\nBRAVO local\ncharlie\nDELTA remote\n",
    conflicts: []
  });
});

test("returns a structured conflict for different changes to the same line", () => {
  const result = mergeMarkdown(
    "alpha\nbravo\ncharlie\n",
    "alpha\nBRAVO local\ncharlie\n",
    "alpha\nBRAVO remote\ncharlie\n"
  );

  assert.deepEqual(result, {
    clean: false,
    conflicts: [
      {
        baseStart: 1,
        baseEnd: 2,
        base: ["bravo"],
        local: ["BRAVO local"],
        remote: ["BRAVO remote"]
      }
    ]
  });
});

test("represents delete versus modify as a structured conflict", () => {
  const result = mergeMarkdown(
    "keep\nremove me\nend\n",
    "keep\nend\n",
    "keep\nmodified remotely\nend\n"
  );

  assert.deepEqual(result, {
    clean: false,
    conflicts: [
      {
        baseStart: 1,
        baseEnd: 2,
        base: ["remove me"],
        local: [],
        remote: ["modified remotely"]
      }
    ]
  });
});

test("never silently mismerges edits around repeated identical lines", () => {
  const base = "- [ ] same\n- [ ] same\n- [ ] same\n";
  const local = "- [x] local\n- [ ] same\n- [ ] same\n";
  const remote = "- [ ] same\n- [x] remote\n- [ ] same\n";
  const result = mergeMarkdown(base, local, remote);

  if (result.clean) {
    assert.equal(result.content, "- [x] local\n- [x] remote\n- [ ] same\n");
  } else {
    assert.ok(result.conflicts.length > 0);
  }
});
