/**
 * The Exchange module (Phase 3B), MOUNTED BEHIND THE DOMAIN GATE.
 *
 * Imported by AppModule (owner-authorized activation, 2026-08-08). Every route
 * answers 404 until the `exchange` RuntimeFlag row affirmatively enables the
 * domain — mounted-but-dark, the same activation contract Discovery and
 * Moments use. Business participation is a dark seam (D4): no business flow is
 * reachable; v1 posture is individuals-only.
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
