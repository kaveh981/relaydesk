import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { httpTransport, retryAfterMilliseconds } from '../src/transport.js';
import { verifySignature } from '../src/signature.js';
import type { Claim } from '../src/types.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const claim: Claim = {
  deliveryId: 'delivery-stable',
  token: 'lease',
  attemptId: 'attempt',
  attempt: 1,
  generation: 0,
  leaseUntil: 10000,
  event: {
    id: 'evt-1',
    type: 'invoice.paid',
    occurredAt: new Date(0).toISOString(),
    data: { example: true },
  },
};
async function receiver(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return `http://127.0.0.1:${address.port}`;
}
describe('HTTP delivery boundary', () => {
  it('sends signed payloads and stable identities on actual HTTP requests', async () => {
    let count = 0;
    const url = await receiver((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        expect(
          verifySignature(
            raw,
            req.headers['x-webhook-signature'] as string,
            'outbound-secret',
            1000,
          ),
        ).toBe(true);
        expect(req.headers['x-delivery-id']).toBe('delivery-stable');
        expect(JSON.parse(raw.toString()).id).toBe('evt-1');
        count += 1;
        res.writeHead(204);
        res.end();
      });
    });
    const transport = httpTransport({
      url,
      secret: 'outbound-secret',
      timeoutMs: 1000,
      now: () => 1000,
    });
    expect((await transport(claim)).ok).toBe(true);
    expect((await transport({ ...claim, attempt: 2 })).ok).toBe(true);
    expect(count).toBe(2);
  });

  it('honours rate-limit metadata and treats ordinary 4xx as permanent', async () => {
    let status = 429;
    const url = await receiver((_req, res) => {
      res.writeHead(status, { 'retry-after': '2' });
      res.end('receiver-secret-must-not-be-stored');
    });
    const transport = httpTransport({ url, secret: 'secret', timeoutMs: 1000 });
    expect(await transport(claim)).toEqual({
      ok: false,
      retryable: true,
      statusCode: 429,
      error: 'Receiver returned HTTP 429',
      retryAfterMs: 2000,
    });
    status = 400;
    expect((await transport(claim)).retryable).toBe(false);
  });

  it('does not follow redirects and bounds stalled receivers by a timeout', async () => {
    let redirected = false;
    const url = await receiver((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/secret' });
        res.end();
      } else if (req.url === '/secret') {
        redirected = true;
        res.end();
      }
    });
    const transport = (path: string) =>
      httpTransport({ url: `${url}${path}`, secret: 'secret', timeoutMs: 50 });
    expect(await transport('/redirect')(claim)).toMatchObject({
      ok: false,
      retryable: false,
      statusCode: 302,
    });
    expect(redirected).toBe(false);
    expect(await transport('/stalled')(claim)).toMatchObject({
      ok: false,
      retryable: true,
      statusCode: null,
      error: 'Delivery request failed or timed out',
    });
  });

  it('parses Retry-After seconds and dates without accepting malformed values', () => {
    expect(retryAfterMilliseconds('2', 0)).toBe(2000);
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:03 GMT', 1000)).toBe(2000);
    expect(retryAfterMilliseconds('nonsense', 0)).toBeUndefined();
    expect(retryAfterMilliseconds(null, 0)).toBeUndefined();
  });
});
