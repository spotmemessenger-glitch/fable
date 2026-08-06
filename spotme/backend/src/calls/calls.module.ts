import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { LiveKitService } from './livekit.service';

/**
 * Call media (ADR-003). PrismaService arrives via the @Global PrismaModule, so
 * this module imports nothing.
 *
 * It stands apart from RoomsModule and RealtimeModule ON PURPOSE. Those two own
 * messaging — the socket gateway, the event log, the authorisation service —
 * and another workstream is changing them. Calls need exactly one fact from
 * that world (is this user a member of this room), which is a single Prisma
 * read, so there is no shared provider to fight over and no reason for a change
 * in either module to be able to break a call.
 */
@Module({
  controllers: [CallsController],
  providers: [LiveKitService],
  exports: [LiveKitService],
})
export class CallsModule {}
