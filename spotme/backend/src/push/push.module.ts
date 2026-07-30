import { Global, Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushService } from './push.service';

// Global because the rooms gateway needs it too, and threading a provider
// through module imports for one dependency is more ceremony than it is worth.
@Global()
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
