import type { RelayStore } from './store.js';
import type { Transport } from './types.js';

export class DeliveryWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<boolean> | undefined;
  private stopped = true;

  constructor(
    private readonly store: RelayStore,
    private readonly transport: Transport,
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      pollMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  /** One claim at a time per worker; multiple processes are coordinated by SQLite leases. */
  async runOnce(): Promise<boolean> {
    if (this.active) return this.active;
    this.active = this.processOne();
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }

  private async processOne(): Promise<boolean> {
    const now = this.options.now ?? Date.now;
    const claim = this.store.claim(now(), this.options.leaseMs ?? 10_000);
    if (!claim) return false;
    let result;
    try {
      result = await this.transport(claim);
    } catch {
      result = { ok: false, retryable: true, statusCode: null, error: 'Delivery transport failed' };
    }
    this.store.finish(claim, result, now());
    return true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      let busy = false;
      try {
        busy = await this.runOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (!this.stopped)
        this.timer = setTimeout(
          () => {
            void tick();
          },
          busy ? 0 : (this.options.pollMs ?? 250),
        );
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
