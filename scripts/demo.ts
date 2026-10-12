import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signPayload } from '../src/signature.js';
import type { DeliveryDetail, WebhookEvent } from '../src/types.js';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const adminKey = process.env.ADMIN_API_KEY ?? 'sample-admin-key-change-me';
const secret = process.env.WEBHOOK_SECRET ?? 'sample-webhook-secret-change-me';
const batch = `demo-${randomUUID()}`;
const ids = {
  success: `${batch}-success`,
  retry: `${batch}-retry`,
  permanent: `${batch}-permanent`,
};
const request = async (path: string, method = 'GET') => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-api-key': adminKey },
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
};
const config = await request('/api/config');
assert(config.demoMode, 'The demo script is limited to DEMO_MODE=true.');
const post = async (event: WebhookEvent) => {
  const body = JSON.stringify(event);
  return fetch(`${base}/webhooks/events`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(5000),
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signPayload(body, secret, Math.floor(Date.now() / 1000)),
    },
  });
};
const event = (scenario: keyof typeof ids): WebhookEvent => ({
  id: ids[scenario],
  type: 'invoice.paid',
  occurredAt: new Date().toISOString(),
  data: {
    demoScenario: scenario,
    amount: 4900,
    currency: 'USD',
    synthetic: true,
    source: 'relaydesk-demo',
  },
});
const successful = event('success');
assert.equal((await post(successful)).status, 202);
assert.equal((await post(successful)).status, 200);
assert.equal((await post({ ...successful, data: { ...successful.data, amount: 1 } })).status, 409);
assert.equal((await post(event('retry'))).status, 202);
assert.equal((await post(event('permanent'))).status, 202);
const waitFor = async (id: string, status: string) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { delivery } = (await request(`/api/events/${encodeURIComponent(id)}`)) as {
      delivery: DeliveryDetail;
    };
    if (delivery.status === status) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${id} to become ${status}`);
};
const delivered = await waitFor(ids.success, 'delivered');
const retried = await waitFor(ids.retry, 'delivered');
const dead = await waitFor(ids.permanent, 'dead');
assert.equal(delivered.attempts, 1);
assert.equal(retried.attempts, 3);
assert.equal(dead.attempts, 1);
assert.equal((await fetch(`${base}/api/events`)).status, 401);
await request(`/api/demo/recover/${encodeURIComponent(ids.permanent)}`, 'POST');
const recovered = await waitFor(ids.permanent, 'delivered');
assert.equal(recovered.deliveryId, dead.deliveryId);
assert.equal(recovered.generation, 1);
assert.equal(recovered.history.length, 2);
console.log(
  JSON.stringify(
    {
      result: 'PASS',
      duplicateSuppressed: true,
      conflictingPayloadRejected: true,
      adminProtected: true,
      deliveries: [
        { id: delivered.id, attempts: 1 },
        { id: retried.id, attempts: 3 },
        { id: recovered.id, recoveryCycles: 1, auditEntries: 2 },
      ],
    },
    null,
    2,
  ),
);
