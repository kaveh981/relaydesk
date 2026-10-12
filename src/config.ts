export interface Config {
  port: number;
  host: string;
  databasePath: string;
  demoMode: boolean;
  adminKey: string;
  webhookSecret: string;
  deliverySecret: string;
  deliveryUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  leaseMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name] ?? String(fallback);
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
    const value = Number(raw);
    if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return value;
  };
  if (env.DEMO_MODE !== undefined && !['true', 'false'].includes(env.DEMO_MODE))
    throw new Error('DEMO_MODE must be true or false');
  const demoMode = env.DEMO_MODE !== 'false';
  const port = integer('PORT', 3000, 1, 65535);
  const host = env.HOST ?? '127.0.0.1';
  const secret = (name: string, fallback: string) => {
    const value = env[name] ?? (demoMode ? fallback : '');
    if (value.length < 16 || (!demoMode && value.startsWith('sample-')))
      throw new Error(`${name} requires a non-demo secret of at least 16 characters`);
    return value;
  };
  const deliveryUrl =
    env.DELIVERY_URL ?? (demoMode ? `http://127.0.0.1:${port}/demo/receiver` : '');
  const url = new URL(deliveryUrl);
  if (url.username || url.password || url.hash)
    throw new Error('DELIVERY_URL cannot contain credentials or a fragment');
  if (demoMode) {
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol)
    ) {
      throw new Error('Demo delivery must target loopback');
    }
    if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host))
      throw new Error('Invalid demo HOST');
  } else if (url.protocol !== 'https:') throw new Error('Non-demo delivery requires HTTPS');
  const baseDelayMs = integer('RETRY_BASE_MS', 1_000, 1, 60_000);
  const maxDelayMs = integer('RETRY_MAX_MS', 30_000, baseDelayMs, 3_600_000);
  const timeoutMs = integer('DELIVERY_TIMEOUT_MS', 3_000, 50, 60_000);
  const leaseMs = integer('WORKER_LEASE_MS', 10_000, timeoutMs + 1_000, 120_000);
  return {
    port,
    host,
    databasePath: env.DATABASE_PATH ?? 'data/relaydesk.sqlite',
    demoMode,
    adminKey: secret('ADMIN_API_KEY', 'sample-admin-key-change-me'),
    webhookSecret: secret('WEBHOOK_SECRET', 'sample-webhook-secret-change-me'),
    deliverySecret: secret('DELIVERY_SECRET', 'sample-delivery-secret-change-me'),
    deliveryUrl,
    maxAttempts: integer('MAX_ATTEMPTS', 4, 1, 20),
    baseDelayMs,
    maxDelayMs,
    timeoutMs,
    leaseMs,
  };
}
