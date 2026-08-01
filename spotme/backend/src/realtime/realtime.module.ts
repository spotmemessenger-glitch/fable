import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller';
import { RoomsModule } from '../rooms/rooms.module';

/**
 * Centrifugo-facing endpoints (ADR-002). PrismaService arrives via the @Global
 * PrismaModule, so only RoomsModule needs importing here.
 *
 * RoomsModule supplies RoomsAuthService and RoomsService — the SAME providers
 * the Socket.IO gateway injects. That shared instance is the point: the publish
 * proxy authorises and persists through one implementation, so the two
 * transports cannot drift apart on who may send what.
 *
 * The controller stays in its own module rather than moving into RoomsModule:
 * Socket.IO remains the default transport and must keep working untouched
 * while this is opt-in.
 */
@Module({
  imports: [RoomsModule],
  controllers: [RealtimeController],
})
export class RealtimeModule {}
