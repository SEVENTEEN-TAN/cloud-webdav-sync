export type DiffLineKind = "context" | "added" | "changed";

export interface DiffLine {
  lineNumber: number;
  text: string;
  kind: DiffLineKind;
}

export interface ThreeWayDiff {
  base: DiffLine[];
  local: DiffLine[];
  remote: DiffLine[];
  simplified: boolean;
}

const MAX_LCS_CELLS = 1_500_000;

export function buildThreeWayDiff(baseText: string, localText: string, remoteText: string): ThreeWayDiff {
  const baseLines = splitLines(baseText);
  const localLines = splitLines(localText);
  const remoteLines = splitLines(remoteText);
  if (
    baseLines.length * localLines.length > MAX_LCS_CELLS ||
    baseLines.length * remoteLines.length > MAX_LCS_CELLS
  ) {
    return {
      base: toContextLines(baseLines),
      local: toContextLines(localLines),
      remote: toContextLines(remoteLines),
      simplified: true,
    };
  }

  const localDiff = diffAgainstBase(baseLines, localLines);
  const remoteDiff = diffAgainstBase(baseLines, remoteLines);
  const baseChanged = new Set<number>();
  for (const line of [...localDiff.base, ...remoteDiff.base]) {
    if (line.kind === "changed") baseChanged.add(line.lineNumber);
  }
  return {
    base: baseLines.map((text, index) => ({
      lineNumber: index + 1,
      text,
      kind: baseChanged.has(index + 1) ? "changed" : "context",
    })),
    local: localDiff.version,
    remote: remoteDiff.version,
    simplified: false,
  };
}

function diffAgainstBase(base: readonly string[], version: readonly string[]): { base: DiffLine[]; version: DiffLine[] } {
  const width = version.length + 1;
  const table = new Uint32Array((base.length + 1) * width);
  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let versionIndex = version.length - 1; versionIndex >= 0; versionIndex -= 1) {
      const index = baseIndex * width + versionIndex;
      table[index] = base[baseIndex] === version[versionIndex]
        ? table[(baseIndex + 1) * width + versionIndex + 1]! + 1
        : Math.max(table[(baseIndex + 1) * width + versionIndex]!, table[baseIndex * width + versionIndex + 1]!);
    }
  }

  const baseOutput: DiffLine[] = [];
  const versionOutput: DiffLine[] = [];
  let baseIndex = 0;
  let versionIndex = 0;
  while (baseIndex < base.length || versionIndex < version.length) {
    if (baseIndex < base.length && versionIndex < version.length && base[baseIndex] === version[versionIndex]) {
      baseOutput.push({ lineNumber: baseIndex + 1, text: base[baseIndex] as string, kind: "context" });
      versionOutput.push({ lineNumber: versionIndex + 1, text: version[versionIndex] as string, kind: "context" });
      baseIndex += 1;
      versionIndex += 1;
      continue;
    }
    const skipBase = baseIndex < base.length ? table[(baseIndex + 1) * width + versionIndex]! : -1;
    const skipVersion = versionIndex < version.length ? table[baseIndex * width + versionIndex + 1]! : -1;
    if (baseIndex < base.length && (versionIndex === version.length || skipBase >= skipVersion)) {
      baseOutput.push({ lineNumber: baseIndex + 1, text: base[baseIndex] as string, kind: "changed" });
      baseIndex += 1;
    } else if (versionIndex < version.length) {
      versionOutput.push({ lineNumber: versionIndex + 1, text: version[versionIndex] as string, kind: "added" });
      versionIndex += 1;
    }
  }
  return { base: baseOutput, version: versionOutput };
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function toContextLines(lines: readonly string[]): DiffLine[] {
  return lines.map((text, index) => ({ lineNumber: index + 1, text, kind: "context" }));
}
