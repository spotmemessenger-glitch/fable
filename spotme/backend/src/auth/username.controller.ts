import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service';

const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const PREFIX_RE = /^[a-z0-9_]{1,16}$/;

const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * Same wire contract as the Vercel Blob registry this replaces
 * (spotme/web/api/username.js) — the web client's onboarding, search and
 * release flows keep working with zero client changes:
 *
 *   GET  /api/username?check=<name>  -> { available: boolean }
 *   GET  /api/username?q=<prefix>    -> { results: [{username,id,name}] }
 *   POST {username,id,name,secret}   -> { ok:true } | 409 { error:'taken' }
 *   POST {op:'release',username,secret} -> { ok:true }
 *
 * The registry is now the User table — a claim IS a guest signup, so the
 * realtime gateway's JWT identity and the username registry can never drift.
 */
@Controller('username')
export class UsernameController {
  constructor(private auth: AuthService) {}

  @Get()
  async lookup(@Query('check') check?: string, @Query('q') q?: string) {
    if (check !== undefined) {
      const name = normalize(check);
      if (!USERNAME_RE.test(name)) throw new BadRequestException('invalid username');
      return this.auth.usernameCheck(name);
    }
    if (q !== undefined) {
      const prefix = normalize(q);
      if (!PREFIX_RE.test(prefix)) throw new BadRequestException('invalid query');
      return this.auth.usernameSearch(prefix);
    }
    throw new BadRequestException('check or q required');
  }

  @Post()
  @HttpCode(200)
  async claimOrRelease(
    @Body()
    body: { op?: string; username?: string; id?: string; name?: string; secret?: string; birthYearMonth?: string },
  ) {
    const username = normalize(body.username);
    if (!USERNAME_RE.test(username)) throw new BadRequestException('invalid username');
    if (!body.secret || typeof body.secret !== 'string') {
      throw new BadRequestException('secret required');
    }
    if (body.op === 'release') {
      return this.auth.usernameRelease(username, body.secret);
    }
    if (!body.id || !/^[a-f0-9]{8,64}$/i.test(body.id)) {
      throw new BadRequestException('invalid id');
    }
    // Wave 1B/1C: a claim IS a guest signup, so the 18+ declaration rides the
    // same call — guestAuth validates it (a new id with no valid adult
    // declaration is refused there; this route adds no second policy).
    await this.auth.guestAuth(
      body.id,
      username,
      body.name,
      body.secret,
      undefined,
      undefined,
      undefined,
      typeof body.birthYearMonth === 'string' ? body.birthYearMonth : undefined,
    );
    return { ok: true };
  }
}
