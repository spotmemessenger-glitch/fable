import { Module } from '@nestjs/common';
import { NotificationFlags } from './notifications.config';
import { NotificationCatalog } from './catalog/notification-catalog';
import { NotificationRouter } from './routing/notification-router';
import { PreferenceEvaluator } from './preferences/preference-evaluator';
import { PreferenceService } from './preferences/preference.service';
import { OutboxService } from './outbox/outbox.service';
import { OutboxWorker } from './outbox/outbox.worker';
import { DeviceTargetService } from './devices/device-target.service';
import { TransportRegistry } from './transport/transport-registry';
import { FcmTransport } from './transport/fcm.transport';
import { WebPushTransport } from './transport/web-push.transport';
import { OneSignalTransport } from './transport/onesignal.transport';
import { NovuTransport } from './transport/novu.transport';
import { ContentlessEnvelopeBuilder } from './envelope/contentless-envelope.builder';
import { NotificationMetrics } from './metrics/metrics.service';
import { NotificationMetricsController } from './metrics/metrics.controller';
import { ReceiptService } from './receipts/receipt.service';
import { NotificationsController } from './notifications.controller';
import { NotificationService } from './notification.service';

/**
 * The Notifications V2 platform module.
 *
 * ⚠️  DELIBERATELY NOT IMPORTED BY `AppModule`.  ⚠️
 *
 * This is the primary isolation guarantee required by the Priority-2 build
 * rules: additive + isolated, never wired into the live app in a way that
 * ACTIVATES it. Because `AppModule` does not import this module:
 *   - none of these providers construct in the running server;
 *   - the `OutboxWorker` `@Cron` is never scheduled;
 *   - the `/metrics` and `/api/notifications` routes are never mounted;
 *   - no producer (`rooms.gateway`, `realtime.controller`) is changed to call
 *     `NotificationService.enqueue`.
 *
 * The SECOND gate is the `NOTIFICATIONS_V2_ENABLED` flag (default false), read
 * at enqueue/claim time. Activation is therefore a two-step, reviewable change:
 * import this module, then flip the flag — see
 * `docs/priority-2/rollback-push-platform.md`.
 *
 * PrismaService is resolved from the global `PrismaModule` at the point of
 * wiring; it is not imported here to keep this module free of live dependencies.
 */
@Module({
  controllers: [NotificationMetricsController, NotificationsController],
  providers: [
    NotificationFlags,
    NotificationCatalog,
    NotificationRouter,
    PreferenceEvaluator,
    PreferenceService,
    OutboxService,
    OutboxWorker,
    DeviceTargetService,
    TransportRegistry,
    FcmTransport,
    WebPushTransport,
    OneSignalTransport,
    NovuTransport,
    ContentlessEnvelopeBuilder,
    NotificationMetrics,
    ReceiptService,
    NotificationService,
  ],
  exports: [NotificationService, PreferenceService, ReceiptService, NotificationMetrics],
})
export class NotificationsModule {}
