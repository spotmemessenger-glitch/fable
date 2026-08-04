/**
 * Live Nearby Events HTTP surface (Phase 4B) — DARK. Bound only inside
 * EventsModule, which AppModule does not import, so NONE of these routes exists
 * in the running application until an owner-gated activation.
 *
 * The controller maps a stored EventRow to the public projection: coarse venue,
 * banded distance, sourced popularity or null, and full source attribution.
 * There is no user-origin field on the response; the origin arrives in the query
 * only to bound the search and is never echoed.
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EventsService } from './events.service';
import type { EventRow } from './events.types';

/** The public event shape returned by the API. No origin, no raw payload. */
function toPublic(row: EventRow) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    description: row.description,
    time: {
      startUTC: row.startUTC,
      endUTC: row.endUTC,
      timezone: row.timezone,
      allDay: row.allDay,
      ...(row.occurrenceId ? { occurrenceId: row.occurrenceId } : {}),
    },
    state: row.state,
    venue: { lat: row.coarseLat, lon: row.coarseLon, cell: row.coarseCell },
    distanceBand: row.distanceBand,
    popularity: row.popularity,
    source: row.source,
    fetchedAtUTC: row.fetchedAtUTC,
  };
}

@UseGuards(JwtAuthGuard)
@Controller('v1/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('nearby')
  async nearby(
    @Query('lat') lat: string,
    @Query('lon') lon: string,
    @Query('radiusKm') radiusKm?: string,
    @Query('category') category?: string,
    @Query('cursor') cursor?: string,
  ) {
    const origin = { lat: Number(lat), lon: Number(lon) };
    const page = await this.events.browse(
      { origin, radiusKm: radiusKm ? Number(radiusKm) : undefined, category, cursor: cursor ?? null },
      Date.now(),
    );
    return { state: page.state, results: page.results.map(toPublic), cursor: page.cursor };
  }

  @Get(':id')
  async byId(@Param('id') id: string) {
    const row = await this.events.getById(id);
    return row ? toPublic(row) : { state: 'not-found' };
  }

  @Post('refresh')
  async refresh(@Body() body: { lat: number; lon: number; radiusKm?: number; category?: string; text?: string }) {
    const summary = await this.events.ingestNearby(
      { origin: { lat: body.lat, lon: body.lon }, radiusKm: body.radiusKm, category: body.category, text: body.text },
      { now: Date.now() },
    );
    return summary;
  }
}
