import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { GroupsService } from './groups.service';
import { AddGroupMemberDto, CreateGroupDto } from './dto/group.dto';

@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupsController {
  constructor(private groups: GroupsService) {}

  @Post()
  create(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateGroupDto) {
    return this.groups.create(principal.id, dto.name, dto.memberIds);
  }

  @Get()
  listMine(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.listMine(principal.id);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal) {
    return this.groups.getOne(id, principal.id);
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
    return this.groups.removeMember(id, principal.id, principal.id);
  }
}
