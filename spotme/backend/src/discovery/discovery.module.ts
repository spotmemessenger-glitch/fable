/**
 * The Discovery module, PREPARED BUT NOT WIRED (checkpoint 2).
 *
 * NOT imported by AppModule — importing it is the single line that would give
 * the running application a /v2/discovery route, and that line is an
 * owner-gated activation change (P8). Until then no route exists, no
 * repository binds, nothing here runs. The C12 dark fence asserts this.
 *
 * Repository tokens (DISCOVERY_PEOPLE_REPOSITORY / DISCOVERY_VISIBILITY_
 * REPOSITORY) are bound by the Prisma/PostGIS implementations in checkpoint 5;
 * until then the module exposes the service class for direct construction in
 * tests with in-memory fakes against the same tokens.
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { FlagsModule } from '../flags/flags.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';
import {
  DISCOVERY_PEOPLE_REPOSITORY,
  DISCOVERY_VISIBILITY_REPOSITORY,
} from './discovery.repository';
import {
  PrismaDiscoveryPeopleRepository,
  PrismaDiscoveryVisibilityRepository,
} from './discovery.prisma.repository';
import { SEARCH_PORT } from './search/search.port';
import { TypesenseSearchAdapter } from './search/typesense-search.adapter';

@Module({
  // FlagsModule provides RuntimeFlagService for the DomainGate; PrismaModule is
  // @Global. The DiscoveryController now mounts behind DomainGate (C3).
  imports: [JwtModule.register({}), FlagsModule],
  controllers: [DiscoveryController],
  providers: [
    DiscoveryService,
    { provide: DISCOVERY_PEOPLE_REPOSITORY, useClass: PrismaDiscoveryPeopleRepository },
    { provide: DISCOVERY_VISIBILITY_REPOSITORY, useClass: PrismaDiscoveryVisibilityRepository },
    // SearchPort: Typesense behind the port (P9). useFactory (not useClass) so
    // the adapter self-constructs with its own defaults — its constructor args
    // are optional config, not Nest-injectable providers. Unconfigured without
    // TYPESENSE_URL/KEY (the module is dark regardless).
    { provide: SEARCH_PORT, useFactory: () => new TypesenseSearchAdapter() },
  ],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
