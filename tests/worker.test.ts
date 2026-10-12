import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayStore } from '../src/store.js';
import { DeliveryWorker } from '../src/worker.js';
import type { DeliveryResult } from '../src/types.js';

const stores: RelayStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const fixture = () => {
  const store = new RelayStore(':memory:', { baseDelayMs: 10 });
  stores.push(store);
  store.ingest(
    { id: 'evt-1', type: 'invoice.paid', occurredAt: new Date(0).toISOString(), data: {} },
    0,
  );
  return store;
};
describe('worker lifecycle', () => {
  it('converts a thrown transport error into a durable retry', async () => {
    const store = fixture();
    let now = 0;
    const worker = new DeliveryWorker(
      store,
      async () => {
        throw new Error('private connection detail');
      },
      { now: () => now },
    );
    expect(await worker.runOnce()).toBe(true);
    expect(store.get('evt-1')).toMatchObject({
      status: 'retrying',
      lastError: 'Delivery transport failed',
    });
    expect(await worker.runOnce()).toBe(false);
    now = 10;
    expect(await worker.runOnce()).toBe(true);
    expect(store.get('evt-1')?.attempts).toBe(2);
  });

  it('does not duplicate a concurrent run and waits for an active delivery during shutdown', async () => {
    const store = fixture();
    let resolve!: (value: DeliveryResult) => void;
    const transport = vi.fn(
      () =>
        new Promise<DeliveryResult>((done) => {
          resolve = done;
        }),
    );
    const worker = new DeliveryWorker(store, transport, { now: () => 0 });
    const first = worker.runOnce();
    const concurrent = worker.runOnce();
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolve({ ok: true, retryable: false, statusCode: 200, error: null });
    await Promise.all([first, concurrent, stop]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.get('evt-1')?.status).toBe('delivered');
    expect(stopped).toBe(true);
  });
});
