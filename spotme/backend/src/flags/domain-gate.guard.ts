/**
 * Wave 1A R7 — the HTTP face of the kill-switch.
 * Wave 1B B3 — and the 18+ policy check at the same door.
 *
 * `DomainGate('discovery', { requireAdult: true })` in a controller's
 * `@UseGuards` makes every route in it:
 *
 *  1. answer **404** unless the domain's RuntimeFlag row affirmatively says
 *     enabled — 404, not 403, so a gated-off domain is indistinguishable from
 *     one that was never mounted (what the dark fences assert); and then
 *  2. answer **403 `age_requirement`** unless the AUTHENTICATED account's
 *     `ageVerified` is affirmatively true (owner decision D6: 18+ at launch).
 *
 * The ORDER is deliberate: the existence of the surface is revealed only after
 * the flag check, and the age check runs INSIDE the gate — so even a future
 * activation mistake (flag flipped with an ungated cohort still present)
 * cannot expose an unverified account to Discovery. Fail dark, then fail
 * closed: missing user, missing row, or a DB error all refuse.
 *
 * Wave 1C's activation contract: a dark domain's controllers mount BEHIND this
 * gate; Discovery specifically mounts with `requireAdult: true`.
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, mixin, NotFoundException, Type } from '@nestjs/common';
import { RuntimeFlagService } from './runtime-flag.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_ACTIVE, AGE_REFUSAL_MESSAGE } from '../policy/age';

export interface DomainGateOptions {
  /** Require the authenticated account's ageVerified=true (D6). Discovery: always true. */
  requireAdult?: boolean;
}

/** Build a guard class gating on one flag key. Usage: `@UseGuards(DomainGate('discovery', { requireAdult: true }))`. */
export function DomainGate(key: string, opts: DomainGateOptions = {}): Type<CanActivate> {
  @Injectable()
  class DomainGateGuard implements CanActivate {
    constructor(
      readonly flags: RuntimeFlagService,
      readonly prisma: PrismaService,
    ) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      if (!(await this.flags.isEnabled(key))) {
        // The same terminal state an unmounted module produces.
        throw new NotFoundException();
      }
      if (opts.requireAdult) {
        // The auth guard (running before this one) put the principal on the
        // request; anything else — anonymous, malformed, deleted mid-flight —
        // fails closed. Read the CURRENT row: a token minted before the gate
        // proves nothing about the account's age state (B4 replay case).
        const req = ctx.switchToHttp().getRequest<{ user?: { id?: string } }>();
        const userId = req.user?.id;
        const row = userId
          ? await this.prisma.user
              .findUnique({ where: { id: userId }, select: { ageVerified: true, accountStatus: true } })
              .catch(() => null)
          : null;
        // Wave 1C (D6 addendum): the frozen check is EXPLICIT — a frozen
        // account is refused even if ageVerified were somehow true, so the
        // freeze is a status, never a side-effect of the age fields.
        if (row?.ageVerified !== true || row.accountStatus !== ACCOUNT_ACTIVE) {
          throw new ForbiddenException({ error: 'age_requirement', message: AGE_REFUSAL_MESSAGE });
        }
      }
      return true;
    }
  }
  return mixin(DomainGateGuard);
}
