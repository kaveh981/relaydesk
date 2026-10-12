export type DeliveryStatus = 'pending' | 'processing' | 'retrying' | 'delivered' | 'dead';

export interface WebhookEvent {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface DeliverySummary {
  id: string;
  deliveryId: string;
  type: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  generation: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  number: number;
  generation: number;
  result: 'in-flight' | 'delivered' | 'failed' | 'abandoned';
  statusCode: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface DeliveryDetail extends DeliverySummary {
  event: WebhookEvent;
  history: Attempt[];
}

export interface Overview {
  counts: Record<DeliveryStatus, number>;
  total: number;
}

export interface Claim {
  deliveryId: string;
  token: string;
  attemptId: string;
  attempt: number;
  generation: number;
  leaseUntil: number;
  event: WebhookEvent;
}

export interface DeliveryResult {
  ok: boolean;
  retryable: boolean;
  statusCode: number | null;
  error: string | null;
  retryAfterMs?: number;
}

export type Transport = (claim: Claim) => Promise<DeliveryResult>;

export interface StoreOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface IngestResult {
  duplicate: boolean;
  conflict: boolean;
  delivery: DeliveryDetail;
}

export interface AppOptions {
  store: import('./store.js').RelayStore;
  adminKey: string;
  webhookSecret: string;
  deliverySecret: string;
  demoMode: boolean;
  now?: () => number;
  logger?: boolean;
  demoReceiver?: import('./demo-receiver.js').DemoReceiver;
}
