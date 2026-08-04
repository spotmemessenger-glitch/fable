/**
 * The Events module (Phase 4B), PREPARED BUT NOT WIRED.
 *
 * NOT imported by AppModule — importing it is the single line that would give
 * the running application a /v1/events route, and that line is an owner-gated
 * activation change. Until then no route exists, no repository binds, nothing
 * runs. The 4D dark fence asserts this.
 *
 * The provider fleet is EMPTY by default (DEFAULT_EVENT_PROVIDERS) — no
 * production provider, no credential. With no provider configured the service
 * answers `unavailable`, never invents events. The search adapter is
 * UNCONFIGURED. Wiring a real feed is a separate owner-authorized activation.
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EVENTS_REPOSITORY } from './events.repository';
import { PrismaEventsRepository } from './events.prisma.repository';
import { EVENT_PROVIDERS, DEFAULT_EVENT_PROVIDERS } from './events.provider';
import { EVENT_SEARCH_PORT, UnconfiguredEventSearchAdapter } from './events.search';

@Module({
  imports: [JwtModule.register({})],
  controllers: [EventsController],
  providers: [
    EventsService,
    { provide: EVENTS_REPOSITORY, useClass: PrismaEventsRepository },
    // No production provider ships — the fleet is empty; the service is dark and
    // answers `unavailable` until a feed is provisioned at activation.
    { provide: EVENT_PROVIDERS, useValue: [...DEFAULT_EVENT_PROVIDERS] },
    // Search behind the port — UNCONFIGURED by default (no network).
    { provide: EVENT_SEARCH_PORT, useClass: UnconfiguredEventSearchAdapter },
  ],
  exports: [EventsService],
})
export class EventsModule {}
