import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IStorageAdapter, STORAGE_ADAPTER, buildObjectKey } from '../storage/storage.interface';

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

/**
 * Relayed but never persisted — no ghost replays.
 *
 * fetchreq/fetchres are the transport's peer-to-peer lazy-fetch fallback.
 * `hello` is the discovery lobby's presence heartbeat: replaying an old
 * "I am nearby" would tell the user something untrue, so it must never reach
 * the log.
 *
 * Lives here rather than in the gateway because the HTTP publish proxy needs
 * the same answer, and two lists of what may cross the wire would drift.
 */
/* `rtc` is deliberately absent. It carried peer-to-peer WebRTC offers, answers
 * and ICE candidates for calls; that path is deleted (ADR-004) and media now
 * goes to the LiveKit SFU. `call` stays — ringing is still a message.
 *
 * Dropping it from this list means the server REFUSES the frame rather than
 * relaying a signalling type nothing speaks any more. An accepted-but-unhandled
 * action is a surface, and an unused surface is still a surface. */
const EPHEMERAL = new Set([
  'typing', 'call', 'locup', 'history', 'fetchreq', 'fetchres', 'hello',
]);

/** Replay never carries attachment bytes — envelopes only, bytes on demand. */
const REPLAY_LIMIT = 5000;

@Injectable()
export class RoomsService {
  private readonly log = new Logger(RoomsService.name);

  constructor(
    private prisma: PrismaService,
    /* @Optional so RoomsService stays constructible in unit tests that care
     * only about replay and truncation and have no storage to give it. In the
     * running app StorageModule is @Global, so this is always present. */
    @Optional() @Inject(STORAGE_ADAPTER) private storage?: IStorageAdapter,
  ) {}

  /**
   * Destroy the stored objects for one attachment.
   *
   * `seqs` is passed in rather than probed for. `deleteObject` is contractually
   * idempotent — deleting what is not there is success — so a "walk upward
   * until one fails" loop never terminates early and would fire thousands of
   * pointless deletes per burn. The seq numbers are already in the rows being
   * removed, so the caller reads them once and hands them over.
   *
   * Failures are logged, never thrown: a burn must not fail because a bucket is
   * briefly unreachable, and the hourly orphan sweep is the backstop for
   * exactly that case.
   */
  private async purgeAttachmentObjects(
    roomId: string,
    attachId: string,
    seqs: number[],
  ): Promise<number> {
    if (!this.storage || !seqs.length) return 0;
    let removed = 0;
    for (const seq of seqs) {
      let key: string;
      try {
        key = buildObjectKey(roomId, attachId, seq);
      } catch {
        continue; // an id that cannot form a key never formed one
      }
      if (await this.storage.deleteObject(key).catch(() => false)) removed++;
    }
    if (removed < seqs.length) {
      this.log.warn(
        `burn ${attachId}: ${removed}/${seqs.length} objects removed — the orphan sweep will retry`,
      );
    }
    return removed;
  }

  isPersisted(type: string): boolean {
    return PERSISTED.has(type);
  }

  /** Relayed live but never logged. */
  isEphemeral(type: string): boolean {
    return EPHEMERAL.has(type);
  }

  /** Whether this action type may cross the wire at all. */
  isKnownType(type: string): boolean {
    return PERSISTED.has(type) || EPHEMERAL.has(type);
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
   * May this user be handed a presigned URL for this attachment's bytes?
   *
   * WHY THIS HAD TO EXIST BEFORE MEDIA COULD MOVE TO OBJECT STORAGE.
   * `fetchSlice` says of itself: "VIEW-ONCE IS ENFORCED HERE, because here is
   * the only place it can be" — the server holds the bytes, so the server is
   * the only party that can refuse them. The presigned download route bypasses
   * `fetchSlice` entirely: it hands out a URL and the bytes come from a bucket.
   * Without this check, migrating media to storage would have silently deleted
   * server-side view-once enforcement, and a recipient could re-download a
   * "burned" private photo forever. Nothing would have failed; the burst
   * animation would still have played.
   *
   * Three answers, and the distinction between the last two matters:
   *   'ok'      — go ahead
   *   'denied'  — someone else claimed this one view (the bytes may still exist)
   *   'gone'    — it was opened and destroyed; the ViewOnce row deliberately
   *               outlives the RoomEvent rows so this stays distinguishable
   *               from "never existed", which a client would retry forever.
   */
  async authorizeAttachmentRead(
    roomId: string,
    attachId: string,
    userId: string,
  ): Promise<'ok' | 'denied' | 'gone'> {
    // Checked FIRST, because a burn deletes the RoomEvent rows: after it there
    // is no envelope left to tell us this was ever view-once.
    const claim = await this.prisma.viewOnce
      .findUnique({ where: { attachId }, select: { viewerId: true, senderId: true, burnedAt: true } })
      .catch(() => null);
    if (claim?.burnedAt) return 'gone';

    const envelope = await this.prisma.roomEvent.findFirst({
      where: { roomId, attachId, type: 'bin' },
      orderBy: { id: 'asc' },
      select: { senderId: true, meta: true },
    });
    // Not view-once (or not ours) — membership, already checked by the caller,
    // is the whole access model for an ordinary attachment.
    if (!envelope) return claim ? 'gone' : 'ok';
    if ((envelope.meta as { once?: boolean } | null)?.once !== true) return 'ok';

    const viewer = await this.claimView(roomId, attachId, envelope.senderId, userId);
    return viewer === userId ? 'ok' : 'denied';
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
    /* Read the slice numbers BEFORE deleting the rows — afterwards there is
     * nothing left to say which objects belonged to this attachment, and the
     * bytes would survive the "burn" with no record pointing at them. */
    const slices = await this.prisma.roomEvent.findMany({
      where: { roomId, attachId, type: 'bin' },
      select: { meta: true },
    });
    const seqs = slices
      .map((s) => Number((s.meta as { seq?: number } | null)?.seq ?? 0))
      .filter((n) => Number.isInteger(n) && n >= 0);

    const { count } = await this.prisma.roomEvent.deleteMany({
      where: { roomId, attachId, type: 'bin' },
    });
    /* Object storage holds the same slices once media moves off RoomEvent.
     * Not awaited into the return value — the rows are already gone, which is
     * what makes the photo unreachable — but not fire-and-forget either: an
     * unresolved promise here would let the process exit mid-delete. */
    await this.purgeAttachmentObjects(roomId, attachId, seqs);
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
