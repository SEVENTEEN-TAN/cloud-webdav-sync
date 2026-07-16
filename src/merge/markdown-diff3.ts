export interface MarkdownMergeConflict {
  /** Zero-based, end-exclusive line range in the base document. */
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly base: readonly string[];
  readonly local: readonly string[];
  readonly remote: readonly string[];
}

export interface CleanMarkdownMergeResult {
  readonly clean: true;
  readonly content: string;
  readonly conflicts: readonly [];
}

export interface ConflictedMarkdownMergeResult {
  readonly clean: false;
  readonly conflicts: readonly MarkdownMergeConflict[];
}

export type MarkdownMergeResult =
  | CleanMarkdownMergeResult
  | ConflictedMarkdownMergeResult;

interface LineChange {
  readonly start: number;
  readonly end: number;
  readonly replacement: readonly string[];
}

interface ChangeCluster {
  readonly local: readonly LineChange[];
  readonly remote: readonly LineChange[];
  readonly nextLocalIndex: number;
  readonly nextRemoteIndex: number;
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split("\n");
}

function equalLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function diffLines(
  base: readonly string[],
  target: readonly string[],
  preferInsertOnTie: boolean,
): LineChange[] {
  const table = Array.from(
    { length: base.length + 1 },
    () => new Uint32Array(target.length + 1)
  );

  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    const row = table[baseIndex]!;
    const nextRow = table[baseIndex + 1]!;

    for (let targetIndex = target.length - 1; targetIndex >= 0; targetIndex -= 1) {
      row[targetIndex] =
        base[baseIndex] === target[targetIndex]
          ? (nextRow[targetIndex + 1] ?? 0) + 1
          : Math.max(nextRow[targetIndex] ?? 0, row[targetIndex + 1] ?? 0);
    }
  }

  const changes: LineChange[] = [];
  let baseIndex = 0;
  let targetIndex = 0;
  let changeStart: number | undefined;
  let changeEnd = 0;
  let replacement: string[] = [];

  const finishChange = (): void => {
    if (changeStart === undefined) {
      return;
    }

    changes.push({
      start: changeStart,
      end: changeEnd,
      replacement
    });
    changeStart = undefined;
    replacement = [];
  };

  while (baseIndex < base.length || targetIndex < target.length) {
    if (
      baseIndex < base.length &&
      targetIndex < target.length &&
      base[baseIndex] === target[targetIndex]
    ) {
      finishChange();
      baseIndex += 1;
      targetIndex += 1;
      continue;
    }

    if (changeStart === undefined) {
      changeStart = baseIndex;
      changeEnd = baseIndex;
    }

    const insertKeeps = table[baseIndex]?.[targetIndex + 1] ?? 0;
    const deleteKeeps = table[baseIndex + 1]?.[targetIndex] ?? 0;

    const chooseInsert = insertKeeps > deleteKeeps ||
      (insertKeeps === deleteKeeps && preferInsertOnTie);
    if (targetIndex < target.length && (baseIndex === base.length || chooseInsert)) {
      replacement.push(target[targetIndex]!);
      targetIndex += 1;
    } else {
      baseIndex += 1;
      changeEnd = baseIndex;
    }
  }

  finishChange();
  return changes;
}

function changesInteract(left: LineChange, right: LineChange): boolean {
  const leftIsInsertion = left.start === left.end;
  const rightIsInsertion = right.start === right.end;

  if (leftIsInsertion && rightIsInsertion) {
    return left.start === right.start;
  }

  if (leftIsInsertion) {
    return right.start <= left.start && left.start < right.end;
  }

  if (rightIsInsertion) {
    return left.start <= right.start && right.start < left.end;
  }

  return left.start < right.end && right.start < left.end;
}

function collectCluster(
  localChanges: readonly LineChange[],
  remoteChanges: readonly LineChange[],
  localIndex: number,
  remoteIndex: number
): ChangeCluster {
  const local = [localChanges[localIndex]!];
  const remote = [remoteChanges[remoteIndex]!];
  let nextLocalIndex = localIndex + 1;
  let nextRemoteIndex = remoteIndex + 1;
  let expanded = true;

  while (expanded) {
    expanded = false;

    const nextLocal = localChanges[nextLocalIndex];
    if (nextLocal && remote.some((change) => changesInteract(nextLocal, change))) {
      local.push(nextLocal);
      nextLocalIndex += 1;
      expanded = true;
    }

    const nextRemote = remoteChanges[nextRemoteIndex];
    if (nextRemote && local.some((change) => changesInteract(change, nextRemote))) {
      remote.push(nextRemote);
      nextRemoteIndex += 1;
      expanded = true;
    }
  }

  return { local, remote, nextLocalIndex, nextRemoteIndex };
}

function renderRange(
  base: readonly string[],
  start: number,
  end: number,
  changes: readonly LineChange[]
): string[] {
  const rendered: string[] = [];
  let cursor = start;

  for (const change of changes) {
    rendered.push(...base.slice(cursor, change.start), ...change.replacement);
    cursor = change.end;
  }

  rendered.push(...base.slice(cursor, end));
  return rendered;
}

function applyChange(
  output: string[],
  base: readonly string[],
  cursor: number,
  change: LineChange
): number {
  output.push(...base.slice(cursor, change.start), ...change.replacement);
  return change.end;
}

function mergeMarkdownWithTie(
  base: string,
  local: string,
  remote: string,
  preferInsertOnTie: boolean,
): MarkdownMergeResult {
  if (local === remote) {
    return { clean: true, content: local, conflicts: [] };
  }

  if (local === base) {
    return { clean: true, content: remote, conflicts: [] };
  }

  if (remote === base) {
    return { clean: true, content: local, conflicts: [] };
  }

  const baseLines = splitLines(base);
  const localChanges = diffLines(baseLines, splitLines(local), preferInsertOnTie);
  const remoteChanges = diffLines(baseLines, splitLines(remote), preferInsertOnTie);
  const output: string[] = [];
  const conflicts: MarkdownMergeConflict[] = [];
  let localIndex = 0;
  let remoteIndex = 0;
  let cursor = 0;

  while (localIndex < localChanges.length || remoteIndex < remoteChanges.length) {
    const localChange = localChanges[localIndex];
    const remoteChange = remoteChanges[remoteIndex];

    if (localChange && remoteChange && changesInteract(localChange, remoteChange)) {
      const cluster = collectCluster(localChanges, remoteChanges, localIndex, remoteIndex);
      const allChanges = [...cluster.local, ...cluster.remote];
      const start = Math.min(...allChanges.map((change) => change.start));
      const end = Math.max(...allChanges.map((change) => change.end));
      const localSegment = renderRange(baseLines, start, end, cluster.local);
      const remoteSegment = renderRange(baseLines, start, end, cluster.remote);

      output.push(...baseLines.slice(cursor, start));

      if (equalLines(localSegment, remoteSegment)) {
        output.push(...localSegment);
      } else {
        conflicts.push({
          baseStart: start,
          baseEnd: end,
          base: baseLines.slice(start, end),
          local: localSegment,
          remote: remoteSegment
        });
      }

      cursor = end;
      localIndex = cluster.nextLocalIndex;
      remoteIndex = cluster.nextRemoteIndex;
      continue;
    }

    if (!remoteChange || (localChange && localChange.start < remoteChange.start)) {
      cursor = applyChange(output, baseLines, cursor, localChange!);
      localIndex += 1;
    } else {
      cursor = applyChange(output, baseLines, cursor, remoteChange);
      remoteIndex += 1;
    }
  }

  if (conflicts.length > 0) {
    return { clean: false, conflicts };
  }

  output.push(...baseLines.slice(cursor));
  return { clean: true, content: output.join("\n"), conflicts: [] };
}

export function mergeMarkdown(base: string, local: string, remote: string): MarkdownMergeResult {
  const primary = mergeMarkdownWithTie(base, local, remote, true);
  const alternate = mergeMarkdownWithTie(base, local, remote, false);
  if (primary.clean && alternate.clean && primary.content === alternate.content) return primary;
  if (!primary.clean) return primary;
  if (!alternate.clean) return alternate;
  return {
    clean: false,
    conflicts: [{
      baseStart: 0,
      baseEnd: splitLines(base).length,
      base: splitLines(base),
      local: splitLines(local),
      remote: splitLines(remote),
    }],
  };
}
