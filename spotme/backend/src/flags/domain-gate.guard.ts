/**
 * Wave 1A R7 — the HTTP face of the kill-switch.
 *
 * `DomainGate('discovery')` in a controller's `@UseGuards` makes every route in
 * it answer **404** unless the domain's RuntimeFlag row affirmatively says
 * enabled. 404 — not 403 — deliberately: a gated-off domain must be
 * indistinguishable from one that was never mounted, which is exactly what the
 * dark fences assert today. Flipping the row off returns the domain to that
 * state within one flag-cache window, with no restart.
 *
 * Wave 1C's activation contract: a dark domain's controllers mount BEHIND this
 * gate, so "activated" is always one row-flip away from "fully dark" — the
 * rollback the Activation Programme requires before any module goes live.
 */

import { CanActivate, Injectable, mixin, NotFoundException, Type } from '@nestjs/common';
import { RuntimeFlagService } from './runtime-flag.service';

/** Build a guard class gating on one flag key. Usage: `@UseGuards(DomainGate('discovery'))`. */
export function DomainGate(key: string): Type<CanActivate> {
  @Injectable()
  class DomainGateGuard implements CanActivate {
    constructor(readonly flags: RuntimeFlagService) {}

    async canActivate(): Promise<boolean> {
      if (await this.flags.isEnabled(key)) return true;
      // The same terminal state an unmounted module produces.
      throw new NotFoundException();
    }
  }
  return mixin(DomainGateGuard);
}
