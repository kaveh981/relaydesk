import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sign the exact bytes sent over the wire, prefixed by their Unix timestamp. */
export function signPayload(
  body: string | Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error('Signature timestamp must be a non-negative integer.');
  }
  const digest = createHmac('sha256', secret)
    .update(String(timestampSeconds) + '.')
    .update(body)
    .digest('hex');
  return 't=' + timestampSeconds + ',v1=' + digest;
}

/** Reject ambiguous headers and authenticate bytes before any JSON parsing. */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number,
  toleranceSeconds = 300,
): boolean {
  if (
    !header ||
    !secret ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0
  ) {
    return false;
  }
  const match = /^t=(0|[1-9]\d{0,12}),v1=([a-fA-F0-9]{64})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(String(timestamp) + '.')
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(match[2]!, 'hex');
  return timingSafeEqual(expected, supplied);
}
