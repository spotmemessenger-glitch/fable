import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController, UsersLookupController } from './users.controller';

@Module({
  controllers: [UsersController, UsersLookupController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
