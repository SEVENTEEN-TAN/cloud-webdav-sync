export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContextValue =
  | null
  | boolean
  | number
  | string
  | readonly LogContextValue[]
  | { readonly [key: string]: LogContextValue };

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: LogContextValue;
  readonly truncated?: true;
}

export interface BoundedMemoryLogOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

interface StoredEntry {
  readonly entry: LogEntry;
  readonly bytes: number;
}

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const SENSITIVE_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|signature|credential)/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const AUTH_PATTERN = /\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(password|passwd|secret|token|api[-_]?key|access[-_]?key|signature)\s*[:=]\s*[^\s,;&]+/gi;

const encoder = new TextEncoder();

function entryBytes(entry: LogEntry): number {
  return encoder.encode(JSON.stringify(entry)).byteLength;
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const hadCredentials = url.username.length > 0 || url.password.length > 0;
    url.username = "";
    url.password = "";

    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }

    const safeUrl = url.toString();
    return hadCredentials
      ? safeUrl.replace(url.protocol + "//", url.protocol + "//" + REDACTED + "@")
      : safeUrl;
  } catch {
    return REDACTED;
  }
}

export function redactLogText(value: string): string {
  return value
    .replace(URL_PATTERN, redactUrl)
    .replace(AUTH_PATTERN, "$1: " + REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=" + REDACTED);
}

function sanitizeContext(value: unknown, seen: WeakSet<object>): LogContextValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return redactLogText(value);
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (typeof value === "undefined") {
    return "undefined";
  }

  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogText(value.message)
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeContext(item, seen));
  }

  const sanitized: Record<string, LogContextValue> = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : sanitizeContext(item, seen);
  }
  return sanitized;
}

function safelySanitizeContext(value: unknown): LogContextValue {
  try {
    return sanitizeContext(value, new WeakSet());
  } catch {
    return "[Unserializable context]";
  }
}

function cloneEntry(entry: LogEntry): LogEntry {
  return structuredClone(entry);
}

export class BoundedMemoryLog {
  readonly #entries: StoredEntry[] = [];
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  #sizeBytes = 0;

  constructor(options: BoundedMemoryLogOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 200;
    this.#maxBytes = options.maxBytes ?? 256 * 1_024;
    this.#now = options.now ?? Date.now;

    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 128) {
      throw new RangeError("maxBytes must be an integer of at least 128");
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  get sizeBytes(): number {
    return this.#sizeBytes;
  }

  debug(message: string, context?: unknown): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: unknown): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: unknown): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: unknown): void {
    this.log("error", message, context);
  }

  log(level: LogLevel, message: string, context?: unknown): void {
    const redactedMessage = redactLogText(message);
    const entry: LogEntry = context === undefined
      ? { timestamp: this.#now(), level, message: redactedMessage }
      : {
          timestamp: this.#now(),
          level,
          message: redactedMessage,
          context: safelySanitizeContext(context)
        };
    this.#append(this.#fit(entry));
  }

  snapshot(): LogEntry[] {
    return this.#entries.map(({ entry }) => cloneEntry(entry));
  }

  clear(): void {
    this.#entries.length = 0;
    this.#sizeBytes = 0;
  }

  #fit(entry: LogEntry): LogEntry {
    if (entryBytes(entry) <= this.#maxBytes) {
      return entry;
    }

    const characters = Array.from(entry.message);
    let low = 0;
    let high = characters.length;
    let best: LogEntry = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: "",
      truncated: true
    };

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate: LogEntry = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: characters.slice(0, middle).join(""),
        truncated: true
      };

      if (entryBytes(candidate) <= this.#maxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return best;
  }

  #append(entry: LogEntry): void {
    const bytes = entryBytes(entry);
    this.#entries.push({ entry, bytes });
    this.#sizeBytes += bytes;

    while (
      this.#entries.length > this.#maxEntries ||
      this.#sizeBytes > this.#maxBytes
    ) {
      const removed = this.#entries.shift();
      if (removed) {
        this.#sizeBytes -= removed.bytes;
      }
    }
  }
}
