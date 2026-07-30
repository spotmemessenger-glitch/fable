import { Test } from '@nestjs/testing';
import { RoomsService } from '../src/rooms/rooms.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';

/**
 * fetchSlice must never describe a half-uploaded attachment as a whole one.
 *
 * THE BUG THIS PINS. `total` used to be `slices.length` — how many rows the
 * server happened to hold. A 5-minute voice note is 37 slices; a socket drop
 * 150ms into the send left 5 of them in the log, and the server answered
 * "total: 5". The client's own guard (`throw new Error('transfer incomplete on
 * server')`) is bounded by exactly that number, so for a short TAIL — which is
 * precisely what an interrupted upload produces — it could never fire. The
 * receiver got 873,839 bytes of an expected 6,400,082, the store marked the
 * message complete, and it rendered as a valid 40-second note. Nobody on either
 * side was told anything.
 *
 * The declared total was already on the wire: every slice carries {id, seq,
 * total} in cleartext routing meta so a short transfer is DETECTABLE. It just
 * was not being read back. These tests hold that line, plus the `held` count
 * the client uses to refuse a short tail in one round trip.
 *
 * Runs against the dev Postgres in DATABASE_URL and cleans up after itself.
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('RoomsService.fetchSlice — truncation is visible', () => {
  let rooms: RoomsService;
  let prisma: PrismaService;

  const roomId = `rooms_test_${hex(16)}`;
  const sender = `rooms_test_sender_${hex(6)}`;
  const reader = `rooms_test_reader_${hex(6)}`;

  /** One stored slice, exactly as the gateway appends it. */
  const putSlice = (attachId: string, seq: number, total: number) =>
    rooms.append(
      roomId,
      'bin',
      sender,
      Buffer.from(`slice-${seq}`),
      { id: attachId, seq, total, cm: 'sealed' },
      attachId,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [RoomsService],
    }).compile();
    rooms = moduleRef.get(RoomsService);
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.roomEvent.deleteMany({ where: { roomId } });
    await prisma.$disconnect();
  });

  it('reports the total the sender declared, not the count it holds', async () => {
    // The measured failure: a 37-slice voice note that died after 5.
    const attachId = `att_${hex(12)}`;
    for (let seq = 0; seq < 5; seq++) await putSlice(attachId, seq, 37);

    const slice = await rooms.fetchSlice(roomId, attachId, 0, reader);
    expect(slice).not.toBeNull();
    expect(slice).not.toBe('denied');
    const got = slice as { total: number; held: number };
    expect(got.total).toBe(37);
    expect(got.held).toBe(5);
    // The whole point: the two disagree, so the client can tell.
    expect(got.held).toBeLessThan(got.total);
  });

  it('agrees with itself on a complete attachment', async () => {
    const attachId = `att_${hex(12)}`;
    for (let seq = 0; seq < 4; seq++) await putSlice(attachId, seq, 4);

    const got = (await rooms.fetchSlice(roomId, attachId, 3, reader)) as {
      total: number;
      held: number;
      payload: Buffer;
    };
    expect(got.total).toBe(4);
    expect(got.held).toBe(4);
    expect(Buffer.from(got.payload).toString()).toBe('slice-3');
  });

  it('counts distinct seqs, so a retried send cannot fake completeness', async () => {
    // Retry resends from slice 0, and the log appends rather than replaces. If
    // `held` counted rows, eight duplicate rows would look like eight slices.
    const attachId = `att_${hex(12)}`;
    for (const pass of [1, 2]) {
      void pass;
      for (let seq = 0; seq < 4; seq++) await putSlice(attachId, seq, 9);
    }

    const got = (await rooms.fetchSlice(roomId, attachId, 0, reader)) as {
      total: number;
      held: number;
    };
    expect(got.total).toBe(9);
    expect(got.held).toBe(4);
  });

  it('still answers when a slice declares no total, rather than throwing', async () => {
    // Older clients, and anything that lost its meta. Falling back to the
    // count it holds is the old behaviour and is the right floor here.
    const attachId = `att_${hex(12)}`;
    for (let seq = 0; seq < 3; seq++) {
      await rooms.append(roomId, 'bin', sender, Buffer.from(`x${seq}`), { id: attachId, seq }, attachId);
    }

    const got = (await rooms.fetchSlice(roomId, attachId, 0, reader)) as {
      total: number;
      held: number;
    };
    expect(got.total).toBe(3);
    expect(got.held).toBe(3);
  });

  it('returns null for a seq that was never stored', async () => {
    const attachId = `att_${hex(12)}`;
    await putSlice(attachId, 0, 12);
    expect(await rooms.fetchSlice(roomId, attachId, 7, reader)).toBeNull();
  });
});
