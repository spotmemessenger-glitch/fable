/**
 * Wave 1A R7 — the kill-switch's proof surface. NON-USER-FACING.
 *
 * One internal probe route behind `DomainGate('wave1a-probe')` — a pseudo-domain
 * key no product surface reads. Its whole purpose is to let an operator (and the
 * R7 exercise) measure the switch END TO END on a live deployment without
 * touching any real domain: with no RuntimeFlag row the probe 404s exactly like
 * every dark route; flip the row on and it answers; flip it off and it is 404
 * again within one cache window. Returns a constant — no data, no state, no
 * inputs — so leaving it mounted is posture-neutral (and while its flag row is
 * absent it is indistinguishable from an unmounted path anyway).
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { DomainGate } from './domain-gate.guard';

@Controller('internal/wave1a')
export class GateProbeController {
  @Get('gate-probe')
  @UseGuards(DomainGate('wave1a-probe'))
  probe(): { gate: 'open' } {
    return { gate: 'open' };
  }
}
