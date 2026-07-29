import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { IngestController } from './ingest.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [AdminController, IngestController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
