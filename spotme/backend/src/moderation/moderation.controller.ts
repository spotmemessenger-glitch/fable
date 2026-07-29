import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmployeeAuthGuard } from '../common/guards/employee-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { ModerationService } from './moderation.service';
import { FileReportDto, ResolveReportDto, BlockDto } from './dto/moderation.dto';

// End-user facing: file a report, block/unblock.
@UseGuards(JwtAuthGuard)
@Controller('moderation')
export class ModerationController {
  constructor(private moderation: ModerationService) {}

  @Post('reports')
  fileReport(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: FileReportDto) {
    return this.moderation.fileReport(principal.id, dto.reportedUserId, dto.reason, dto.reportedContent, dto.contextNote);
  }

  @Post('blocks')
  block(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: BlockDto) {
    return this.moderation.block(principal.id, dto.userId);
  }

  @Post('blocks/:userId/remove')
  unblock(@CurrentUser() principal: AuthenticatedPrincipal, @Param('userId') userId: string) {
    return this.moderation.unblock(principal.id, userId);
  }

  @Get('blocks')
  myBlocks(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.moderation.blockedByUser(principal.id);
  }
}

// Staff facing: the moderation queue. Support sees this list too (metadata),
// but content-bearing actions are Moderator+ only, per the RBAC table in the blueprint.
@UseGuards(EmployeeAuthGuard, RolesGuard)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private moderation: ModerationService) {}

  @Get()
  @Roles(Role.SUPPORT, Role.MODERATOR, Role.ADMIN)
  queue() {
    return this.moderation.queue();
  }

  @Post(':id/resolve')
  @Roles(Role.MODERATOR, Role.ADMIN)
  resolve(
    @Param('id') id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: ResolveReportDto,
  ) {
    return this.moderation.action(id, principal.id, dto.resolution);
  }

  @Post(':id/escalate-csam')
  @Roles(Role.MODERATOR, Role.ADMIN)
  escalate(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.moderation.escalateCsam(id, principal.id);
  }
}
