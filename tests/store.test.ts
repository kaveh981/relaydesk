import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore } from '../src/store.js';
import type { DeliveryResult, WebhookEvent } from '../src/types.js';

const now = Date.parse('2026-01-01T00:00:00Z');
const event = (id = 'evt-1'): WebhookEvent => ({
  id,
  type: 'invoice.paid',
  occurredAt: new Date(now).toISOString(),
  data: { amount: 4900, currency: 'USD' },
});
const success: DeliveryResult = { ok: true, retryable: false, statusCode: 204, error: null };
const failure: DeliveryResult = {
  ok: false,
  retryable: true,
  statusCode: 503,
  error: 'Receiver returned HTTP 503',
};
const stores: RelayStore[] = [];
const dirs: string[] = [];
function store(path = ':memory:', maxAttempts = 3) {
  const instance = new RelayStore(path, { maxAttempts, baseDelayMs: 100, maxDelayMs: 1000 });
  stores.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of stores.splice(0)) instance.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe('durable intake and delivery state', () => {
  it('suppresses semantically identical retries and refuses conflicting reuse of an event ID', () => {
    const db = store();
    const first = db.ingest(event(), now);
    const retry = db.ingest(
      {
        data: { currency: 'USD', amount: 4900 },
        occurredAt: event().occurredAt,
        type: event().type,
        id: event().id,
      },
      now + 1,
    );
    expect(retry).toMatchObject({
      duplicate: true,
      conflict: false,
      delivery: { deliveryId: first.delivery.deliveryId },
    });
    expect(db.ingest({ ...event(), data: { amount: 1 } }, now + 2).conflict).toBe(true);
    expect(db.overview().total).toBe(1);
    expect(db.get('evt-1')?.event.data.amount).toBe(4900);
  });

  it('claims exclusively across independent database connections and fences a stale worker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaydesk-'));
    dirs.push(dir);
    const a = store(join(dir, 'queue.sqlite'));
    const b = store(join(dir, 'queue.sqlite'));
    a.ingest(event(), now);
    const old = a.claim(now, 1000)!;
    expect(b.claim(now + 1, 1000)).toBeUndefined();
    const current = b.claim(now + 1000, 1000)!;
    expect(current.attempt).toBe(2);
    expect(a.finish(old, success, now + 1001)).toBe(false);
    expect(b.finish(current, success, now + 1002)).toBe(true);
    expect(a.get('evt-1')?.history.map((item) => item.result)).toEqual(['abandoned', 'delivered']);
  });

  it('recovers an abandoned claim after reopening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaydesk-'));
    dirs.push(dir);
    const path = join(dir, 'queue.sqlite');
    const first = new RelayStore(path);
    first.ingest(event(), now);
    first.claim(now, 1000);
    first.close();
    const reopened = store(path);
    expect(reopened.get('evt-1')?.status).toBe('processing');
    expect(reopened.claim(now + 999, 1000)).toBeUndefined();
    expect(reopened.claim(now + 1000, 1000)?.event.id).toBe('evt-1');
  });

  it('waits for exponential backoff, respects Retry-After within the configured cap and exhausts attempts', () => {
    const db = store();
    db.ingest(event(), now);
    db.finish(db.claim(now, 1000)!, failure, now + 1);
    expect(db.claim(now + 100, 1000)).toBeUndefined();
    const second = db.claim(now + 101, 1000)!;
    db.finish(second, { ...failure, retryAfterMs: 999_999 }, now + 102);
    expect(db.get('evt-1')?.nextAttemptAt).toBe(new Date(now + 1102).toISOString());
    expect(db.claim(now + 1101, 1000)).toBeUndefined();
    db.finish(db.claim(now + 1102, 1000)!, failure, now + 1103);
    expect(db.get('evt-1')?.status).toBe('dead');
    expect(db.claim(now + 10_000, 1000)).toBeUndefined();
  });

  it('records permanent failures, replays only dead deliveries and retains the original delivery identity and audit', () => {
    const db = store();
    const initial = db.ingest(event(), now).delivery;
    expect(db.replay('evt-1', now)).toBe('not-dead');
    expect(db.replay('missing', now)).toBe('missing');
    db.finish(db.claim(now, 1000)!, { ...failure, retryable: false, statusCode: 422 }, now + 1);
    expect(db.replay('evt-1', now + 2)).toBe('ok');
    const replay = db.claim(now + 2, 1000)!;
    expect(replay).toMatchObject({ deliveryId: initial.deliveryId, attempt: 1, generation: 1 });
    db.finish(replay, success, now + 3);
    expect(db.get('evt-1')?.history.map((item) => [item.generation, item.result])).toEqual([
      [0, 'failed'],
      [1, 'delivered'],
    ]);
  });

  it('bounds abandoned attempts and refuses completion at the lease boundary', () => {
    const db = store(':memory:', 1);
    db.ingest(event(), now);
    const claim = db.claim(now, 1000)!;
    expect(db.finish(claim, success, now + 1000)).toBe(false);
    expect(db.claim(now + 1000, 1000)).toBeUndefined();
    expect(db.get('evt-1')).toMatchObject({
      status: 'dead',
      attempts: 1,
      history: [{ result: 'abandoned' }],
    });
  });

  it('filters operational views and rejects impossible retry policies', () => {
    const db = store();
    db.ingest(event('a'), now);
    db.ingest(event('b'), now + 1);
    db.finish(db.claim(now, 1000)!, success, now + 1);
    expect(db.list('delivered').map((item) => item.id)).toEqual(['a']);
    expect(db.list(undefined, 1)).toHaveLength(1);
    expect(db.overview().counts).toMatchObject({ delivered: 1, pending: 1 });
    expect(() => new RelayStore(':memory:', { maxAttempts: 0 })).toThrow('Invalid retry policy');
    expect(() => new RelayStore(':memory:', { baseDelayMs: Number.NaN })).toThrow(
      'Invalid retry policy',
    );
    expect(() => db.claim(now, Number.POSITIVE_INFINITY)).toThrow('positive integer');
  });
});
