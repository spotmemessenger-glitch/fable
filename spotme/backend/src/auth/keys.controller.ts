import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Public-key distribution for e2e_v2 (ADR-001).
 *
 * WHY A DIRECTORY IS SAFE HERE. These are PUBLIC keys — handing one out reveals
 * nothing. What the server must never hold is the private half, and it cannot:
 * the client generates its pair with `extractable: false`, so the secret key is
 * a handle the browser will not serialise even if asked.
 *
 * WHAT THIS ENDPOINT DOES NOT DO, and the copy must not imply. The server is
 * the one handing out these keys, so a malicious or compromised server could
 * serve its OWN public key in place of a peer's and sit in the middle of a NEW
 * conversation. Closing that needs an out-of-band fingerprint the two people
 * compare themselves. That is Phase 2. Until then this raises the cost of
 * passive recomputation from "evaluate a hash" to "run an active MITM", which
 * is a real improvement and not the same thing as being MITM-proof.
 */

/** Base64 with correct padding — rejected early so a bad key never reaches the DB. */
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Raw lengths we accept: X25519 (32) and uncompressed P-256 (65). Anything
 *  else is a client bug or someone probing, and is refused rather than stored. */
const RAW_LENGTHS = new Set([32, 65]);

@UseGuards(JwtAuthGuard)
@Controller('v2/auth/keys')
export class KeysController {
  constructor(private prisma: PrismaService) {}

  /**
   * Publish MY identity public key. Deliberately keyed off the JWT principal
   * rather than a body field — accepting an id in the body would let any signed
   * -in user overwrite somebody else's key and take over their conversations.
   */
  @Post()
  async upload(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: { publicKey?: string; algo?: string },
  ) {
    const publicKey = String(body?.publicKey ?? '').trim();
    if (!publicKey || !B64.test(publicKey)) {
      throw new BadRequestException('publicKey must be base64');
    }

    let rawLength: number;
    try {
      rawLength = Buffer.from(publicKey, 'base64').length;
    } catch {
      throw new BadRequestException('publicKey is not decodable base64');
    }
    if (!RAW_LENGTHS.has(rawLength)) {
      throw new BadRequestException(
        `publicKey must be a raw X25519 (32B) or P-256 (65B) key, got ${rawLength}B`,
      );
    }

    await this.prisma.user.update({
      where: { id: principal.id },
      data: { publicKey },
    });
    return { ok: true, algo: rawLength === 32 ? 'X25519' : 'P-256' };
  }

  /**
   * Fetch a peer's identity public key.
   *
   * A user who has never opened a build that generates one has `publicKey`
   * NULL — which is every account created before this shipped. That is answered
   * as a 404 with an explicit reason so the client can fall back to an e2e_v1
   * room and SAY it did, rather than silently failing to start a chat.
   */
  @Get(':userId')
  async fetch(@Param('userId') userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, publicKey: true },
    });
    if (!user) throw new NotFoundException('no such user');
    if (!user.publicKey) {
      throw new NotFoundException('that user has not published a key yet');
    }
    const rawLength = Buffer.from(user.publicKey, 'base64').length;
    return {
      userId: user.id,
      publicKey: user.publicKey,
      algo: rawLength === 32 ? 'X25519' : 'P-256',
    };
  }
}
