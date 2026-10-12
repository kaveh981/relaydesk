import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../src/signature.js';

const SECRET = 'inbound-test-secret-only';
const TIMESTAMP = 1_800_000_000;
const NOW = TIMESTAMP * 1000;

describe('webhook wire authentication', () => {
  it('matches an independently calculated signature over exact UTF-8 bytes', () => {
    const body = Buffer.from('{ "message": "café ☕" }\n', 'utf8');
    const mac = createHmac('sha256', SECRET)
      .update(Buffer.from(String(TIMESTAMP) + '.'))
      .update(body)
      .digest('hex');
    const header = 't=' + TIMESTAMP + ',v1=' + mac;
    expect(signPayload(body, SECRET, TIMESTAMP)).toBe(header);
    expect(verifySignature(body, header, SECRET, NOW)).toBe(true);
  });

  it('rejects a reserialized equivalent object and wrong destination secret', () => {
    const raw = Buffer.from('{ "amount": 42, "currency": "USD" }');
    const header = signPayload(raw, SECRET, TIMESTAMP);
    expect(
      verifySignature(Buffer.from('{"amount":42,"currency":"USD"}'), header, SECRET, NOW),
    ).toBe(false);
    expect(verifySignature(raw, header, 'other-secret', NOW)).toBe(false);
  });

  it.each([-301, 301])('rejects timestamp skew of %i seconds', (skew) => {
    const body = Buffer.from('{}');
    const header = signPayload(body, SECRET, TIMESTAMP + skew);
    expect(verifySignature(body, header, SECRET, NOW)).toBe(false);
  });

  it.each([-300, 300])('accepts the inclusive %i-second tolerance boundary', (skew) => {
    const body = Buffer.from('{}');
    const header = signPayload(body, SECRET, TIMESTAMP + skew);
    expect(verifySignature(body, header, SECRET, NOW)).toBe(true);
  });

  it.each([
    undefined,
    '',
    't=1800000000,v1=not-a-signature',
    't=1800000000,v1=' + '0'.repeat(63),
    't=1800000000,v1=' + 'z'.repeat(64),
    't=01800000000,v1=' + '0'.repeat(64),
    't=-1,v1=' + '0'.repeat(64),
    't=1.5,v1=' + '0'.repeat(64),
    't=1800000000,v1=' + '0'.repeat(64) + ',t=1800000000',
  ])('rejects malformed or ambiguous signature header %s', (header) => {
    expect(verifySignature(Buffer.from('{}'), header, SECRET, NOW)).toBe(false);
  });

  it('does not allow authentication when server clock or secret is invalid', () => {
    const body = Buffer.from('{}');
    const header = signPayload(body, SECRET, TIMESTAMP);
    expect(verifySignature(body, header, SECRET, Number.NaN)).toBe(false);
    expect(verifySignature(body, header, '', NOW)).toBe(false);
    expect(() => signPayload(body, SECRET, 1.5)).toThrow();
  });
});
