import type { WebDavRequest, WebDavResponse, WebDavTransport } from "./types";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  reason: "network" | "status";
  status?: number;
  error?: Error;
  method: string;
  url: string;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 8_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const REPLAY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND"]);

export class RetryingWebDavTransport implements WebDavTransport {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onRetry?: (info: RetryInfo) => void;

  constructor(private readonly inner: WebDavTransport, options: RetryOptions = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onRetry = options.onRetry;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer.");
    }
    if (this.baseDelayMs < 0 || this.maxDelayMs < 0) {
      throw new RangeError("Retry delays must be non-negative.");
    }
  }

  async request(request: WebDavRequest): Promise<WebDavResponse> {
    if (!REPLAY_SAFE_METHODS.has(request.method.toUpperCase())) {
      return this.inner.request(request);
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.delayFor(attempt - 1));
      }
      try {
        const response = await this.inner.request(request);
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.maxRetries) {
          return response;
        }
        this.reportRetry({
          attempt: attempt + 1,
          reason: "status",
          status: response.status,
          method: request.method,
          url: request.url,
        });
        lastError = null;
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) throw error;
        this.reportRetry({
          attempt: attempt + 1,
          reason: "network",
          error: error instanceof Error ? error : new Error(String(error)),
          method: request.method,
          url: request.url,
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private delayFor(failureIndex: number): number {
    const delay = this.baseDelayMs * 2 ** failureIndex;
    return Math.min(delay, this.maxDelayMs);
  }

  private reportRetry(info: Omit<RetryInfo, "delayMs">): void {
    const entry: RetryInfo = { ...info, delayMs: this.delayFor(info.attempt - 1) };
    this.onRetry?.(entry);
  }
}
