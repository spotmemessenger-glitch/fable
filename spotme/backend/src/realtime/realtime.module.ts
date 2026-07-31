import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';

/**
 * Centrifugo-facing endpoints (ADR-002). PrismaService arrives via the @Global
 * PrismaModule, so nothing needs importing here.
 *
 * Deliberately separate from RoomsModule: the Socket.IO gateway stays the
 * default transport and must keep working untouched while this is opt-in.
 */
@Module({
  controllers: [RealtimeController],
})
export class RealtimeModule {}
