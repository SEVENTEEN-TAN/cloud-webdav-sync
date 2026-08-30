export type SyncTrigger =
  | "manual"
  | "startup"
  | "file-change"
  | "interval"
  | "resume"
  | "retry";

export type SyncRunner = (triggers: readonly SyncTrigger[]) => Promise<void>;

interface PendingRequest {
  readonly kind: "normal";
  readonly trigger: SyncTrigger;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingExclusiveRequest {
  readonly kind: "exclusive";
  readonly runner: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

type PendingEntry = PendingRequest | PendingExclusiveRequest;

export class SingleFlightSyncScheduler {
  readonly #pending: PendingEntry[] = [];
  #running = false;

  constructor(private readonly runner: SyncRunner) {}

  get isRunning(): boolean {
    return this.#running;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  request(trigger: SyncTrigger): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.#pending.push({ kind: "normal", trigger, resolve, reject });
    });

    this.#startDrain();
    return completion;
  }

  requestExclusive(runner: () => Promise<void>): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.#pending.push({ kind: "exclusive", runner, resolve, reject });
    });

    this.#startDrain();
    return completion;
  }

  #startDrain(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending.length > 0) {
        const next = this.#pending[0];
        if (next?.kind === "exclusive") {
          this.#pending.shift();
          try {
            await next.runner();
            next.resolve();
          } catch (error) {
            next.reject(error);
          }
          continue;
        }

        const barrierIndex = this.#pending.findIndex(({ kind }) => kind === "exclusive");
        const batch = this.#pending.splice(
          0,
          barrierIndex < 0 ? this.#pending.length : barrierIndex,
        ) as PendingRequest[];
        const triggers = batch.map(({ trigger }) => trigger);

        try {
          await this.runner(triggers);
          for (const request of batch) {
            request.resolve();
          }
        } catch (error) {
          for (const request of batch) {
            request.reject(error);
          }
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
