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
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
