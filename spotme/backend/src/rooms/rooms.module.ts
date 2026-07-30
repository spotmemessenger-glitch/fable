import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GroupsModule } from '../groups/groups.module';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  // GroupsModule supplies the policy the gateway enforces on join/send.
  imports: [JwtModule.register({}), GroupsModule],
  providers: [RoomsGateway, RoomsService],
})
export class RoomsModule {}
