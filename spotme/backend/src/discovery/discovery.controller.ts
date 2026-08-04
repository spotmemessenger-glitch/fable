/**
 * Discovery controller — thin HTTP edge (checkpoint 2). No business logic:
 * every request is principal-keyed off the JWT and handed to the service.
 *
 * DARK: this controller is registered only by DiscoveryModule, which is NOT
 * imported by AppModule — no route exists in the running application until an
 * owner-authorized activation change wires the module in (fence: C12).
 */

import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { DiscoveryService } from './discovery.service';
import { DiscoveryError } from './discovery.errors';

@UseGuards(JwtAuthGuard)
@Controller('v2/discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  /** Nearby-people query. Origin must be the coarse public contract. */
  @Post('query')
  async query(@CurrentUser() principal: AuthenticatedPrincipal, @Body() body: unknown) {
    try {
      return await this.discovery.queryPeople(principal.id, body);
    } catch (e) {
      if (e instanceof DiscoveryError) return { state: 'failed', error: e.toWire() };
      throw e;
    }
  }

  /** My visibility preference (P3) — principal-keyed, body ids ignored. The
   *  payload is validated and COARSENED server-side (precise-shape refusal,
   *  grid re-quantization, bounded TTL) exactly like the query origin. */
  @Put('visibility')
  setVisibility(@CurrentUser() principal: AuthenticatedPrincipal, @Body() body: unknown) {
    try {
      return this.discovery.setVisibility(principal.id, body);
    } catch (e) {
      if (e instanceof DiscoveryError) return { state: 'failed', error: e.toWire() };
      throw e;
    }
  }

  @Get('visibility')
  getVisibility(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.discovery.getVisibility(principal.id);
  }
}
