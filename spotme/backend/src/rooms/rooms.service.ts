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
    const lastEventId = Math.max(
      since,
      events.length ? events[events.length - 1].id : 0,
      attachments.length ? attachments[attachments.length - 1].id : 0,
    );
    return { events, envelopes: [...envelopes.values()], lastEventId };
  }

  /** One attachment slice by (room, attachment, seq) — the lazy-fetch path. */
  async fetchSlice(roomId: string, attachId: string, seq: number) {
    const slices = await this.prisma.roomEvent.findMany({
      where: { roomId, attachId, type: 'bin' },
      orderBy: { id: 'asc' },
      select: { id: true, payload: true, meta: true },
    });
    const slice = slices.find((s) => (s.meta as { seq?: number } | null)?.seq === seq);
    return slice ? { payload: slice.payload, meta: slice.meta, total: slices.length } : null;
  }
}
