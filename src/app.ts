import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { verifySignature } from './signature.js';
import type { AppOptions, DeliveryStatus, WebhookEvent } from './types.js';

const BODY_LIMIT = 64 * 1024;
const STATUSES: DeliveryStatus[] = ['pending', 'processing', 'retrying', 'delivered', 'dead'];
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function fail(reply: FastifyReply, code: number, error: string, message: string) {
  return reply.code(code).send({ error, message });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59
  );
}

function validEvent(value: unknown): value is WebhookEvent {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.every((key) => ['id', 'type', 'occurredAt', 'data'].includes(key)) &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id) &&
    typeof value.type === 'string' &&
    /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.type) &&
    validDate(value.occurredAt) &&
    isObject(value.data)
  );
}

function parseSignedEvent(
  request: FastifyRequest,
  secret: string,
  now: number,
  reply: FastifyReply,
): WebhookEvent | undefined {
  const header = request.headers['x-webhook-signature'];
  if (
    !Buffer.isBuffer(request.body) ||
    !verifySignature(request.body, typeof header === 'string' ? header : undefined, secret, now)
  ) {
    fail(reply, 401, 'invalid_signature', 'A valid, current signature is required.');
    return undefined;
  }
  let event: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
    event = JSON.parse(text) as unknown;
  } catch {
    fail(reply, 400, 'invalid_json', 'The signed body must be valid UTF-8 JSON.');
    return undefined;
  }
  if (!validEvent(event)) {
    fail(
      reply,
      400,
      'invalid_event',
      'Expected id, type, an ISO timestamp occurredAt, and an object data.',
    );
    return undefined;
  }
  return event;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  if (!options.adminKey || !options.webhookSecret || !options.deliverySecret) {
    throw new Error('Application authentication secrets must be configured.');
  }
  const app = fastify({
    bodyLimit: BODY_LIMIT,
    logger: options.logger
      ? {
          redact: [
            'req.headers.x-api-key',
            'req.headers.x-webhook-signature',
            'req.headers.authorization',
          ],
        }
      : false,
  });
  const now = options.now ?? Date.now;
  const adminDigest = createHash('sha256').update(options.adminKey).digest();

  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', CSP)
      .header('Referrer-Policy', 'no-referrer');
    const pathname = request.url.split('?')[0] ?? '';
    // Authenticate the matched route, not only its raw URL spelling.
    // Fastify normalizes percent-encoded literals while routing.
    if (!request.routeOptions.url?.startsWith('/api/') && !pathname.startsWith('/api/')) {
      return;
    }
    reply.header('Cache-Control', 'no-store');
    const key = request.headers['x-api-key'];
    if (
      typeof key !== 'string' ||
      key.length > 512 ||
      !timingSafeEqual(createHash('sha256').update(key).digest(), adminDigest)
    ) {
      return fail(reply, 401, 'unauthorized', 'A valid administrator key is required.');
    }
  });

  // Fastify receives the complete body as bytes. JSON parsing happens only
  // after signature verification inside each signed route.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler((error, request, reply) => {
    const failure = isObject(error) ? error : {};
    if (failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return fail(reply, 413, 'payload_too_large', 'Request body exceeds 64 KB.');
    }
    if (failure.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return fail(reply, 415, 'unsupported_media_type', 'Use application/json.');
    }
    if (
      typeof failure.statusCode === 'number' &&
      failure.statusCode >= 400 &&
      failure.statusCode < 500
    ) {
      return fail(reply, 400, 'invalid_request', 'The request could not be read.');
    }
    request.log.error({ err: error }, 'Request failed');
    return fail(reply, 500, 'internal_error', 'The request could not be completed.');
  });
  app.setNotFoundHandler((_request, reply) =>
    fail(reply, 404, 'not_found', 'Route was not found.'),
  );

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/config', async () => ({ demoMode: options.demoMode }));
  app.get('/api/overview', async () => options.store.overview());
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/events',
    async (request, reply) => {
      const { status, limit } = request.query;
      if (status !== undefined && !STATUSES.includes(status as DeliveryStatus)) {
        return fail(reply, 400, 'invalid_filter', 'Unknown delivery status.');
      }
      const parsedLimit = limit === undefined ? 50 : Number(limit);
      if (
        (limit !== undefined && !/^[1-9]\d*$/.test(limit)) ||
        !Number.isSafeInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > 100
      ) {
        return fail(reply, 400, 'invalid_limit', 'Limit must be between 1 and 100.');
      }
      return {
        events: options.store.list(status as DeliveryStatus | undefined, parsedLimit),
      };
    },
  );
  app.get<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const delivery = options.store.get(request.params.id);
    if (!delivery) return fail(reply, 404, 'not_found', 'Event was not found.');
    return { delivery };
  });
  app.post<{ Params: { id: string } }>('/api/events/:id/replay', async (request, reply) => {
    const result = options.store.replay(request.params.id, now());
    if (result === 'missing') return fail(reply, 404, 'not_found', 'Event was not found.');
    if (result === 'not-dead') {
      return fail(reply, 409, 'not_dead', 'Only dead events can be replayed.');
    }
    return { id: request.params.id, status: 'pending' };
  });

  app.post('/webhooks/events', async (request, reply) => {
    const event = parseSignedEvent(request, options.webhookSecret, now(), reply);
    if (!event) return;
    const result = options.store.ingest(event, now());
    if (result.conflict) {
      return fail(
        reply,
        409,
        'idempotency_conflict',
        'This event id already has a different payload.',
      );
    }
    return reply.code(result.duplicate ? 200 : 202).send({
      duplicate: result.duplicate,
      delivery: result.delivery,
    });
  });

  app.post('/api/demo/run', async (_request, reply) => {
    if (!options.demoMode || !options.demoReceiver) {
      return fail(reply, 404, 'demo_disabled', 'Demo mode is disabled.');
    }
    const batch = 'demo-' + randomUUID();
    const ids = {
      success: batch + '-success',
      retry: batch + '-retry',
      permanent: batch + '-permanent',
    };
    const createdAt = now();
    const events = Object.entries(ids).map(([scenario, id]): WebhookEvent => ({
      id,
      type: 'demo.' + scenario,
      occurredAt: new Date(createdAt).toISOString(),
      data: { source: 'relaydesk-demo', demoScenario: scenario },
    }));
    for (const event of events) options.store.ingest(event, createdAt);
    const duplicate = options.store.ingest(events[0]!, createdAt);
    return reply.code(202).send({ ids, duplicateSuppressed: duplicate.duplicate });
  });

  app.post<{ Params: { id: string } }>('/api/demo/recover/:id', async (request, reply) => {
    if (!options.demoMode || !options.demoReceiver) {
      return fail(reply, 404, 'demo_disabled', 'Demo mode is disabled.');
    }
    const id = request.params.id;
    const delivery = options.store.get(id);
    if (!delivery) return fail(reply, 404, 'not_found', 'Event was not found.');
    if (
      delivery.event.data.source !== 'relaydesk-demo' ||
      delivery.event.data.demoScenario !== 'permanent'
    ) {
      return fail(reply, 409, 'not_demo_event', 'This is not a recoverable demo event.');
    }
    if (delivery.status !== 'dead') {
      return fail(reply, 409, 'not_dead', 'Only dead events can be recovered.');
    }
    options.demoReceiver.recover(id);
    options.store.replay(id, now());
    return { id, status: 'pending' };
  });

  app.post('/demo/receiver', async (request, reply) => {
    if (!options.demoMode || !options.demoReceiver) {
      return fail(reply, 404, 'demo_disabled', 'Demo mode is disabled.');
    }
    const event = parseSignedEvent(request, options.deliverySecret, now(), reply);
    if (!event) return;
    const result = options.demoReceiver.handle(event);
    return reply.code(result.statusCode ?? 500).send({
      received: result.ok,
      message: result.ok ? 'Synthetic event delivered.' : result.error,
    });
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public/', import.meta.url)),
    prefix: '/',
    cacheControl: true,
    maxAge: 0,
    index: ['index.html'],
  });
  return app;
}
