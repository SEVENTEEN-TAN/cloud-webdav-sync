export interface DiagnosticConflictInput {
  path: string;
  action: string;
  canResolve: boolean;
  choice?: string;
  details?: unknown;
  versions?: unknown;
}

export interface SanitizedDiagnosticConflict {
  pathHash: string;
  action: string;
  canResolve: boolean;
  choice?: string;
}

export async function sanitizeDiagnosticConflicts(
  conflicts: readonly DiagnosticConflictInput[],
): Promise<SanitizedDiagnosticConflict[]> {
  return Promise.all(conflicts.map(async ({ path, action, canResolve, choice }) => ({
    pathHash: `sha256:${(await sha256(path)).slice(0, 16)}`,
    action,
    canResolve,
    ...(choice ? { choice } : {}),
  })));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
