/**
 * Exchange controller — thin HTTP edge (Phase 3B). Every request is
 * principal-keyed off the JWT and handed to the service; no business logic here.
 *
 * DARK: registered only by ExchangeModule, which is NOT imported by AppModule —
 * no /v1/exchange route exists in the running application until an
 * owner-authorized activation change (fence: 3E).
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { ExchangeService } from './exchange.service';
import { ExchangeError } from './exchange.errors';

const toInt = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : d;
};

@UseGuards(JwtAuthGuard)
@Controller('v1/exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  private async guard<T>(fn: () => Promise<T>): Promise<T | { state: 'failed'; error: ReturnType<ExchangeError['toWire']> }> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ExchangeError) return { state: 'failed', error: e.toWire() };
      throw e;
    }
  }

  @Post('intents')
  create(@CurrentUser() p: AuthenticatedPrincipal, @Body() body: unknown) {
    return this.guard(() => this.exchange.createDraft(p.id, body));
  }

  @Get('intents/mine')
  listMine(@CurrentUser() p: AuthenticatedPrincipal, @Query('cursor') cursor?: string) {
    return this.guard(() => this.exchange.listOwn(p.id, cursor ?? null));
  }

  @Get('intents/:id')
  getOne(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.guard(() => this.exchange.getOwn(p.id, id));
  }

  @Post('intents/:id/update')
  update(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string, @Body() body: { version?: unknown; patch?: unknown }) {
    return this.guard(() => this.exchange.updateDraft(p.id, id, toInt(body?.version, -1), body?.patch));
  }

  @Post('intents/:id/activate')
  activate(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string, @Body() body: { version?: unknown }) {
    return this.guard(() => this.exchange.activate(p.id, id, toInt(body?.version, -1)));
  }

  @Post('intents/:id/pause')
  pause(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string, @Body() body: { version?: unknown }) {
    return this.guard(() => this.exchange.pause(p.id, id, toInt(body?.version, -1)));
  }

  @Post('intents/:id/resume')
  resume(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string, @Body() body: { version?: unknown }) {
    return this.guard(() => this.exchange.resume(p.id, id, toInt(body?.version, -1)));
  }

  @Post('intents/:id/withdraw')
  withdraw(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string, @Body() body: { version?: unknown }) {
    return this.guard(() => this.exchange.withdraw(p.id, id, toInt(body?.version, -1)));
  }

  @Post('intents/:id/fulfilled')
  fulfilled(@CurrentUser() p: AuthenticatedPrincipal, @Param('id') id: string, @Body() body: { version?: unknown }) {
    return this.guard(() => this.exchange.markFulfilled(p.id, id, toInt(body?.version, -1)));
  }

  @Get('browse')
  browse(
    @CurrentUser() p: AuthenticatedPrincipal,
    @Query('kind') kind?: 'need' | 'offer' | 'service',
    @Query('category') category?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.guard(() => this.exchange.browse(p.id, { kind, category, cursor: cursor ?? null }));
  }
}
