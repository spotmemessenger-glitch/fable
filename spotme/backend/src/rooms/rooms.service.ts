import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Persistence for server-backed rooms (the web client's transport).
 *
 * A room here is the client's external roomId — the server never derives or
 * verifies it; knowing the (unguessable, 128-bit-derived) id IS the access
 * model, exactly as it was over Trystero trackers. Payloads arrive as
 * ciphertext the server cannot open (see prisma/schema.prisma RoomEvent).
 */

/** Actions that survive the moment — appended to the log and replayed on join. */
const PERSISTED = new Set([
  'msg', 'react', 'profile', 'del', 'edit', 'read', 'seen',
  'knock', 'knockAck', 'bin', 'binack',
]);

/** Replay never carries attachment bytes — envelopes only, bytes on demand. */
const REPLAY_LIMIT = 5000;

@Injectable()
export class RoomsService {
  constructor(private prisma: PrismaService) {}

  isPersisted(type: string): boolean {
    return PERSISTED.has(type);
  }

  async append(
    roomId: string,
    type: string,
    senderId: string,
    payload: Buffer,
    meta: unknown,
    attachId?: string,
  ) {
    return this.prisma.roomEvent.create({
      data: {
        roomId,
        type,
        senderId,
        payload,
        meta: meta === undefined ? undefined : (meta as object),
        attachId,
      },
      select: { id: true },
    });
  }

  /**
   * Events after the client's cursor, oldest first. Binary slices are
   * excluded — a reconnect must stay light — but each attachment that
   * STARTED after the cursor is represented by its seq-0 envelope so the
   * client can show the message and lazily fetch bytes.
   */
  async replay(roomId: string, since: number) {
    const events = await this.prisma.roomEvent.findMany({
      where: { roomId, id: { gt: since }, type: { not: 'bin' } },
      orderBy: { id: 'asc' },
      take: REPLAY_LIMIT,
    });
    const attachments = await this.prisma.roomEvent.findMany({
      where: { roomId, id: { gt: since }, type: 'bin' },
      orderBy: { id: 'asc' },
      select: { id: true, senderId: true, meta: true, attachId: true },
    });
    // seq-0 carries the full envelope; later slices only routing. One entry
    // per attachment, and the latest event id still advances the cursor.
    const envelopes = new Map<string, (typeof attachments)[number]>();
    for (const slice of attachments) {
      const meta = slice.meta as { seq?: number } | null;
      if (meta?.seq === 0 && slice.attachId && !envelopes.has(slice.attachId)) {
        envelopes.set(slice.attachId, slice);
      }
    }
    /* THE FRONTIER IS WHERE THE CAPPED QUERY STOPPED, NOT THE NEWEST ROW WE SAW.
     *
     * `events` is `take: REPLAY_LIMIT`; `attachments` is not capped at all. So
     * for a client far enough behind, this used to hand back events #1..#5000
     * and a `lastEventId` taken from a bin row created long AFTER #5000. The
     * client advanced its cursor to that id, and every event in between — up to
     * 1200 messages in the case I worked through — was never returned by any
     * future join. Silent, permanent, and with no gap indicator anywhere.
     *
     * The cursor is a promise that everything below it has been delivered, so it
     * may only ever reach as far as this response actually reached. `truncated`
     * lets the client come straight back for the next page instead of waiting
     * for a reconnect that may not come. */
    const truncated = events.length === REPLAY_LIMIT;
    const lastEventId = truncated
      ? events[events.length - 1].id
      : Math.max(
          since,
          events.length ? events[events.length - 1].id : 0,
          attachments.length ? attachments[attachments.length - 1].id : 0,
        );
    // An envelope above the frontier has not been delivered either — sending it
    // now would put a bubble on screen that the cursor cannot account for.
    const inWindow = [...envelopes.values()].filter((e) => e.id <= lastEventId);
    return { events, envelopes: inWindow, lastEventId, truncated };
  }

  /**
   * One attachment slice by (room, attachment, seq) — the lazy-fetch path.
   *
   * `total` is the total the SENDER DECLARED, read back out of the routing meta
   * every slice carries, never the number of rows we happen to hold. Returning
   * the row count was a data-integrity bug: an upload killed at slice 5 of 37
   * answered "total: 5", so the client's own "transfer incomplete" guard could
   * not fire and 13.6% of a voice note was handed over as the whole thing —
   * and played back as a perfectly valid shorter note.
   *
   * `held` is the count of DISTINCT seqs actually stored, so the client can
   * refuse a short tail in one round trip instead of walking to the gap. It
   * counts distinct rather than raw rows because a retried send appends its
   * slices again rather than replacing them.
   *
   * VIEW-ONCE IS ENFORCED HERE, because here is the only place it can be. The
   * client's own "already burned" guard lives in the SENDER's peer-to-peer
   * fetch handler, and the transport asks this server first, unconditionally —
   * so on the durable transport that guard never ran at all. A recipient could
   * re-download a photo the app had already told the sender was gone.
   *
   * `once: true` in the seq-0 slice's cleartext meta marks the attachment. The
   * first non-sender to fetch it claims the single view; anyone else is
   * refused while the bytes still exist, and the bytes stop existing the moment
   * that viewer confirms the open (see burnAttachment).
   */
  async fetchSlice(roomId: string, attachId: string, seq: number, userId: string) {
    const slices = await this.prisma.roomEvent.findMany({
      where: { roomId, attachId, type: 'bin' },
      orderBy: { id: 'asc' },
      select: { id: true, senderId: true, payload: true, meta: true },
    });
    const envelope = slices.find((s) => (s.meta as { seq?: number } | null)?.seq === 0);
    if ((envelope?.meta as { once?: boolean } | null)?.once === true) {
      const viewer = await this.claimView(roomId, attachId, envelope!.senderId, userId);
      if (viewer !== userId) return 'denied' as const;
    }
    const slice = slices.find((s) => (s.meta as { seq?: number } | null)?.seq === seq);
    if (!slice) return null;
    const held = new Set<number>();
    let declared = 0;
    for (const s of slices) {
      const meta = s.meta as { seq?: number; total?: number } | null;
      held.add(Number(meta?.seq) || 0);
      declared = Math.max(declared, Number(meta?.total) || 0);
    }
    return {
      payload: slice.payload,
      meta: slice.meta,
      total: declared || held.size,
      held: held.size,
    };
  }

  /**
   * Who is allowed to see this view-once attachment — the first non-sender to
   * ask, and nobody else. Returns the winning viewer id.
   *
   * The insert IS the lock: attachId is the primary key, so a second claimant
   * racing the first loses on the unique constraint and reads back the winner.
   * The sender is exempt (they authored the bytes and already hold them), which
   * also stops their own re-fetch consuming the recipient's one view.
   */
  private async claimView(
    roomId: string,
    attachId: string,
    senderId: string,
    userId: string,
  ): Promise<string> {
    if (userId === senderId) return userId;
    try {
      const created = await this.prisma.viewOnce.create({
        data: { attachId, roomId, senderId, viewerId: userId },
        select: { viewerId: true },
      });
      return created.viewerId ?? userId;
    } catch {
      const existing = await this.prisma.viewOnce.findUnique({
        where: { attachId },
        select: { viewerId: true },
      });
      return existing?.viewerId ?? userId;
    }
  }

  /**
   * The recipient confirmed the view — destroy the bytes.
   *
   * This is the single highest-value change in the whole feature: until it
   * existed, the burst was an animation over a photo that stayed in Postgres
   * forever. Every slice goes, the seq-0 envelope included, so replay stops
   * advertising the message to devices that never saw it.
   *
   * Guarded on `once: true` so a stray meta.burn cannot delete an ordinary
   * attachment. Anyone in the room may trigger it: whoever holds the roomId can
   * already read the room, and destroying a private photo early is a far
   * smaller harm than keeping it. Returns how many slices were destroyed.
   */
  async burnAttachment(roomId: string, attachId: string, userId: string): Promise<number> {
    const envelope = await this.prisma.roomEvent.findFirst({
      where: { roomId, attachId, type: 'bin' },
      orderBy: { id: 'asc' },
      select: { senderId: true, meta: true },
    });
    if (!envelope || (envelope.meta as { once?: boolean } | null)?.once !== true) return 0;
    const { count } = await this.prisma.roomEvent.deleteMany({
      where: { roomId, attachId, type: 'bin' },
    });
    // Recorded even when no claim row exists — the common case is a recipient
    // who received the bytes live and never had to fetch them at all.
    await this.prisma.viewOnce
      .upsert({
        where: { attachId },
        create: {
          attachId,
          roomId,
          senderId: envelope.senderId,
          viewerId: userId === envelope.senderId ? null : userId,
          burnedAt: new Date(),
        },
        update: { burnedAt: new Date() },
      })
      .catch(() => undefined);
    return count;
  }
}
