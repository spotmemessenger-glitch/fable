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
import { PushModule } from './push/push.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
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
  ],
})
export class AppModule {}
