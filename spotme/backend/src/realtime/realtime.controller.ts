import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  NotImplementedException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Centrifugo connection tokens and the server-side publish proxy. ADR-002 §3-4.
 *
 * Centrifugo authenticates a connection with a JWT that WE sign, using a secret
 * only this server and the broker share. That is the whole point of minting it
 * here rather than letting the client present its own credential: the broker
 * never has to know what a Spot Me account is.
 */

/** Short by design — the client SDK re-fetches on expiry without reconnecting. */
const TOKEN_TTL_SECONDS = 10 * 60;

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

@UseGuards(JwtAuthGuard)
@Controller('v2/realtime')
export class RealtimeController {
  constructor(private prisma: PrismaService) {}

  /**
   * A Centrifugo connection token for the CALLING user.
   *
   * `sub` comes from the verified JWT principal, never from the body — taking
   * it from the body would let any signed-in user mint a token impersonating
   * anyone, which is the same class of mistake the key-upload endpoint avoids
   * by keying off the principal.
   */
  @Post('token')
  @HttpCode(200)
  async token(@CurrentUser() principal: AuthenticatedPrincipal) {
    const secret = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
    if (!secret) {
      // Absent config is "this transport is not available here", not a 500.
      // The client falls back to Socket.IO and says why.
      throw new ServiceUnavailableException('centrifugo is not configured on this deployment');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: principal.id, iat: now, exp: now + TOKEN_TTL_SECONDS }));
    const signature = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());

    return { token: `${header}.${payload}.${signature}`, expiresIn: TOKEN_TTL_SECONDS };
  }

  /**
   * Server-side publish proxy — DELIBERATELY NOT IMPLEMENTED YET.
   *
   * WHY THIS RETURNS 501 RATHER THAN WORKING. Every publication must pass the
   * same two gates the Socket.IO gateway applies on `action`:
   *
   *   1. group policy — `policy()` -> `refuse()` (role, mute, ban)
   *   2. persistence  — durable types append to RoomEvent, which is what makes
   *      offline replay work at all
   *
   * Both live as PRIVATE methods on RoomsGateway (`rooms.gateway.ts:110` and
   * `:333`), not on RoomsService. Reimplementing them here would create a
   * SECOND authorisation path that starts identical and drifts — and the
   * 2026-07-31 audit already found that "the rooms gateway previously
   * authorised NOTHING", where knowing a roomId was the entire access model.
   * Shipping a publish endpoint with weaker checks than the gateway would
   * recreate that hole through a new door, which is exactly what ADR-002 §3
   * exists to prevent.
   *
   * The prerequisite is a refactor, not more code here: lift `policy` and
   * `refuse` out of the gateway into RoomsService so both callers share one
   * implementation. Until that lands this endpoint refuses, loudly, and the
   * membership check below is kept only so an unauthorised caller is told that
   * first rather than learning the internals.
   */
  @Post('centrifugo/publish')
  @HttpCode(501)
  async publish(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: { roomId?: string },
  ) {
    const roomId = String(body?.roomId ?? '');
    if (!roomId) throw new ForbiddenException('roomId required');

    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: principal.id } },
    });
    if (!member) throw new ForbiddenException('not a member of this room');

    throw new NotImplementedException(
      'centrifugo publish is not enabled: group policy still lives in RoomsGateway. ' +
        'Extract policy()/refuse() into RoomsService first — a second authorisation ' +
        'path would drift from the first (ADR-002 §3).',
    );
  }
}
