export type SyncTrigger =
  | "manual"
  | "startup"
  | "file-change"
  | "interval"
  | "resume"
  | "retry";

export type SyncRunner = (triggers: readonly SyncTrigger[]) => Promise<void>;

interface PendingRequest {
  readonly trigger: SyncTrigger;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class SingleFlightSyncScheduler {
  readonly #pending: PendingRequest[] = [];
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
      this.#pending.push({ trigger, resolve, reject });
    });

    if (!this.#running) {
      this.#running = true;
      void this.#drain();
    }

    return completion;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending.length > 0) {
        const batch = this.#pending.splice(0);
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
