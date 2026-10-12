import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { DemoReceiver } from '../src/demo-receiver.js';
import { signPayload } from '../src/signature.js';
import { RelayStore } from '../src/store.js';
import type { WebhookEvent } from '../src/types.js';

const INBOUND_SECRET = 'synthetic-inbound-secret';
const DELIVERY_SECRET = 'synthetic-destination-secret';
const ADMIN_KEY = 'synthetic-admin-key';
const TIMESTAMP = 1_800_000_000;
const NOW = TIMESTAMP * 1000;
const auth = { 'x-api-key': ADMIN_KEY };
const fixtures: { app: FastifyInstance; store: RelayStore }[] = [];
const event: WebhookEvent = {
  id: 'event-001',
  type: 'invoice.created',
  occurredAt: new Date(NOW).toISOString(),
  data: { account: 'synthetic-001', amount: 42 },
};

async function fixture(demoMode = false) {
  const store = new RelayStore(':memory:', {
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 100,
  });
  const receiver = new DemoReceiver();
  const app = await buildApp({
    store,
    adminKey: ADMIN_KEY,
    webhookSecret: INBOUND_SECRET,
    deliverySecret: DELIVERY_SECRET,
    demoMode,
    demoReceiver: receiver,
    now: () => NOW,
  });
  fixtures.push({ app, store });
  await app.ready();
  return { app, store, receiver };
}

function signedPost(
  app: FastifyInstance,
  body: string | Buffer = JSON.stringify(event),
  secret = INBOUND_SECRET,
  timestamp = TIMESTAMP,
  url = '/webhooks/events',
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signPayload(body, secret, timestamp),
    },
    payload: body,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, store } of fixtures.splice(0)) {
    await app.close();
    store.close();
  }
});

describe('administrator access boundaries', () => {
  it.each([
    ['GET', '/api/overview'],
    ['GET', '/api/config'],
    ['GET', '/api/events'],
    ['GET', '/api/events/unknown'],
    ['POST', '/api/events/unknown/replay'],
    ['POST', '/api/demo/run'],
    ['POST', '/api/demo/recover/unknown'],
  ] as const)('requires a key before inspecting %s %s', async (method, url) => {
    const { app, store } = await fixture(true);
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'unauthorized',
      message: 'A valid administrator key is required.',
    });
    expect(store.overview().total).toBe(0);
  });

  it('rejects invalid credentials and checks auth before consuming a large body', async () => {
    const { app } = await fixture(true);
    expect(
      (await app.inject({ url: '/api/overview', headers: { 'x-api-key': 'wrong' } })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/run',
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(70_000),
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps health public while exposing config only to an authenticated operator', async () => {
    const { app } = await fixture();
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const response = await app.inject({ url: '/api/config', headers: auth });
    expect(response.json()).toEqual({ demoMode: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(ADMIN_KEY);
    expect(response.body).not.toContain(INBOUND_SECRET);
    expect(response.body).not.toContain(DELIVERY_SECRET);
  });

  it('does not expose operator data through encoded route spellings', async () => {
    const { app } = await fixture();
    await signedPost(app);
    for (const url of ['/%61pi/overview', '/api%2foverview', '/api/%65vents']) {
      const response = await app.inject({ url });
      expect([401, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('invoice.created');
      expect(response.body).not.toContain('"total":1');
    }
  });

  it('serves the dashboard without credentials and applies restrictive browser headers', async () => {
    const { app } = await fixture();
    const response = await app.inject('/');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("form-action 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.body).not.toContain(ADMIN_KEY);
    expect(response.body).not.toContain(INBOUND_SECRET);
    expect(response.body).not.toContain(DELIVERY_SECRET);
  });
});

describe('authenticated webhook ingestion', () => {
  it('accepts new events, suppresses semantically identical duplicates, and rejects id reuse', async () => {
    const { app, store } = await fixture();
    const first = await signedPost(app);
    expect(first.statusCode).toBe(202);
    expect(first.json().duplicate).toBe(false);
    const alternateSerialization = JSON.stringify({
      data: { amount: 42, account: 'synthetic-001' },
      occurredAt: event.occurredAt,
      type: event.type,
      id: event.id,
    });
    const duplicate = await signedPost(app, alternateSerialization);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(duplicate.json().delivery.deliveryId).toBe(first.json().delivery.deliveryId);
    const conflict = await signedPost(app, JSON.stringify({ ...event, data: { amount: 99 } }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('idempotency_conflict');
    expect(store.overview().total).toBe(1);
    expect(store.get(event.id)?.event.data.amount).toBe(42);
  });

  it('rejects altered bytes even if the attacker preserves the same JSON meaning', async () => {
    const { app, store } = await fixture();
    const body = JSON.stringify(event);
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/events',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': signPayload(body, INBOUND_SECRET, TIMESTAMP),
      },
      payload: body + ' ',
    });
    expect(response.statusCode).toBe(401);
    expect(store.overview().total).toBe(0);
  });

  it.each([-301, 301])('rejects signed requests with a %i-second timestamp skew', async (skew) => {
    const { app, store } = await fixture();
    const response = await signedPost(app, JSON.stringify(event), INBOUND_SECRET, TIMESTAMP + skew);
    expect(response.statusCode).toBe(401);
    expect(store.overview().total).toBe(0);
  });

  it('authenticates before parsing malformed JSON, then rejects authenticated malformed data', async () => {
    const { app, store } = await fixture();
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/events',
      headers: { 'content-type': 'application/json' },
      payload: '{not JSON',
    });
    expect(unsigned.statusCode).toBe(401);
    const signed = await signedPost(app, '{not JSON');
    expect(signed.statusCode).toBe(400);
    expect(signed.json().error).toBe('invalid_json');
    expect(store.overview().total).toBe(0);
  });

  it.each([
    null,
    [],
    { ...event, id: '' },
    { ...event, id: 'not/an/id' },
    { ...event, type: 'event type' },
    { ...event, occurredAt: 'not a timestamp' },
    { ...event, occurredAt: '2026-02-30T12:00:00Z' },
    { ...event, occurredAt: '2026-10-13' },
    { ...event, data: [] },
    { ...event, data: null },
    { ...event, unexpected: 'field' },
    { id: event.id, type: event.type, data: {} },
  ])('does not enqueue a structurally invalid event %j', async (invalid) => {
    const { app, store } = await fixture();
    const response = await signedPost(app, JSON.stringify(invalid));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_event');
    expect(store.overview().total).toBe(0);
  });

  it('rejects invalid UTF-8 and caps the signed payload at 64 KB', async () => {
    const { app, store } = await fixture();
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"value":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    expect((await signedPost(app, invalidUtf8)).json().error).toBe('invalid_json');
    const oversized = await signedPost(
      app,
      JSON.stringify({ ...event, data: { text: 'x'.repeat(65_536) } }),
    );
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error).toBe('payload_too_large');
    expect(store.overview().total).toBe(0);
  });
});

describe('operator inspection and replay', () => {
  it.each([
    '?status=unknown',
    '?status=',
    '?status=dead&status=pending',
    '?limit=0',
    '?limit=101',
    '?limit=1.5',
    '?limit=1&limit=2',
  ])('rejects an invalid inspection query %s', async (query) => {
    const { app } = await fixture();
    const response = await app.inject({ url: '/api/events' + query, headers: auth });
    expect(response.statusCode).toBe(400);
  });

  it('returns the public API envelopes and limits only authenticated inspection', async () => {
    const { app } = await fixture();
    await signedPost(app);
    const list = await app.inject({
      url: '/api/events?status=pending&limit=1',
      headers: auth,
    });
    expect(list.json().events).toHaveLength(1);
    const detail = await app.inject({ url: '/api/events/' + event.id, headers: auth });
    expect(detail.json().delivery.event).toEqual(event);
    expect((await app.inject({ url: '/api/overview', headers: auth })).json()).toMatchObject({
      total: 1,
      counts: { pending: 1 },
    });
    expect((await app.inject({ url: '/api/events/missing', headers: auth })).statusCode).toBe(404);
  });

  it('replays a dead delivery without discarding its previous failure history', async () => {
    const { app, store } = await fixture();
    await signedPost(app);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/events/missing/replay',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    const notDead = await app.inject({
      method: 'POST',
      url: '/api/events/' + event.id + '/replay',
      headers: auth,
    });
    expect(notDead.statusCode).toBe(409);
    const claim = store.claim(NOW, 10_000)!;
    store.finish(
      claim,
      { ok: false, retryable: false, statusCode: 422, error: 'Synthetic rejection.' },
      NOW + 1,
    );
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/events/' + event.id + '/replay',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(store.get(event.id)?.status).toBe('dead');
    const replay = await app.inject({
      method: 'POST',
      url: '/api/events/' + event.id + '/replay',
      headers: auth,
    });
    expect(replay.statusCode).toBe(200);
    expect(store.get(event.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      generation: 1,
      history: [{ result: 'failed', statusCode: 422 }],
    });
  });

  it('sanitizes unexpected failures and leaves database lifetime to its owner', async () => {
    const { app, store } = await fixture();
    const secretError = '/private/service.db synthetic credential ' + ADMIN_KEY;
    vi.spyOn(store, 'overview').mockImplementationOnce(() => {
      throw new Error(secretError);
    });
    const response = await app.inject({ url: '/api/overview', headers: auth });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secretError);
    await app.close();
    expect(store.overview().total).toBe(0);
  });
});

describe('synthetic receiver and operator recovery', () => {
  it('hides demo endpoints outside demo mode', async () => {
    const { app } = await fixture();
    const run = await app.inject({ method: 'POST', url: '/api/demo/run', headers: auth });
    expect(run.statusCode).toBe(404);
    const receiver = await signedPost(
      app,
      JSON.stringify(event),
      DELIVERY_SECRET,
      TIMESTAMP,
      '/demo/receiver',
    );
    expect(receiver.statusCode).toBe(404);
  });

  it('seeds three distinct deliveries, suppresses a duplicate, and uses destination-only authentication', async () => {
    const { app, store } = await fixture(true);
    const run = await app.inject({ method: 'POST', url: '/api/demo/run', headers: auth });
    expect(run.statusCode).toBe(202);
    const body = run.json();
    expect(Object.keys(body.ids).sort()).toEqual(['permanent', 'retry', 'success']);
    expect(body.duplicateSuppressed).toBe(true);
    expect(store.overview().total).toBe(3);
    const success = store.get(body.ids.success)!.event;
    const wrongSecret = await signedPost(
      app,
      JSON.stringify(success),
      INBOUND_SECRET,
      TIMESTAMP,
      '/demo/receiver',
    );
    expect(wrongSecret.statusCode).toBe(401);
    const delivered = await signedPost(
      app,
      JSON.stringify(success),
      DELIVERY_SECRET,
      TIMESTAMP,
      '/demo/receiver',
    );
    expect(delivered.statusCode).toBe(200);
    const retry = store.get(body.ids.retry)!.event;
    for (const status of [503, 503, 200]) {
      const response = await signedPost(
        app,
        JSON.stringify(retry),
        DELIVERY_SECRET,
        TIMESTAMP,
        '/demo/receiver',
      );
      expect(response.statusCode).toBe(status);
    }
  });

  it('recovers only a dead synthetic permanent-failure event after operator authorization', async () => {
    const { app, store, receiver } = await fixture(true);
    await signedPost(app);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/demo/recover/' + event.id,
          headers: auth,
        })
      ).json().error,
    ).toBe('not_demo_event');
    const run = await app.inject({ method: 'POST', url: '/api/demo/run', headers: auth });
    const id: string = run.json().ids.permanent;
    const demoEvent = store.get(id)!.event;
    const beforeDead = await app.inject({
      method: 'POST',
      url: '/api/demo/recover/' + id,
      headers: auth,
    });
    expect(beforeDead.statusCode).toBe(409);
    let claim = store.claim(NOW, 10_000)!;
    while (claim.event.id !== id) {
      store.finish(claim, { ok: true, retryable: false, statusCode: 200, error: null }, NOW + 1);
      claim = store.claim(NOW, 10_000)!;
    }
    store.finish(claim, receiver.handle(demoEvent), NOW + 1);
    expect(store.get(id)?.status).toBe('dead');
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/demo/recover/' + id,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(receiver.handle(demoEvent).statusCode).toBe(422);
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/demo/recover/' + id,
      headers: auth,
    });
    expect(recovered.statusCode).toBe(200);
    expect(store.get(id)).toMatchObject({ status: 'pending', generation: 1 });
    expect(receiver.handle(demoEvent).statusCode).toBe(200);
  });
});
