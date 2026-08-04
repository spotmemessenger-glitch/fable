/**
 * The Moments media module (Phase 5B), PREPARED BUT NOT WIRED.
 *
 * NOT imported by AppModule — no route, no binding, nothing runs until an
 * owner-gated activation. Composes the M1 media ports on the EXISTING Phase 1
 * storage seam (`STORAGE_ADAPTER` — optional here, so the module constructs
 * even with no storage env: the upload slot falls back to a fixture URL and no
 * network is touched). Queue names are RESERVED contracts (M8); nothing
 * connects. No production storage credentials exist in this tree.
 */

import { Module } from '@nestjs/common';
import { MomentMediaService } from './media.service';
import { MOMENT_MEDIA_PORT } from './media.ports';

@Module({
  providers: [
    MomentMediaService,
    { provide: MOMENT_MEDIA_PORT, useExisting: MomentMediaService },
  ],
  exports: [MomentMediaService, MOMENT_MEDIA_PORT],
})
export class MediaModule {}
