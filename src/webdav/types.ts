export interface WebDavRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface WebDavResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export interface WebDavTransport {
  request(request: WebDavRequest): Promise<WebDavResponse>;
}

export interface WebDavCredentials {
  username: string;
  password: string;
}

export type HeadUpdateStrategy = "etag" | "move-lock" | "mkcol-lock" | null;

export interface WebDavCapabilities {
  reachable: boolean;
  webDavClass: string | null;
  conditionalCreate: boolean;
  strongEtag: boolean;
  conditionalUpdate: boolean;
  staleEtagRejected: boolean;
  atomicMoveNoOverwrite: boolean;
  atomicCollectionCreate: boolean;
  headUpdateStrategy: HeadUpdateStrategy;
  safeConcurrentWrites: boolean;
  cleanupSucceeded: boolean;
  warnings: string[];
}

export interface CapabilityProbeResult {
  ok: boolean;
  capabilities: WebDavCapabilities;
  error?: WebDavErrorInfo;
}

export interface WebDavErrorInfo {
  code: string;
  message: string;
  status?: number;
  retryable: boolean;
}
