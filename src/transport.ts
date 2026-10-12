import { canonicalJson } from './store.js';
import { signPayload } from './signature.js';
import type { DeliveryResult, Transport } from './types.js';

export function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function httpTransport(options: {
  url: string;
  secret: string;
  timeoutMs: number;
  now?: () => number;
}): Transport {
  const now = options.now ?? Date.now;
  return async (claim): Promise<DeliveryResult> => {
    const body = canonicalJson(claim.event);
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': signPayload(body, options.secret, Math.floor(now() / 1_000)),
          'x-delivery-id': claim.deliveryId,
          'x-event-id': claim.event.id,
        },
      });
      // Receiver bodies are untrusted and may contain secrets or be unbounded. Do not persist them.
      await response.body?.cancel();
      if (response.ok)
        return { ok: true, retryable: false, statusCode: response.status, error: null };
      const retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'), now());
      return {
        ok: false,
        retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
        statusCode: response.status,
        error: `Receiver returned HTTP ${response.status}`,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    } catch {
      return {
        ok: false,
        retryable: true,
        statusCode: null,
        error: 'Delivery request failed or timed out',
      };
    }
  };
}
