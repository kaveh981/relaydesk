import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('safe configuration', () => {
  it('starts a loopback-only demo with explicit sample keys', () => {
    expect(loadConfig({})).toMatchObject({
      host: '127.0.0.1',
      demoMode: true,
      deliveryUrl: 'http://127.0.0.1:3000/demo/receiver',
    });
    expect(() => loadConfig({ DELIVERY_URL: 'https://example.com' })).toThrow('loopback');
  });
  it('requires non-demo secrets and HTTPS and rejects embedded URL credentials', () => {
    const env = {
      DEMO_MODE: 'false',
      DELIVERY_URL: 'https://receiver.example/webhooks',
      ADMIN_API_KEY: 'a'.repeat(32),
      WEBHOOK_SECRET: 'b'.repeat(32),
      DELIVERY_SECRET: 'c'.repeat(32),
    };
    expect(loadConfig(env).demoMode).toBe(false);
    expect(() => loadConfig({ ...env, ADMIN_API_KEY: 'sample-admin-key-change-me' })).toThrow(
      'non-demo secret',
    );
    expect(() => loadConfig({ ...env, DELIVERY_URL: 'http://receiver.example' })).toThrow('HTTPS');
    expect(() =>
      loadConfig({ ...env, DELIVERY_URL: 'https://user:password@receiver.example' }),
    ).toThrow('credentials');
  });
  it('requires the worker lease to exceed the HTTP timeout and validates numbers', () => {
    expect(() => loadConfig({ DELIVERY_TIMEOUT_MS: '10000', WORKER_LEASE_MS: '10000' })).toThrow(
      'WORKER_LEASE_MS',
    );
    expect(() => loadConfig({ MAX_ATTEMPTS: '0' })).toThrow('MAX_ATTEMPTS');
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('integer');
    expect(() => loadConfig({ DEMO_MODE: 'sometimes' })).toThrow('DEMO_MODE');
  });
});
