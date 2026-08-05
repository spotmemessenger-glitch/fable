/**
 * Nearby Moments HTTP surface (Phase 5C) — DARK, and deliberately THIN (M1):
 * no timeline logic here, only parameter mapping onto the service/ports. Bound
 * only inside MomentsModule, which AppModule does not import — none of these
 * routes exists in the running application until an owner-gated activation.
 */

import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DomainGate } from '../flags/domain-gate.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MomentsService } from './moments.service';
import type { MomentFeedMode } from './moments.ports';

interface Principal { sub: string }

/* ACTIVATION (M1): mounted, and DARK until the `moments` flag or a per-account
 * allowlist entry says otherwise — 404 for everyone else, exactly like an
 * unmounted module. `requireAdult` is the second, independent check (D6). */
@UseGuards(JwtAuthGuard, DomainGate('moments', { requireAdult: true }))
@Controller('v1/moments')
export class MomentsController {
  constructor(private readonly moments: MomentsService) {}

  @Post()
  create(@CurrentUser() u: Principal, @Body() body: Record<string, unknown>) {
    return this.moments.createMoment(u.sub, body);
  }

  @Delete(':id')
  remove(@CurrentUser() u: Principal, @Param('id') id: string, @Query('version') version: string) {
    return this.moments.deleteMoment(u.sub, id, Number(version));
  }

  @Get('feed')
  feed(
    @CurrentUser() u: Principal,
    @Query('mode') mode: MomentFeedMode = 'friends',
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
    @Query('cursor') cursor?: string,
    @Query('order') order?: 'chronological' | 'ranked',
  ) {
    const origin = lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : null;
    return this.moments.feed(u.sub, mode, { origin, cursor: cursor ?? null, order });
  }

  @Post(':id/comments')
  comment(@CurrentUser() u: Principal, @Param('id') id: string, @Body() body: { text?: string; parentId?: string }) {
    return this.moments.addComment(u.sub, id, body.text, body.parentId ?? null);
  }

  @Get(':id/comments')
  comments(@CurrentUser() u: Principal, @Param('id') id: string) {
    return this.moments.comments(u.sub, id);
  }

  @Post(':id/reactions')
  react(@CurrentUser() u: Principal, @Param('id') id: string, @Body() body: { reaction: string }) {
    return this.moments.react(u.sub, id, body.reaction);
  }

  @Delete(':id/reactions')
  unreact(@CurrentUser() u: Principal, @Param('id') id: string) {
    return this.moments.unreact(u.sub, id);
  }

  @Post('follow/:targetId')
  follow(@CurrentUser() u: Principal, @Param('targetId') t: string) {
    return this.moments.follow(u.sub, t);
  }

  @Post('block/:blockedId')
  block(@CurrentUser() u: Principal, @Param('blockedId') b: string) {
    return this.moments.block(u.sub, b);
  }

  @Post('stories')
  story(@CurrentUser() u: Principal, @Body() body: { mediaId: string; visibility: 'friends' | 'nearby' | 'public' }) {
    return this.moments.createStory(u.sub, body.mediaId, body.visibility);
  }

  @Get('stories/rail')
  rail(@CurrentUser() u: Principal) {
    return this.moments.storyRail(u.sub);
  }

  @Post('reports')
  report(@CurrentUser() u: Principal, @Body() body: { targetKind: 'moment' | 'comment' | 'story'; targetId: string; reason: string; note?: string }) {
    return this.moments.report(u.sub, body);
  }
}
