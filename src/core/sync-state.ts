export const SYNC_STATES = [
  "unconfigured",
  "idle",
  "scanning",
  "checking-remote",
  "planning",
  "uploading",
  "downloading",
  "merging",
  "applying",
  "updating-head",
  "paused",
  "offline",
  "conflict",
  "error"
] as const;

export type SyncState = (typeof SYNC_STATES)[number];

export interface SyncStateTransition {
  readonly from: SyncState;
  readonly to: SyncState;
  readonly at: number;
}

export type SyncStateListener = (transition: SyncStateTransition) => void;

const ALLOWED_TRANSITIONS: Readonly<Record<SyncState, ReadonlySet<SyncState>>> = {
  unconfigured: new Set(["idle", "error"]),
  idle: new Set(["unconfigured", "scanning", "checking-remote", "paused", "offline", "error"]),
  scanning: new Set(["checking-remote", "planning", "idle", "paused", "offline", "error"]),
  "checking-remote": new Set(["planning", "idle", "paused", "offline", "conflict", "error"]),
  planning: new Set([
    "uploading",
    "downloading",
    "merging",
    "applying",
    "updating-head",
    "idle",
    "paused",
    "offline",
    "conflict",
    "error"
  ]),
  uploading: new Set([
    "downloading",
    "merging",
    "applying",
    "updating-head",
    "idle",
    "paused",
    "offline",
    "conflict",
    "error"
  ]),
  downloading: new Set([
    "uploading",
    "merging",
    "applying",
    "updating-head",
    "idle",
    "paused",
    "offline",
    "conflict",
    "error"
  ]),
  merging: new Set(["applying", "uploading", "updating-head", "idle", "paused", "conflict", "error"]),
  applying: new Set(["uploading", "updating-head", "idle", "paused", "conflict", "error"]),
  "updating-head": new Set(["idle", "checking-remote", "paused", "offline", "conflict", "error"]),
  paused: new Set(["idle", "unconfigured"]),
  offline: new Set(["idle", "checking-remote", "paused", "error", "unconfigured"]),
  conflict: new Set(["idle", "merging", "paused", "error", "unconfigured"]),
  error: new Set(["idle", "checking-remote", "paused", "offline", "unconfigured"])
};

export class InvalidSyncTransitionError extends Error {
  constructor(
    readonly from: SyncState,
    readonly to: SyncState
  ) {
    super("Invalid sync state transition: " + from + " -> " + to);
    this.name = "InvalidSyncTransitionError";
  }
}

export class SyncStateMachine {
  readonly #listeners = new Set<SyncStateListener>();
  #current: SyncState;

  constructor(
    initialState: SyncState = "unconfigured",
    private readonly now: () => number = Date.now
  ) {
    this.#current = initialState;
  }

  get current(): SyncState {
    return this.#current;
  }

  canTransitionTo(next: SyncState): boolean {
    return ALLOWED_TRANSITIONS[this.#current].has(next);
  }

  transitionTo(next: SyncState): SyncStateTransition {
    const previous = this.#current;
    if (!this.canTransitionTo(next)) {
      throw new InvalidSyncTransitionError(previous, next);
    }

    this.#current = next;
    const transition: SyncStateTransition = Object.freeze({
      from: previous,
      to: next,
      at: this.now()
    });

    for (const listener of this.#listeners) {
      listener(transition);
    }

    return transition;
  }

  subscribe(listener: SyncStateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
