import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { NotificationClass } from '../catalog/notification-class';
import { TransportName } from '../transport/notification-transport';

/**
 * The first real consumer of `prom-client` (design §13, ADR-009 §4) — the
 * observability gap's first feed. Content-free by construction: every label is a
 * class / transport / reason / provider-code; there is NO per-user content and
 * NO message correlation (crypto guide §11: never log keys, content, plaintext).
 *
 * Its own `Registry` (not the global default) so it is fully isolated: nothing
 * is exposed until the module is wired in and the `/metrics` route is mounted —
 * neither of which happens in this branch.
 */
@Injectable()
export class NotificationMetrics {
  readonly registry = new Registry();

  private readonly enqueued: Counter<string>;
  private readonly suppressed: Counter<string>;
  private readonly sent: Counter<string>;
  private readonly delivered: Counter<string>;
  private readonly opened: Counter<string>;
  private readonly actioned: Counter<string>;
  private readonly failed: Counter<string>;
  private readonly retried: Counter<string>;
  private readonly abandoned: Counter<string>;
  private readonly tokensPruned: Counter<string>;
  private readonly fanoutLatency: Histogram<string>;
  private readonly outboxDepth: Gauge<string>;
  private readonly oldestQueued: Gauge<string>;

  constructor() {
    // Process/runtime metrics too — this is the app's first /metrics feed.
    collectDefaultMetrics({ register: this.registry });

    this.enqueued = new Counter({
      name: 'notif_enqueued_total',
      help: 'Outbox rows created (post-dedupe)',
      labelNames: ['class'],
      registers: [this.registry],
    });
    this.suppressed = new Counter({
      name: 'notif_suppressed_total',
      help: 'Notifications suppressed before send, by reason',
      labelNames: ['class', 'reason'],
      registers: [this.registry],
    });
    this.sent = new Counter({
      name: 'notif_sent_total',
      help: 'Provider-accepted sends',
      labelNames: ['class', 'transport'],
      registers: [this.registry],
    });
    this.delivered = new Counter({
      name: 'notif_delivered_total',
      help: 'Device delivery receipts',
      labelNames: ['class', 'transport'],
      registers: [this.registry],
    });
    this.opened = new Counter({
      name: 'notif_opened_total',
      help: 'Device open (tap) receipts',
      labelNames: ['class', 'transport'],
      registers: [this.registry],
    });
    this.actioned = new Counter({
      name: 'notif_actioned_total',
      help: 'User actions on a delivered notification (reply/read/accept/…)',
      labelNames: ['class', 'transport', 'action'],
      registers: [this.registry],
    });
    this.failed = new Counter({
      name: 'notif_failed_total',
      help: 'Permanent failures, by provider code',
      labelNames: ['class', 'transport', 'code'],
      registers: [this.registry],
    });
    this.retried = new Counter({
      name: 'notif_retried_total',
      help: 'Transient retries',
      labelNames: ['class', 'transport'],
      registers: [this.registry],
    });
    this.abandoned = new Counter({
      name: 'notif_abandoned_total',
      help: 'Dead-lettered rows (attempts exhausted)',
      labelNames: ['class', 'transport'],
      registers: [this.registry],
    });
    this.tokensPruned = new Counter({
      name: 'notif_tokens_pruned_total',
      help: 'Dead tokens/subscriptions pruned',
      labelNames: ['transport', 'reason'],
      registers: [this.registry],
    });
    this.fanoutLatency = new Histogram({
      name: 'notif_fanout_latency_seconds',
      help: 'enqueue → provider-accept latency',
      labelNames: ['class', 'transport'],
      buckets: [0.05, 0.1, 0.3, 0.5, 1, 3, 10, 30],
      registers: [this.registry],
    });
    this.outboxDepth = new Gauge({
      name: 'notif_outbox_depth',
      help: 'Outbox row count by status',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.oldestQueued = new Gauge({
      name: 'notif_outbox_oldest_seconds',
      help: 'Age of the oldest queued row (stuck-queue signal)',
      registers: [this.registry],
    });
  }

  onEnqueued(cls: NotificationClass): void {
    this.enqueued.inc({ class: cls });
  }
  onSuppressed(cls: NotificationClass, reason: string): void {
    this.suppressed.inc({ class: cls, reason });
  }
  onSent(cls: NotificationClass, transport: TransportName): void {
    this.sent.inc({ class: cls, transport });
  }
  onDelivered(cls: NotificationClass, transport: TransportName): void {
    this.delivered.inc({ class: cls, transport });
  }
  onOpened(cls: NotificationClass, transport: TransportName): void {
    this.opened.inc({ class: cls, transport });
  }
  onActioned(cls: NotificationClass, transport: TransportName, action: string): void {
    this.actioned.inc({ class: cls, transport, action });
  }
  onFailed(cls: NotificationClass, transport: TransportName, code: string): void {
    this.failed.inc({ class: cls, transport, code });
  }
  onRetried(cls: NotificationClass, transport: TransportName): void {
    this.retried.inc({ class: cls, transport });
  }
  onAbandoned(cls: NotificationClass, transport: TransportName): void {
    this.abandoned.inc({ class: cls, transport });
  }
  onTokenPruned(transport: TransportName, reason: string): void {
    this.tokensPruned.inc({ transport, reason });
  }
  observeFanoutLatency(cls: NotificationClass, transport: TransportName, seconds: number): void {
    this.fanoutLatency.observe({ class: cls, transport }, seconds);
  }
  setOutboxDepth(status: string, depth: number): void {
    this.outboxDepth.set({ status }, depth);
  }
  setOldestQueuedSeconds(seconds: number): void {
    this.oldestQueued.set(seconds);
  }

  /** Prometheus text exposition — served by the (unmounted) metrics controller. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
