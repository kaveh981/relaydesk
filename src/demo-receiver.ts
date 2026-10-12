import type { DeliveryResult, WebhookEvent } from './types.js';

/**
 * Synthetic destination used only in demo mode. Its fault behaviour is
 * deliberately deterministic so retries and recovery are reproducible.
 */
export class DemoReceiver {
  private readonly attempts = new Map<string, number>();
  private readonly recovered = new Set<string>();

  handle(event: WebhookEvent): DeliveryResult {
    const attempt = (this.attempts.get(event.id) ?? 0) + 1;
    this.attempts.set(event.id, attempt);
    if (event.data.demoScenario === 'permanent' && !this.recovered.has(event.id)) {
      return {
        ok: false,
        retryable: false,
        statusCode: 422,
        error: 'Synthetic receiver rejected this event.',
      };
    }
    if (event.data.demoScenario === 'retry' && attempt <= 2) {
      return {
        ok: false,
        retryable: true,
        statusCode: 503,
        error: 'Synthetic receiver is temporarily unavailable.',
      };
    }
    return { ok: true, retryable: false, statusCode: 200, error: null };
  }

  recover(eventId: string): void {
    this.recovered.add(eventId);
  }

  reset(): void {
    this.attempts.clear();
    this.recovered.clear();
  }
}
