/**
 * Wave 1A R7 — kill-switch module. Exports RuntimeFlagService so any future
 * activated domain (HTTP guard or job processor) gates on the same registry.
 * The probe controller is the mechanism's only surface today; every real
 * domain flag defaults dark (missing row == disabled).
 */

import { Module } from '@nestjs/common';
import { RuntimeFlagService } from './runtime-flag.service';
import { DomainAllowlistService } from './domain-allowlist.service';
import { GateProbeController } from './gate-probe.controller';

@Module({
  providers: [RuntimeFlagService, DomainAllowlistService],
  controllers: [GateProbeController],
  exports: [RuntimeFlagService, DomainAllowlistService],
})
export class FlagsModule {}
