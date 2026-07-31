import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { IngestController } from './ingest.controller';
import { AuditModule } from '../audit/audit.module';
// Imported so the admin delete reuses the SAME soft delete as the self-service
// route rather than defining "deleted" a second time.
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AuditModule, UsersModule],
  controllers: [AdminController, IngestController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
