import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { SigningKeysService } from './signing-keys.service';

/**
 * The published SIGNING-key lifecycle (ADR-008 Phase 2B): publish, supersede,
 * withdraw, fetch. Everything that writes is keyed off the JWT principal and
 * nothing else — accepting a userId in a body would let any signed-in user
 * retire somebody else's trust anchor, which is strictly worse than the
 * agreement-key version of the same bug (`keys.controller.ts` documents it).
 *
 * The server stores and serves; it does not decide trust. Its one
 * cryptographic act — verifying a supersession statement before accepting it
 * into the chain — is a coherence check so the ledger cannot be fed garbage,
 * not a claim peers are meant to rely on. Clients verify chains themselves
 * when they consume them (X3DH phase).
 */
@UseGuards(JwtAuthGuard)
@Controller('v2/auth/signing-key')
export class SigningKeysController {
  constructor(private signingKeys: SigningKeysService) {}

  /** Publish MY signing key. Idempotent for the same key; a DIFFERENT key
   *  while one is active is refused — replacement only exists as supersession. */
  @Put()
  publish(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: { publicKeyB64?: string; algo?: string },
  ) {
    return this.signingKeys.publish(principal.id, body);
  }

  /** Replace MY signing key, carrying the old key's signature over the
   *  supersession transcript. Verified before the chain is touched. */
  @Post('supersede')
  supersede(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: { publicKeyB64?: string; algo?: string; supersessionSigB64?: string },
  ) {
    return this.signingKeys.supersede(principal.id, body);
  }

  /** Withdraw MY signing key — the executable rollback of ADR-008 §12. The
   *  row becomes a served tombstone; peers drop the anchor and return to the
   *  pre-A7 posture. */
  @Delete()
  withdraw(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.signingKeys.withdraw(principal.id);
  }

  /** A peer's signing-key state: `none`, or the current record plus its
   *  bounded supersession chain. Tombstones are served, never hidden. */
  @Get(':userId')
  fetch(@Param('userId') userId: string) {
    return this.signingKeys.fetch(userId);
  }
}
