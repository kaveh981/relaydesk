import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Attempt,
  Claim,
  DeliveryDetail,
  DeliveryResult,
  DeliveryStatus,
  DeliverySummary,
  IngestResult,
  Overview,
  StoreOptions,
  WebhookEvent,
} from './types.js';

interface Row {
  id: string;
  delivery_id: string;
  type: string;
  status: DeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  generation: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  event_json: string;
}

const joined = `SELECT e.id, e.type, e.event_json, d.id AS delivery_id, d.status,
  d.attempt_count, d.max_attempts, d.generation, d.next_attempt_at, d.last_error,
  d.created_at, d.updated_at FROM deliveries d JOIN events e ON e.id = d.event_id`;
const iso = (timestamp: number) => new Date(timestamp).toISOString();

/** Canonical JSON makes retry identity insensitive to object-key ordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class RelayStore {
  private readonly db: DatabaseSync;
  private readonly options: StoreOptions;

  constructor(path: string, options: Partial<StoreOptions> = {}) {
    this.options = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000, ...options };
    if (
      !Number.isInteger(this.options.maxAttempts) ||
      this.options.maxAttempts < 1 ||
      this.options.maxAttempts > 20 ||
      !Number.isSafeInteger(this.options.baseDelayMs) ||
      !Number.isSafeInteger(this.options.maxDelayMs) ||
      this.options.baseDelayMs < 1 ||
      this.options.maxDelayMs < this.options.baseDelayMs
    ) {
      throw new Error('Invalid retry policy');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, event_json TEXT NOT NULL, payload_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        status TEXT NOT NULL CHECK(status IN ('pending','processing','retrying','delivered','dead')),
        attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER, lease_token TEXT, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id),
        number INTEGER NOT NULL, generation INTEGER NOT NULL, lease_token TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('in-flight','delivered','failed','abandoned')),
        status_code INTEGER, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER,
        UNIQUE(delivery_id, generation, number)
      ) STRICT;
      PRAGMA user_version=1;`);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ingest(event: WebhookEvent, now: number): IngestResult {
    const json = canonicalJson(event);
    const hash = createHash('sha256').update(json).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT payload_hash FROM events WHERE id=?').get(event.id);
      if (existing)
        return {
          duplicate: true,
          conflict: existing.payload_hash !== hash,
          delivery: this.get(event.id)!,
        };
      this.db
        .prepare('INSERT INTO events(id,type,event_json,payload_hash) VALUES(?,?,?,?)')
        .run(event.id, event.type, json, hash);
      this.db
        .prepare(
          `INSERT INTO deliveries(id,event_id,status,max_attempts,next_attempt_at,created_at,updated_at)
        VALUES(?,?,'pending',?,?,?,?)`,
        )
        .run(randomUUID(), event.id, this.options.maxAttempts, now, now, now);
      return { duplicate: false, conflict: false, delivery: this.get(event.id)! };
    });
  }

  private summary(row: Row): DeliverySummary {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      type: row.type,
      status: row.status,
      attempts: row.attempt_count,
      maxAttempts: row.max_attempts,
      generation: row.generation,
      nextAttemptAt: ['pending', 'retrying'].includes(row.status) ? iso(row.next_attempt_at) : null,
      lastError: row.last_error,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  list(status?: DeliveryStatus, limit = 50): DeliverySummary[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const query = this.db.prepare(
      `${joined}${status ? ' WHERE d.status=?' : ''} ORDER BY d.created_at DESC,e.id LIMIT ?`,
    );
    const rows = (status ? query.all(status, bounded) : query.all(bounded)) as unknown as Row[];
    return rows.map((row) => this.summary(row));
  }

  get(id: string): DeliveryDetail | undefined {
    const row = this.db.prepare(`${joined} WHERE e.id=?`).get(id) as unknown as Row | undefined;
    if (!row) return undefined;
    const rows = this.db
      .prepare('SELECT * FROM attempts WHERE delivery_id=? ORDER BY generation,number')
      .all(row.delivery_id);
    const history: Attempt[] = rows.map((attempt) => ({
      id: String(attempt.id),
      number: Number(attempt.number),
      generation: Number(attempt.generation),
      result: attempt.result as Attempt['result'],
      statusCode: attempt.status_code === null ? null : Number(attempt.status_code),
      error: attempt.error === null ? null : String(attempt.error),
      startedAt: iso(Number(attempt.started_at)),
      finishedAt: attempt.finished_at === null ? null : iso(Number(attempt.finished_at)),
      durationMs: attempt.duration_ms === null ? null : Number(attempt.duration_ms),
    }));
    return { ...this.summary(row), event: JSON.parse(row.event_json) as WebhookEvent, history };
  }

  overview(): Overview {
    const counts = { pending: 0, processing: 0, retrying: 0, delivered: 0, dead: 0 };
    const rows = this.db
      .prepare('SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status')
      .all();
    for (const row of rows) counts[row.status as DeliveryStatus] = Number(row.count);
    return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  }

  claim(now: number, leaseMs: number): Claim | undefined {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new Error('Lease must be a positive integer');
    return this.transaction(() => {
      // An expired claim may have reached the receiver. Record uncertainty before redelivery.
      this.db
        .prepare(
          `UPDATE attempts SET result='abandoned',error='Worker lease expired; delivery outcome unknown',
        finished_at=?,duration_ms=?-started_at WHERE result='in-flight' AND delivery_id IN
        (SELECT id FROM deliveries WHERE status='processing' AND lease_until<=?)`,
        )
        .run(now, now, now);
      this.db
        .prepare(
          `UPDATE deliveries SET status=CASE WHEN attempt_count>=max_attempts THEN 'dead' ELSE 'retrying' END,
        lease_until=NULL,lease_token=NULL,next_attempt_at=?,updated_at=?,last_error='Worker lease expired; delivery outcome unknown'
        WHERE status='processing' AND lease_until<=?`,
        )
        .run(now, now, now);
      const row = this.db
        .prepare(
          `${joined} WHERE d.status IN ('pending','retrying') AND d.next_attempt_at<=?
        ORDER BY d.next_attempt_at,d.created_at,e.id LIMIT 1`,
        )
        .get(now) as unknown as Row | undefined;
      if (!row) return undefined;
      const token = randomUUID();
      const attemptId = randomUUID();
      this.db
        .prepare(
          `UPDATE deliveries SET status='processing',attempt_count=attempt_count+1,lease_until=?,lease_token=?,updated_at=? WHERE id=?`,
        )
        .run(now + leaseMs, token, now, row.delivery_id);
      this.db
        .prepare(
          `INSERT INTO attempts(id,delivery_id,number,generation,lease_token,result,started_at)
        VALUES(?,?,?,?,?,'in-flight',?)`,
        )
        .run(attemptId, row.delivery_id, row.attempt_count + 1, row.generation, token, now);
      return {
        deliveryId: row.delivery_id,
        token,
        attemptId,
        attempt: row.attempt_count + 1,
        generation: row.generation,
        leaseUntil: now + leaseMs,
        event: JSON.parse(row.event_json) as WebhookEvent,
      };
    });
  }

  finish(claim: Claim, result: DeliveryResult, now: number): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT max_attempts FROM deliveries WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`,
        )
        .get(claim.deliveryId, claim.token, now);
      if (!row) return false;
      const retry = !result.ok && result.retryable && claim.attempt < Number(row.max_attempts);
      const exponential = Math.min(
        this.options.maxDelayMs,
        this.options.baseDelayMs * 2 ** (claim.attempt - 1),
      );
      const delay = Math.min(
        this.options.maxDelayMs,
        Math.max(exponential, result.retryAfterMs ?? 0),
      );
      const status = result.ok ? 'delivered' : retry ? 'retrying' : 'dead';
      this.db
        .prepare(
          `UPDATE attempts SET result=?,status_code=?,error=?,finished_at=?,duration_ms=?-started_at WHERE id=?`,
        )
        .run(
          result.ok ? 'delivered' : 'failed',
          result.statusCode,
          result.error,
          now,
          now,
          claim.attemptId,
        );
      this.db
        .prepare(
          `UPDATE deliveries SET status=?,next_attempt_at=?,last_error=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=?`,
        )
        .run(status, now + (retry ? delay : 0), result.error, now, claim.deliveryId);
      return true;
    });
  }

  replay(id: string, now: number): 'ok' | 'missing' | 'not-dead' {
    return this.transaction(() => {
      const event = this.get(id);
      if (!event) return 'missing';
      if (event.status !== 'dead') return 'not-dead';
      this.db
        .prepare(
          `UPDATE deliveries SET status='pending',attempt_count=0,generation=generation+1,next_attempt_at=?,
        lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE event_id=?`,
        )
        .run(now, now, id);
      return 'ok';
    });
  }
}
