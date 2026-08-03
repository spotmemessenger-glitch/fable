import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * The queue subsystem, PREPARED BUT NOT WIRED.
 *
 * This module is intentionally NOT imported by `AppModule` yet — importing it is
 * the single line that turns the queue on, and that is an owner-gated step.
 * Until then nothing constructs a queue, no request path changes, and the code
 * is inert. Even once imported it stays disabled without `REDIS_URL`.
 */
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
