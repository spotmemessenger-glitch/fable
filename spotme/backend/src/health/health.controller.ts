/**
 * Wave 0 — /health and /ready.
 *
 * Registered OUTSIDE the global `api` prefix (see main.ts exclude list) so
 * probes hit stable, conventional paths. `/health` is liveness (always 200 once
 * the process serves); `/ready` returns 503 when a Wave-0 dependency is down so
 * an orchestrator can gate traffic honestly.
 */

import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  liveness(): { status: 'ok' } {
    return this.health.liveness();
  }

  @Get('ready')
  async readiness(@Res() res: Response): Promise<void> {
    const body = await this.health.readiness();
    res.status(body.status === 'ready' ? 200 : 503).json(body);
  }
}
