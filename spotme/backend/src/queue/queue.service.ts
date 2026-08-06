import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { MaintenanceQueue, type EnqueueResult } from './maintenance.queue';
import { isRedisConfigured } from './redis.connection';

/**
 * Nest-facing wrapper around {@link MaintenanceQueue}. Starts the queue on boot
 * only when a Redis-protocol runtime is configured (`REDIS_URL`); otherwise it
 * logs that the queue is disabled and does nothing. Never logs the URL itself.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queue = new MaintenanceQueue();

  onModuleInit(): void {
    if (!isRedisConfigured()) {
      this.logger.log('maintenance queue disabled — no REDIS_URL configured');
      return;
    }
    this.queue.start();
    this.logger.log('maintenance queue started ({maintenance})');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  get enabled(): boolean {
    return this.queue.enabled;
  }

  /**
   * Manually invoked smoke test of the enqueue → process loop. Never scheduled.
   * The discriminated result means a disabled queue is an explicit outcome the
   * caller must handle, never a silent drop.
   */
  enqueueSmoke(jobId?: string): Promise<EnqueueResult> {
    return this.queue.enqueueSmoke(jobId);
  }
}
