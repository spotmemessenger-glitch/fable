import { RoomsService } from '../src/rooms/rooms.service';

/**
 * View-once survives the move to object storage.
 *
 * `fetchSlice` describes itself as the only place view-once can be enforced —
 * true for as long as the server held the bytes. Phase 5 moves them to a
 * bucket and hands clients a presigned URL, which bypasses `fetchSlice`
 * entirely. Without `authorizeAttachmentRead` on the download route, that
 * migration would have silently removed the enforcement: the burst animation
 * would still play, the sender would still be told it was opened, and the
 * recipient could re-download the photo indefinitely. Nothing would fail.
 *
 * So this suite is the guard on the guard. Prisma is stubbed because the
 * question is the DECISION — who is allowed the bytes — not the storage of it;
 * the real claim against real Postgres is covered by view-once.e2e-spec.ts.
 */

type Claim = { viewerId: string | null; senderId: string; burnedAt: Date | null } | null;

const build = (opts: {
  claim?: Claim;
  envelope?: { senderId: string; meta: unknown } | null;
  createThrows?: boolean;
  existing?: { viewerId: string | null } | null;
}) => {
  const prisma = {
    viewOnce: {
      findUnique: jest.fn(async ({ select }: { select?: Record<string, boolean> }) =>
        // The download check and claimView both read this table but want
        // different columns; the stub answers whichever was asked for.
        select && 'burnedAt' in select ? (opts.claim ?? null) : (opts.existing ?? null)),
      create: jest.fn(async ({ data }: { data: { viewerId: string } }) => {
        if (opts.createThrows) throw new Error('unique violation');
        return { viewerId: data.viewerId };
      }),
    },
    roomEvent: {
      findFirst: jest.fn(async () => opts.envelope ?? null),
    },
  };
  return new RoomsService(prisma as never);
};

const ONCE = { senderId: 'sender1', meta: { once: true, seq: 0 } };
const ORDINARY = { senderId: 'sender1', meta: { seq: 0 } };

describe('authorizeAttachmentRead — view-once on the presigned download path', () => {
  it('allows an ordinary attachment for any room member', async () => {
    const rooms = build({ envelope: ORDINARY });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'anyone')).toBe('ok');
  });

  it('allows the FIRST non-sender to claim a view-once photo', async () => {
    const rooms = build({ envelope: ONCE });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'recipient')).toBe('ok');
  });

  it('DENIES a second person once someone else has claimed it', async () => {
    // The insert loses the unique race and reads back the winner.
    const rooms = build({ envelope: ONCE, createThrows: true, existing: { viewerId: 'recipient' } });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'mallory')).toBe('denied');
  });

  it('lets the SENDER read their own photo without consuming the recipient’s view', async () => {
    const rooms = build({ envelope: ONCE });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'sender1')).toBe('ok');
  });

  it('reports GONE after a burn — even though the RoomEvent rows are deleted', async () => {
    // This is the case that matters: burnAttachment removed every row, so
    // there is no envelope left to say it was ever view-once. The ViewOnce row
    // outlives them on purpose.
    const rooms = build({
      claim: { viewerId: 'recipient', senderId: 'sender1', burnedAt: new Date() },
      envelope: null,
    });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'recipient')).toBe('gone');
  });

  it('reports GONE to the sender too — a burn is not undone by who is asking', async () => {
    const rooms = build({
      claim: { viewerId: 'recipient', senderId: 'sender1', burnedAt: new Date() },
      envelope: null,
    });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'sender1')).toBe('gone');
  });

  it('distinguishes "gone" from "never existed" for a claimed-but-unburned id', async () => {
    // No envelope and no burn stamp, but a claim row exists: the rows are gone
    // and something did happen here. Answering "ok" would hand out a URL for
    // bytes nobody should still be reading.
    const rooms = build({
      claim: { viewerId: 'recipient', senderId: 'sender1', burnedAt: null },
      envelope: null,
    });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'anyone')).toBe('gone');
  });

  it('allows an attachment the server has no record of at all', async () => {
    // Nothing claimed, nothing stored: an ordinary object whose envelope has
    // been pruned. Membership, checked by the caller, remains the access model.
    const rooms = build({ envelope: null });
    expect(await rooms.authorizeAttachmentRead('room1', 'att1', 'member')).toBe('ok');
  });
});
