import { Controller, Get } from '@nestjs/common';
import {
  LivenessReport,
  NotificationHealthService,
  ReadinessReport,
} from './health.service';

/**
 * `GET /notif-health/{live,ready}` — liveness + readiness (design §13).
 *
 * NOT LIVE IN THIS BRANCH: registered only by `NotificationsModule`, which is
 * imported through the inert `register()` and only mounts routes when the master
 * flag is ON. Mount behind an internal/admin scope like `/metrics` — a public
 * readiness probe leaks transport-config presence, so wiring it in is a
 * deliberate, reviewed step. The route base is `notif-health` (not `health`) so
 * it never collides with an app-level health route.
 */
@Controller('notif-health')
export class NotificationHealthController {
  constructor(private readonly health: NotificationHealthService) {}

  @Get('live')
  live(): LivenessReport {
    return this.health.liveness();
  }

  @Get('ready')
  ready(): Promise<ReadinessReport> {
    return this.health.readiness();
  }
}
