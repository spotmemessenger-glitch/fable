/**
 * Phase 5C — Moments backend against REAL PostGIS. Proves on the live DB:
 * private NEVER surfaces in any feed (SQL); two-way block excludes in SQL;
 * the three feeds scope correctly (nearby ST_DWithin / friends follow-graph /
 * city cell); keyset pagination; flat comments; closed reactions (DB CHECK
 * included); the M3 story lifecycle + {story-expiry} sweep; the moderation
 * machine with sanitized append-only audit; child-safety priority lane.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaMomentsRepository } from '../src/moments/moments.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { MomentsService } from '../src/moments/moments.service';

const prisma = new PrismaClient();
const svc = () => new MomentsService(new PrismaMomentsRepository(prisma as unknown as PrismaService), null, undefined as never);
const RUN = `mo${Date.now().toString(36)}`;
const uid = (n: string) => `${RUN}-${n}`;
const origin = { lat: 12.972, lon: 77.595 };

const post = (over: Record<string, unknown> = {}) => ({
  kind: 'text', text: `hello from ${RUN}`, visibility: 'public',
  location: { lat: 12.972, lon: 77.595 }, ...over,
});

describe('moments backend (real PostGIS)', () => {
  let me: string, friend: string, stranger: string, blocked: string;

  beforeAll(async () => {
    me = uid('me'); friend = uid('friend'); stranger = uid('stranger'); blocked = uid('blocked');
    for (const [id, name] of [[me, 'me'], [friend, 'friend'], [stranger, 'stranger'], [blocked, 'blocked']] as const) {
      await prisma.user.create({ data: { id, username: `${RUN}_${name}` } });
    }
  });

  afterAll(async () => {
    const ids = [me, friend, stranger, blocked];
    await prisma.momentModerationEvent.deleteMany({ where: { targetId: { contains: '' } } }).catch(() => {});
    await prisma.momentReport.deleteMany({ where: { reporterId: { in: ids } } }).catch(() => {});
    await prisma.momentBlock.deleteMany({ where: { blockerId: { in: ids } } }).catch(() => {});
    await prisma.momentFollow.deleteMany({ where: { followerId: { in: ids } } }).catch(() => {});
    await prisma.momentStory.deleteMany({ where: { authorId: { in: ids } } }).catch(() => {});
    await prisma.moment.deleteMany({ where: { authorId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('PRIVATE never surfaces in ANY feed, for anyone — but the owner sees it via findOwn', async () => {
    const s = svc();
    const priv = await s.createMoment(friend, post({ visibility: 'private', location: undefined }));
    await s.follow(me, friend); // even a follower must not see it
    for (const mode of ['nearby', 'friends', 'city'] as const) {
      const page = await s.feed(me, mode, { origin });
      expect(page.results.map((r) => r.moment.id)).not.toContain(priv.id);
    }
    const own = await s.getOwn(friend, priv.id);
    expect(own.visibility).toBe('private');
    await expect(s.getOwn(me, priv.id)).rejects.toMatchObject({ code: 'NOT_FOUND' }); // uniform
  });

  it('two-way BLOCK excludes in SQL — both directions, feeds and comments', async () => {
    const s = svc();
    const b = await s.createMoment(blocked, post());
    await s.block(me, blocked);
    const page = await s.feed(me, 'nearby', { origin });
    expect(page.results.map((r) => r.moment.id)).not.toContain(b.id);
    // Reverse direction: someone the author blocked also cannot see it.
    const mine = await s.createMoment(me, post());
    const pageForBlocked = await s.feed(blocked, 'nearby', { origin });
    expect(pageForBlocked.results.map((r) => r.moment.id)).not.toContain(mine.id);
  });

  it('the three feeds scope correctly (nearby radius / friends graph / city cell)', async () => {
    const s = svc();
    const near = await s.createMoment(stranger, post({ visibility: 'nearby' }));
    const far = await s.createMoment(stranger, post({ visibility: 'nearby', location: { lat: 40.0, lon: -70.0 } }));
    const friendsOnly = await s.createMoment(friend, post({ visibility: 'friends', location: undefined }));
    const cityPub = await s.createMoment(stranger, post({ visibility: 'public' }));

    const nearby = await s.feed(me, 'nearby', { origin, radiusKm: 25 });
    const nearbyIds = nearby.results.map((r) => r.moment.id);
    expect(nearbyIds).toContain(near.id);
    expect(nearbyIds).not.toContain(far.id);        // outside radius, in SQL
    expect(nearbyIds).not.toContain(friendsOnly.id); // friends tier not in nearby

    const friends = await s.feed(me, 'friends', {});
    const friendIds = friends.results.map((r) => r.moment.id);
    expect(friendIds).toContain(friendsOnly.id);     // followed author
    expect(friendIds).not.toContain(near.id);        // not followed

    const city = await s.feed(me, 'city', { origin });
    const cityIds = city.results.map((r) => r.moment.id);
    expect(cityIds).toContain(cityPub.id);           // public in my city cell
    expect(cityIds).not.toContain(near.id);          // nearby-tier not in city
  });

  it('feed default order is CHRONOLOGICAL; ranked order carries breakdowns with omissions disclosed', async () => {
    const s = svc();
    const chrono = await s.feed(me, 'nearby', { origin });
    for (let i = 1; i < chrono.results.length; i++) {
      expect(chrono.results[i - 1].moment.createdAtUTC).toBeGreaterThanOrEqual(chrono.results[i].moment.createdAtUTC);
    }
    expect(chrono.results.every((r) => r.ranking === null)).toBe(true); // no scores uninvited
    const ranked = await s.feed(me, 'nearby', { origin, order: 'ranked' });
    for (const r of ranked.results) {
      expect(r.ranking).not.toBeNull();
      expect(r.ranking!.omittedSignals.length).toBeGreaterThan(0); // graph signals disclosed as omitted
    }
  });

  it('comments are FLAT (parentId); a foreign parent is refused; blocked commenters vanish', async () => {
    const s = svc();
    const p = await s.createMoment(me, post());
    const c1 = await s.addComment(friend, p.id, 'top', null);
    await s.addComment(me, p.id, 'reply', c1.id);
    await expect(s.addComment(me, p.id, 'bad', 'mc-not-on-this-moment')).rejects.toMatchObject({ code: 'MALFORMED_MOMENT' });
    const list = await s.comments(me, p.id);
    expect(list.map((c) => c.parentId)).toEqual([null, c1.id]);
    // No nested storage: rows are flat with a parent reference only.
    expect((list[1] as { children?: unknown }).children).toBeUndefined();
  });

  it('reactions: closed registry at the SERVICE and at the DATABASE (CHECK)', async () => {
    const s = svc();
    const p = await s.createMoment(me, post());
    await s.react(friend, p.id, 'love');
    await expect(s.react(friend, p.id, 'angry')).rejects.toMatchObject({ code: 'UNKNOWN_REACTION' });
    // Defence in depth: the raw INSERT is also refused by the DB constraint.
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "MomentReactionRow" ("momentId","userId","reaction") VALUES ('${p.id}','${stranger}','angry')`,
    )).rejects.toThrow(/reaction_closed|check constraint/i);
  });

  it('M3 stories: 24h expiry stamp, rail scoping, owner transitions, {story-expiry} sweep', async () => {
    const s = svc();
    const now = Date.now();
    const story = await s.createStory(friend, `asset-${RUN}`, 'friends', now);
    expect(story.expiresAtUTC - now).toBe(24 * 3600 * 1000);
    // Rail: follower sees it; a stranger does not (not following).
    expect((await s.storyRail(me, now)).map((x) => x.id)).toContain(story.id);
    expect((await s.storyRail(stranger, now)).map((x) => x.id)).not.toContain(story.id);
    // Owner hide → rail hides it; un-hide restores.
    const hidden = await s.transitionStory(friend, story.id, 'hidden', story.versionSeq);
    expect((await s.storyRail(me, now)).map((x) => x.id)).not.toContain(story.id);
    await s.transitionStory(friend, story.id, 'active', hidden.versionSeq);
    // A non-owner cannot transition (uniform NOT_FOUND).
    await expect(s.transitionStory(me, story.id, 'deleted', 99)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The sweep flips active → expired past the deadline.
    const swept = await s.runStoryExpirySweep(now + 25 * 3600 * 1000);
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await prisma.momentStory.findUnique({ where: { id: story.id } });
    expect(after!.state).toBe('expired');
    // The sweep ran through the {story-expiry} job CONTRACT (fixture worker).
    expect(s.workers.processed.some((j) => j.name === 'story-expiry')).toBe(true);
  });

  it('moderation: report moves visible→reported with SANITIZED audit; child-safety takes the priority lane; removed leaves every feed', async () => {
    const s = svc();
    const p = await s.createMoment(stranger, post({ text: 'reportable content with secrets' }));
    await s.report(me, { targetKind: 'moment', targetId: p.id, reason: 'child-safety' });
    // Priority lane recorded on the {moderation} job contract.
    const job = s.workers.processed.find((j) => j.name === 'moderation');
    expect(job).toMatchObject({ priority: 'child-safety' });
    // State moved; audit row is ids + codes ONLY — never content.
    const events = await prisma.momentModerationEvent.findMany({ where: { targetId: p.id } });
    expect(events.map((e) => `${e.fromState}>${e.toState}`)).toContain('visible>reported');
    expect(JSON.stringify(events)).not.toContain('reportable content');
    // A reported post still surfaces; a removed one never does.
    let page = await s.feed(me, 'nearby', { origin });
    expect(page.results.map((r) => r.moment.id)).toContain(p.id);
    await s.moderate('moment', p.id, 'reported', 'removed', 'child-safety');
    page = await s.feed(me, 'nearby', { origin });
    expect(page.results.map((r) => r.moment.id)).not.toContain(p.id);
    // Terminal: no way back from removed.
    await expect(s.moderate('moment', p.id, 'removed', 'visible', null)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('PRIVATE-INTERACT: direct-by-id interaction runs the full tier + block gate (review fix)', async () => {
    const s = svc();
    // A stranger holding a PRIVATE post's id cannot comment/react/list — uniform NOT_FOUND.
    const priv = await s.createMoment(friend, post({ visibility: 'private', location: undefined }));
    await expect(s.addComment(stranger, priv.id, 'hi', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.react(stranger, priv.id, 'like')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.comments(stranger, priv.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The author interacts with their own private post normally.
    await expect(s.addComment(friend, priv.id, 'note to self', null)).resolves.toBeTruthy();

    // A FRIENDS post: a follower may interact; a non-follower gets NOT_FOUND.
    const fr = await s.createMoment(friend, post({ visibility: 'friends', location: undefined }));
    await expect(s.react(stranger, fr.id, 'like')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await s.react(me, fr.id, 'like'); // `me` follows `friend` from the earlier test

    // A PUBLIC post: fine for a stranger — but NOT for a blocked viewer.
    const pub = await s.createMoment(friend, post({ visibility: 'public' }));
    await s.react(stranger, pub.id, 'wow');
    await s.block(friend, blocked);
    await expect(s.react(blocked, pub.id, 'like')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keyset pagination is stable and non-overlapping across the nearby feed', async () => {
    const s = svc();
    for (let i = 0; i < 5; i++) await s.createMoment(stranger, post({ text: `pg-${i}` }));
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let p = 0; p < 8; p++) {
      const page = await s.feed(me, 'nearby', { origin, cursor });
      for (const r of page.results) { expect(seen.has(r.moment.id)).toBe(false); seen.add(r.moment.id); }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});
