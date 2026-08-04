/**
 * Assistant HTTP surface (Phase 6B) — DARK and deliberately THIN: parameter
 * mapping onto AssistantService only. Bound only inside AssistantModule,
 * which AppModule does not import — this route does not exist in the running
 * application until an owner-gated activation. The request body is passed to
 * the service and NEVER logged, echoed, or attached to an error (X9).
 */

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AssistantService } from './assistant.service';
import type { AssistantResponse } from './assistant.service';

@UseGuards(JwtAuthGuard)
@Controller('v1/assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('query')
  @HttpCode(200)
  query(@Body() body: Record<string, unknown>): Promise<AssistantResponse> {
    return this.assistant.answer(body?.text);
  }
}
