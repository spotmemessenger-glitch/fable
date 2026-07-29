import { Module } from '@nestjs/common';
import { ChatRequestsService } from './chat-requests.service';
import { ChatRequestsController } from './chat-requests.controller';

@Module({
  controllers: [ChatRequestsController],
  providers: [ChatRequestsService],
  exports: [ChatRequestsService],
})
export class ChatRequestsModule {}
