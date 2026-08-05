/**
 * The Moments media module. ACTIVATED (M1/M3) but still reachable only
 * through MomentsModule, which is itself behind DomainGate('moments').
 *
 * Composes the M1 media ports on the EXISTING Phase 1 storage seam
 * (`STORAGE_ADAPTER` — optional, so the module constructs even with no storage
 * env). M3 adds the real `{moment-media}` transcode worker and the
 * `{moderation}` durable sink; both are INERT without REDIS_URL, exactly like
 * the 1C queue foundation — no env, no connection, and the enqueue reports
 * that it did nothing rather than pretending.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { MomentMediaService } from './media.service';
import { MOMENT_MEDIA_PORT } from './media.ports';
import { TranscodeQueue } from './transcode.worker';
import { ModerationSink } from './moderation.sink';

@Module({
  providers: [
    MomentMediaService,
    TranscodeQueue,
    ModerationSink,
    { provide: MOMENT_MEDIA_PORT, useExisting: MomentMediaService },
  ],
  exports: [MomentMediaService, MOMENT_MEDIA_PORT, TranscodeQueue, ModerationSink],
})
export class MediaModule implements OnModuleInit {
  constructor(
    private readonly media: MomentMediaService,
    private readonly transcode: TranscodeQueue,
  ) {}

  onModuleInit(): void {
    // The worker's IO is the media service — the queue module knows how to
    // schedule, the service knows where bytes live, and neither imports the
    // other's internals.
    this.media.attachTranscodeQueue(this.transcode);
    this.transcode.start(this.media.transcodeIO());
  }
}
