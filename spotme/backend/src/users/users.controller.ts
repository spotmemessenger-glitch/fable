import { Body, Controller, Delete, Get, NotFoundException, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto, UpdatePresenceDto } from './dto/update-profile.dto';

@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  me(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.users.findById(principal.id);
  }

  @Patch()
  update(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(principal.id, dto);
  }

  @Post('presence')
  presence(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: UpdatePresenceDto) {
    return this.users.updatePresence(principal.id, dto.lat ?? null, dto.lon ?? null, !!dto.ghost);
  }

  @Post('uninstall')
  uninstall(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.users.markUninstalled(principal.id);
  }

  @Delete()
  deleteAccount(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.users.softDeleteAccount(principal.id);
  }
}

// Separate path prefix ('users', not 'users/me') for the public-safe lookup
// used to start a chat by username — matches spotme/web's username-search flow.
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersLookupController {
  constructor(private users: UsersService) {}

  @Get('lookup')
  async lookup(@Query('username') username: string) {
    const user = await this.users.findByUsername(username);
    if (!user) throw new NotFoundException('no user with that username');
    return user;
  }
}
