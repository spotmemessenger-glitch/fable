import { Module, Logger, type OnModuleInit } from '@nestjs/common';
import { initObservability } from './observability';

/**
 * Observability subsystem, PREPARED BUT NOT WIRED.
 *
 * Not imported by `AppModule` yet — importing it is the single, owner-gated line
 * that runs `initObservability()` on boot. Even when imported, every leg stays
 * off until its env var is set, so it changes nothing without configuration.
 */
@Module({})
export class ObservabilityModule implements OnModuleInit {
  private readonly log = new Logger(ObservabilityModule.name);

  async onModuleInit(): Promise<void> {
    const state = await initObservability();
    // Names only — never the DSN/endpoint values.
    this.log.log(
      `observability: logging=${state.logger.enabled ? 'json' : 'default'} ` +
        `sentry=${state.sentry} otel=${state.otel} metrics=${state.metrics}`,
    );
  }
}
