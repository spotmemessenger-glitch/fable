import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Liveness/readiness. PrismaService is @Global (PrismaModule), so it needs no
 * explicit import here; the Redis check builds its own bounded connection.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
