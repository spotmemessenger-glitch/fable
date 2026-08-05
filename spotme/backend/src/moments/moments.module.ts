/**
 * The Moments module (Phase 5C), PREPARED BUT NOT WIRED.
 *
 * NOT imported by AppModule — importing it is the single line that would give
 * the running application a /v1/moments route, and that line is an owner-gated
 * activation change. Everything sits behind the M1 ports; realtime is the
 * DISABLED adapter (no Centrifugo wiring); search is the UNCONFIGURED adapter;
 * queue names are reserved contracts only (M8, via 5B). The 5E dark fence
 * asserts all of this.
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MomentsController } from './moments.controller';
import { MomentSerializer } from './moments.http';
import { MomentsService } from './moments.service';
import { MOMENT_REPOSITORY_PORT, MOMENT_REALTIME_PORT, DisabledMomentRealtime } from './moments.ports';
import { PrismaMomentsRepository } from './moments.prisma.repository';
import { MOMENT_SEARCH_PORT, UnconfiguredMomentSearchAdapter } from './moments.search';
import { MediaModule } from '../moment-media/media.module';
import { MomentMediaController } from './moment-media.controller';
import { FlagsModule } from '../flags/flags.module';

@Module({
  imports: [JwtModule.register({}), MediaModule, FlagsModule],
  controllers: [MomentsController, MomentMediaController],
  providers: [
    MomentsService,
    MomentSerializer,
    { provide: MOMENT_REPOSITORY_PORT, useClass: PrismaMomentsRepository },
    { provide: MOMENT_REALTIME_PORT, useClass: DisabledMomentRealtime },
    { provide: MOMENT_SEARCH_PORT, useClass: UnconfiguredMomentSearchAdapter },
  ],
  exports: [MomentsService],
})
export class MomentsModule {}
