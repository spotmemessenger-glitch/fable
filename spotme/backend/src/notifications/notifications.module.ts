import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
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
import { ApnsTransport } from './transport/apns.transport';
import { WebPushTransport } from './transport/web-push.transport';
import { DesktopTransport } from './transport/desktop.transport';
import { OneSignalTransport } from './transport/onesignal.transport';
import { NovuTransport } from './transport/novu.transport';
import { ContentlessEnvelopeBuilder } from './envelope/contentless-envelope.builder';
import { EncryptedEnvelopeBuilder } from './envelope/encrypted-envelope.builder';
import { NotificationMetrics } from './metrics/metrics.service';
import { NotificationMetricsController } from './metrics/metrics.controller';
import { NotificationHealthService } from './health/health.service';
import { NotificationHealthController } from './health/health.controller';
import { ReceiptService } from './receipts/receipt.service';
import { NotificationsController } from './notifications.controller';
import { NotificationService } from './notification.service';
import { NotificationProducer } from './producers/notification-producer';

/**
 * The Notifications V2 platform module — an INERT DynamicModule.
 *
 * ⚠️  IMPORT IT VIA `NotificationsModule.register()`, NEVER `NotificationsModule`
 * directly.  ⚠️
 *
 * `register()` reads `NOTIFICATIONS_V2_ENABLED` at boot:
 *   - OFF (the default): returns an EMPTY module — NO providers, NO controllers,
 *     NOT global. Importing it in `AppModule` constructs nothing, schedules no
 *     `@Cron`, mounts no route, and provides no injectable to any other module.
 *     The producer hook in `rooms.gateway` holds it as an OPTIONAL dependency, so
 *     with the flag off it resolves to `undefined` and existing behaviour is
 *     BYTE-IDENTICAL.
 *   - ON: returns the full, `@Global()` module so `NotificationProducer` (and the
 *     query services) are injectable app-wide, the outbox `@Cron` schedules, and
 *     `/metrics`, `/notif-health`, `/api/notifications` mount.
 *
 * The flag is ALSO read at enqueue/claim time inside the services (the ADR-007
 * "verdict always computed" shadow discipline), so the DynamicModule is the
 * coarse outer gate and the per-call flag is the fine inner gate.
 *
 * PrismaService resolves from the global `PrismaModule` at wiring time.
 */
const PROVIDERS: Provider[] = [
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
  ApnsTransport,
  WebPushTransport,
  DesktopTransport,
  OneSignalTransport,
  NovuTransport,
  ContentlessEnvelopeBuilder,
  EncryptedEnvelopeBuilder,
  NotificationMetrics,
  NotificationHealthService,
  ReceiptService,
  NotificationService,
  NotificationProducer,
];

const CONTROLLERS: Type<unknown>[] = [
  NotificationMetricsController,
  NotificationHealthController,
  NotificationsController,
];

@Module({})
export class NotificationsModule {
  /**
   * Wire the platform ONLY when the master flag is set. With it off this returns
   * an empty module, so importing `NotificationsModule.register()` in `AppModule`
   * is completely inert (the isolation fence asserts exactly this).
   */
  static register(): DynamicModule {
    if (!new NotificationFlags().enabled) {
      return { module: NotificationsModule };
    }
    return {
      module: NotificationsModule,
      global: true,
      controllers: CONTROLLERS,
      providers: PROVIDERS,
      exports: [
        NotificationService,
        NotificationProducer,
        PreferenceService,
        ReceiptService,
        NotificationMetrics,
        NotificationHealthService,
      ],
    };
  }
}
