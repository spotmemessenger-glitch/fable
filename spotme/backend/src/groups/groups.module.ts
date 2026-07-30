import { Module } from '@nestjs/common';
import { GroupsService } from './groups.service';
import { GroupsController } from './groups.controller';

@Module({
  controllers: [GroupsController],
  providers: [GroupsService],
  // The rooms gateway enforces bans/mutes/permissions on the socket path, so
  // it needs policyFor. Without this export a banned member could still send.
  exports: [GroupsService],
})
export class GroupsModule {}
