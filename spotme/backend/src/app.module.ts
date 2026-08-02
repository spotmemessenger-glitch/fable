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
import { StorageModule } from './storage/storage.module';
import { ScheduleModule } from '@nestjs/schedule';
import { PushModule } from './push/push.module';
import { NotificationsModule } from './notifications/notifications.module';

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
    // Priority-2 push platform. INERT while NOTIFICATIONS_V2_ENABLED is off (the
    // default): register() returns an EMPTY module — no providers, no @Cron, no
    // routes — so this import changes nothing in the running app until the flag
    // is set. See src/notifications/notifications.module.ts.
    NotificationsModule.register(),
  ],
})
export class AppModule {}
