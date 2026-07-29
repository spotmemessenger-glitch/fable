import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { EmployeeAuthGuard } from '../common/guards/employee-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums/role.enum';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { AuditService } from '../audit/audit.service';
import { CreateEmployeeDto } from './dto/admin.dto';

// Every route here requires a staff login (EmployeeAuthGuard). Role scoping
// per route matches the RBAC table: Ops sees health only, Support/Moderator
// see growth + moderation, Admin sees everything plus employee management.
@UseGuards(EmployeeAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private audit: AuditService,
  ) {}

  @Get('growth/installs')
  @Roles(Role.SUPPORT, Role.MODERATOR, Role.ADMIN)
  installs(@Query('days') days?: string) {
    return this.admin.installsOverTime(days ? Number(days) : undefined);
  }

  @Get('growth/active-users')
  @Roles(Role.SUPPORT, Role.MODERATOR, Role.ADMIN)
  active() {
    return this.admin.dauMau();
  }

  @Get('growth/demographics')
  @Roles(Role.SUPPORT, Role.MODERATOR, Role.ADMIN)
  demographics() {
    return this.admin.demographics();
  }

  @Get('health/summary')
  @Roles(Role.OPS, Role.ADMIN)
  health(@Query('days') days?: string) {
    return this.admin.healthSummary(days ? Number(days) : undefined);
  }

  @Get('health/crashes')
  @Roles(Role.OPS, Role.ADMIN)
  crashes() {
    return this.admin.crashesGrouped();
  }

  @Get('audit-log')
  @Roles(Role.ADMIN)
  auditLog() {
    return this.audit.recent();
  }

  @Get('employees')
  @Roles(Role.ADMIN)
  employees() {
    return this.admin.listEmployees();
  }

  @Post('employees')
  @Roles(Role.ADMIN)
  async createEmployee(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateEmployeeDto) {
    const employee = await this.admin.createEmployee(dto.email, dto.name, dto.password, dto.role as Role);
    await this.audit.log(principal.id, 'employee.create', 'Employee', employee.id, { role: dto.role });
    return employee;
  }

  @Patch('employees/:id/deactivate')
  @Roles(Role.ADMIN)
  async deactivate(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    const employee = await this.admin.setEmployeeActive(id, false);
    await this.audit.log(principal.id, 'employee.deactivate', 'Employee', id);
    return employee;
  }
}
