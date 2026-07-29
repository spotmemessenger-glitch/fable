import { Body, Controller, Post } from '@nestjs/common';
import { AdminService } from './admin.service';
import { CrashReportDto, InstallEventDto } from './dto/admin.dto';

/**
 * Unauthenticated-by-design: a crash can happen before login, and an uninstall
 * ping fires as the app is torn down — neither can carry a fresh JWT. Rate
 * limiting belongs at the edge (Railway/Cloudflare), not in this controller.
 */
@Controller('ingest')
export class IngestController {
  constructor(private admin: AdminService) {}

  @Post('crash')
  crash(@Body() dto: CrashReportDto) {
    return this.admin.recordCrash(dto.platform, dto.message, dto.signature, dto.appVersion, dto.stackTrace);
  }

  @Post('install-event')
  installEvent(@Body() dto: InstallEventDto) {
    return this.admin.recordInstallEvent(undefined, dto.kind, dto.platform, dto.city);
  }
}
