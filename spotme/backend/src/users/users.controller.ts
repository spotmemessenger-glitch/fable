import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
  async lookup(@Query('username') username?: string) {
    /* A MISSING PARAMETER MUST NOT BECOME A MISSING FILTER.
     *
     * `@Query` with nothing to bind yields `undefined`, Prisma strips undefined
     * values out of a `where`, and `findFirst` was left with nothing but
     * `deletedAt: null` — so `GET /api/users/lookup`, with no query string at
     * all, returned an arbitrary real account. Verified against the live
     * database, not inferred.
     *
     * This is the general shape worth watching for: any `@Query`/`@Param` that
     * reaches a Prisma filter unvalidated degenerates to "match anything". */
    const name = String(username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(name)) throw new BadRequestException('invalid username');
    const user = await this.users.findByUsername(name);
    if (!user) throw new NotFoundException('no user with that username');
    return user;
  }
}
