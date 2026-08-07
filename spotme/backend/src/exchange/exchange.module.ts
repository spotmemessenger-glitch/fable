/**
 * The Exchange module (Phase 3B), MOUNTED AND DARK as of E1.
 *
 * AppModule now imports this, so `/v1/exchange` routes exist in the graph —
 * but every one of them sits behind `DomainGate('exchange', { requireAdult:
 * true })`, which answers 404 while the RuntimeFlag row is absent and no
 * allowlist entry names the caller. Production keeps zero rows, so mounting
 * changed nothing an unallowlisted caller can observe. That claim is proven at
 * runtime, not by inspection, in test/exchange-gate-runtime.spec.ts.
 *
 * FlagsModule is imported for exactly that gate: it exports RuntimeFlagService
 * and DomainAllowlistService, which the guard injects.
 *
 * Business participation remains a dark seam (D4): no business flow is
 * reachable; the v1 posture is individuals-only.
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { FlagsModule } from '../flags/flags.module';
import { ExchangeController } from './exchange.controller';
import { ExchangeService } from './exchange.service';
import { EXCHANGE_INTENT_REPOSITORY } from './exchange.repository';
import { PrismaExchangeIntentRepository } from './exchange.prisma.repository';
import { EXCHANGE_SEARCH_PORT, UnconfiguredExchangeSearchAdapter } from './exchange.search';

@Module({
  imports: [JwtModule.register({}), FlagsModule],
  controllers: [ExchangeController],
  providers: [
    ExchangeService,
    { provide: EXCHANGE_INTENT_REPOSITORY, useClass: PrismaExchangeIntentRepository },
    // Search behind the port (P9). UNCONFIGURED by default — no Typesense
    // contact, typed unavailability; the whole module is dark regardless.
    { provide: EXCHANGE_SEARCH_PORT, useClass: UnconfiguredExchangeSearchAdapter },
  ],
  exports: [ExchangeService],
})
export class ExchangeModule {}
