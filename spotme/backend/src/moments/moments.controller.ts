/**
 * Nearby Moments HTTP surface (Phase 5C) — DARK, and deliberately THIN (M1):
 * no timeline logic here, only parameter mapping onto the service/ports. Bound
 * only inside MomentsModule, which AppModule does not import — none of these
 * routes exists in the running application until an owner-gated activation.
 */

import { Body, Controller, Delete, Get, Param, Post, Query, UnauthorizedException, UseFilters, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DomainGate } from '../flags/domain-gate.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MomentsService } from './moments.service';
import { MomentSerializer, MomentsExceptionFilter } from './moments.http';
import type { MomentFeedMode } from './moments.ports';

/* The principal the app's JWT strategy actually provides ({ id, role, kind } —
 * see jwt.strategies.ts). The dark phase wrote these controllers against a
 * `sub` field that never existed on the request object; every authorId reached
 * Prisma as undefined and every create 500ed the first time real HTTP hit it,
 * while the service-level e2e suite (which passes authorId strings directly)
 * stayed green. The regression test in moments-gate-runtime.spec.ts drives the
 * real strategy so this class of mismatch cannot ship silently again. */
interface Principal { id: string }

/* ACTIVATION (M1): mounted, and DARK until the `moments` flag or a per-account
 * allowlist entry says otherwise — 404 for everyone else, exactly like an
 * unmounted module. `requireAdult` is the second, independent check (D6). */
@UseGuards(JwtAuthGuard, DomainGate('moments', { requireAdult: true }))
@UseFilters(MomentsExceptionFilter)
@Controller('v1/moments')
export class MomentsController {
  constructor(
    private readonly moments: MomentsService,
    private readonly serialize: MomentSerializer,
  ) {}

  /* FAIL CLOSED on an empty principal. The gate guarantees an authenticated
   * adult, but the review flagged that a future caller passing an empty id
   * would turn the two-way block filter OPEN (Prisma binds undefined as NULL,
   * and NOT EXISTS(... = NULL) is always true). One assertion here makes that
   * impossible for every route rather than trusting each query. */
  private uid(u: Principal): string {
    if (!u?.id) throw new UnauthorizedException();
    return u.id;
  }

  @Post()
  async create(@CurrentUser() u: Principal, @Body() body: Record<string, unknown>) {
    const uid = this.uid(u);
    const row = await this.moments.createMoment(uid, body);
    return this.serialize.single(uid, row);
  }

  @Delete(':id')
  async remove(@CurrentUser() u: Principal, @Param('id') id: string, @Query('version') version: string) {
    await this.moments.deleteMoment(this.uid(u), id, Number(version));
    return { deleted: true };
  }

  @Get('feed')
  async feed(
    @CurrentUser() u: Principal,
    @Query('mode') mode: MomentFeedMode = 'friends',
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
    @Query('cursor') cursor?: string,
    @Query('order') order?: 'chronological' | 'ranked',
  ) {
    const uid = this.uid(u);
    const origin = lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : null;
    const page = await this.moments.feed(uid, mode, { origin, cursor: cursor ?? null, order });
    return { results: await this.serialize.feed(uid, page.results), cursor: page.cursor, state: page.state };
  }

  @Post(':id/comments')
  comment(@CurrentUser() u: Principal, @Param('id') id: string, @Body() body: { text?: string; parentId?: string }) {
    return this.moments.addComment(this.uid(u), id, body.text, body.parentId ?? null);
  }

  @Get(':id/comments')
  async comments(@CurrentUser() u: Principal, @Param('id') id: string) {
    const rows = await this.moments.comments(this.uid(u), id);
    return this.serialize.comments(rows, await this.serialize.commentNames(rows));
  }

  @Post(':id/reactions')
  react(@CurrentUser() u: Principal, @Param('id') id: string, @Body() body: { reaction: string }) {
    return this.moments.react(this.uid(u), id, body.reaction);
  }

  @Delete(':id/reactions')
  unreact(@CurrentUser() u: Principal, @Param('id') id: string) {
    return this.moments.unreact(this.uid(u), id);
  }

  @Post('follow/:targetId')
  follow(@CurrentUser() u: Principal, @Param('targetId') t: string) {
    return this.moments.follow(this.uid(u), t);
  }

  @Post('block/:blockedId')
  block(@CurrentUser() u: Principal, @Param('blockedId') b: string) {
    return this.moments.block(this.uid(u), b);
  }

  @Post('stories')
  story(@CurrentUser() u: Principal, @Body() body: { mediaId: string; visibility: 'friends' | 'nearby' | 'public' }) {
    return this.moments.createStory(this.uid(u), body.mediaId, body.visibility);
  }

  @Get('stories/rail')
  async rail(@CurrentUser() u: Principal) {
    return this.serialize.rail(await this.moments.storyRail(this.uid(u)));
  }

  @Post('reports')
  report(@CurrentUser() u: Principal, @Body() body: { targetKind: 'moment' | 'comment' | 'story'; targetId: string; reason: string; note?: string }) {
    return this.moments.report(this.uid(u), body);
  }
}
