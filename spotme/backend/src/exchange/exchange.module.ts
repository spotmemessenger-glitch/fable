/**
 * The Exchange module (Phase 3B), PREPARED BUT NOT WIRED.
 *
 * NOT imported by AppModule — importing it is the single line that would give
 * the running application a /v1/exchange route, and that line is an owner-gated
 * activation change. Until then no route exists, no repository binds, nothing
 * runs. The 3E dark fence asserts this. Business participation is a dark seam
 * (D4): no business flow is reachable; v1 posture is individuals-only.
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ExchangeController } from './exchange.controller';
import { ExchangeService } from './exchange.service';
import { EXCHANGE_INTENT_REPOSITORY } from './exchange.repository';
import { PrismaExchangeIntentRepository } from './exchange.prisma.repository';
import { EXCHANGE_SEARCH_PORT, UnconfiguredExchangeSearchAdapter } from './exchange.search';

@Module({
  imports: [JwtModule.register({})],
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
