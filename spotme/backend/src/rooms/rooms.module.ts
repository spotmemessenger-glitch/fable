import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GroupsModule } from '../groups/groups.module';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';
import { RoomsAuthService } from './rooms-auth.service';

@Module({
  // GroupsModule supplies the policy the gateway enforces on join/send.
  imports: [JwtModule.register({}), GroupsModule],
  providers: [RoomsGateway, RoomsService, RoomsAuthService],
  // Exported for RealtimeModule: the Centrifugo publish proxy must authorise
  // and persist through the SAME code the gateway uses, never a copy of it
  // (ADR-002 §3).
  exports: [RoomsService, RoomsAuthService],
})
export class RoomsModule {}
