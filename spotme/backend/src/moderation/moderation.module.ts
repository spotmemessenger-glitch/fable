import { Module } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { NcmecService } from './ncmec.service';
import { ModerationController, AdminReportsController } from './moderation.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [ModerationController, AdminReportsController],
  providers: [ModerationService, NcmecService],
  exports: [ModerationService],
})
export class ModerationModule {}
