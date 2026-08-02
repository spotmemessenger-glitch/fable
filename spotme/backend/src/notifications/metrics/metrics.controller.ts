import { Controller, Get, Header } from '@nestjs/common';
import { NotificationMetrics } from './metrics.service';

/**
 * `GET /metrics` — Prometheus text exposition (design §5.6, §13).
 *
 * NOT LIVE IN THIS BRANCH: this controller is only registered by
 * `NotificationModule`, which is deliberately NOT imported into `AppModule`. So
 * no `/metrics` route exists in the running app until the platform is wired in
 * and enabled. When mounted, it should sit behind an internal/admin-scoped guard
 * (the design calls for admin scope); left open here would be wrong, so wiring
 * it in is a deliberate, reviewed step, not a default.
 */
@Controller('metrics')
export class NotificationMetricsController {
  constructor(private readonly metrics: NotificationMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
