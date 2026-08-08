import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ChatModule } from './chat/chat.module';
import { ChatRequestsModule } from './chat-requests/chat-requests.module';
import { ModerationModule } from './moderation/moderation.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { GroupsModule } from './groups/groups.module';
import { StoriesModule } from './stories/stories.module';
import { RoomsModule } from './rooms/rooms.module';
import { RealtimeModule } from './realtime/realtime.module';
import { CallsModule } from './calls/calls.module';
import { StorageModule } from './storage/storage.module';
import { ScheduleModule } from '@nestjs/schedule';
import { PushModule } from './push/push.module';
import { HealthModule } from './health/health.module';
import { FlagsModule } from './flags/flags.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { MomentsModule } from './moments/moments.module';
import { ExchangeModule } from './exchange/exchange.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Without forRoot() the @Cron in StorageCleanupService is decoration: it
    // registers nothing and never fires, silently.
    ScheduleModule.forRoot(),
    PrismaModule,
    // @Global — StorageModule must be initialised before RoomsModule and
    // GroupsModule, both of which inject STORAGE_ADAPTER to purge media.
    StorageModule,
    AuditModule,
    AuthModule,
    UsersModule,
    ChatModule,
    ChatRequestsModule,
    ModerationModule,
    AdminModule,
    GroupsModule,
    StoriesModule,
    PushModule,
    RoomsModule,
    RealtimeModule,
    // Call MEDIA only (ADR-003). Additive: with LIVEKIT_* unset it mounts
    // routes that answer "not configured here" and nothing else changes.
    CallsModule,
    HealthModule,
    // Wave 1A R7: the activation kill-switch registry + its internal probe.
    // Every real domain flag defaults dark (missing row == disabled).
    FlagsModule,
    // Wave 1C, C3: Discovery is MOUNTED but DARK. Its controller sits behind
    // DomainGate('discovery', { requireAdult: true }); with zero RuntimeFlag
    // rows in production every /api/v2/discovery route answers 404 — identical
    // to being unmounted — until the Stage-A allowlist (C7) turns it on for the
    // owner account only. Mounting-behind-the-gate is exactly what lets an
    // activation be one auditable change away from fully dark.
    DiscoveryModule,
    /* Wave 1D (M1): Moments is MOUNTED but DARK — every route sits behind
     * DomainGate('moments'), which 404s while the RuntimeFlag row is absent
     * and no allowlist entry names the caller. Production keeps zero rows. */
    MomentsModule,
    /* Exchange activation (2026-08-08): MOUNTED behind DomainGate('exchange') —
     * 404 while the RuntimeFlag row is absent. No requireAdult: open to every
     * authenticated account; JwtAuthGuard alone establishes authorship. */
    ExchangeModule,

  ],
})
export class AppModule {}
