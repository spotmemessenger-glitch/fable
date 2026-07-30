import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { GroupsService } from './groups.service';
import {
  AddGroupMemberDto,
  CreateGroupDto,
  SetBanDto,
  SetGrantsDto,
  SetMuteDto,
  SetRoleDto,
  UpdateGroupDto,
} from './dto/group.dto';

@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupsController {
  constructor(private groups: GroupsService) {}

  @Post()
  create(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateGroupDto) {
    return this.groups.create(principal.id, dto);
  }

  @Get()
  listMine(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.listMine(principal.id);
  }

  /**
   * Availability for the step-2 username field. Checks the SHARED namespace,
   * so a group can never take a name a person already holds.
   * Declared before ':id' or "username" would be read as a group id.
   */
  @Get('username/available')
  async available(@Query('username') username?: string) {
    const name = String(username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(name)) {
      return { available: false, reason: 'username must be 3-16 chars: a-z 0-9 _' };
    }
    return { available: await this.groups.usernameAvailable(name) };
  }

  /** Public directory card — no key, no member list. */
  @Get('by-username/:username')
  findByUsername(@Param('username') username: string) {
    return this.groups.findByUsername(username);
  }

  /** Instant join for a public group; response carries the room key. */
  @Post('by-username/:username/join')
  joinPublic(@Param('username') username: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.joinPublic(username, principal.id);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.getOne(id, principal.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groups.update(id, principal.id, dto);
  }

  /** Soft delete — recoverable for 30 days, then purged by the sweep. */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.softDelete(id, principal.id);
  }

  @Post(':id/members')
  addMember(
    @Param('id') id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: AddGroupMemberDto,
  ) {
    return this.groups.addMember(id, principal.id, dto.userId);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.groups.removeMember(id, principal.id, userId);
  }

  @Post(':id/leave')
  leave(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.leave(id, principal.id);
  }

  @Post(':id/transfer/:userId')
  transfer(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.groups.transferOwnership(id, principal.id, userId);
  }

  @Patch(':id/members/:userId/role')
  setRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: SetRoleDto,
  ) {
    return this.groups.setRole(id, principal.id, userId, dto.role);
  }

  @Patch(':id/members/:userId/grants')
  setGrants(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: SetGrantsDto,
  ) {
    return this.groups.setGrants(id, principal.id, userId, dto);
  }

  @Patch(':id/members/:userId/ban')
  setBan(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: SetBanDto,
  ) {
    return this.groups.setBan(id, principal.id, userId, dto.banned);
  }

  @Patch(':id/members/:userId/mute')
  setMute(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: SetMuteDto,
  ) {
    return this.groups.setMute(id, principal.id, userId, dto.minutes ?? null);
  }
}
