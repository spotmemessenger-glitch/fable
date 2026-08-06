import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';

/**
 * The "Private photo" promise, tested where it is actually kept.
 *
 * Before this existed the server had never heard of view-once: `grep viewOnce
 * backend/src` returned nothing, RoomEvent had no expiry, and `fetch` served
 * any slice by attachId to any socket that had joined the room. So a recipient
 * who watched the burst animation, and a sender who was told the photo was
 * gone, were both looking at a photo that was still sitting in Postgres and
 * one console line away from being downloaded again.
 *
 * Three properties, each of which was false before:
 *
 *   1. the slices are DELETED when the viewer confirms the open;
 *   2. until then they are served to the claiming viewer and to nobody else;
 *   3. an ordinary attachment is untouched by any of it — meta.burn on a photo
 *      that was never marked view-once must not delete anything.
 *
 * Runs against the dev Postgres in DATABASE_URL, same as the gateway spec.
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('view-once attachments', () => {
  let app: INestApplication;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
  });

  async function connectGuest(): Promise<Socket> {
    const id = hex(16);
    const res = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username: 'v_' + id.slice(0, 10), name: 'Test', secret: 'testsecret1', birthYearMonth: '1990-01' }),
    });
    expect(res.status).toBe(201);
    const { accessToken } = (await res.json()) as { accessToken: string };
    const socket = io(`${url}/rooms`, {
      auth: { token: accessToken },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }

  /** One attachment slice, exactly as the web transport frames it. */
  const sendSlice = (
    socket: Socket,
    roomId: string,
    attachId: string,
    meta: Record<string, unknown>,
    body = 'ciphertext',
  ) =>
    socket.timeout(8000).emitWithAck('action', {
      roomId,
      type: 'bin',
      payload: Buffer.from(body).toString('base64'),
      meta,
      attachId,
    });

  const fetchSeq0 = (socket: Socket, roomId: string, attachId: string) =>
    socket.timeout(8000).emitWithAck('fetch', { roomId, attachId, seq: 0 });

  it('serves a view-once photo to its viewer, refuses everyone else, and destroys it on open', async () => {
    const alice = await connectGuest();
    const bob = await connectGuest();
    const mallory = await connectGuest();
    const roomId = 'test-vo-' + hex(8);
    const attachId = hex(8);

    for (const s of [alice, bob, mallory]) {
      await s.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    }

    // Sent with the view-once marker in cleartext routing meta — the only
    // thing the server can read about an otherwise opaque payload.
    await sendSlice(alice, roomId, attachId, { id: attachId, seq: 0, total: 1, once: true });

    // The recipient may fetch it: the first non-sender to ask claims the view.
    const first = await fetchSeq0(bob, roomId, attachId);
    expect(first.error).toBeUndefined();
    expect(Buffer.from(first.payload, 'base64').toString()).toBe('ciphertext');

    // Anyone else in the room is refused while the bytes still exist.
    const intruder = await fetchSeq0(mallory, roomId, attachId);
    expect(intruder.error).toMatch(/not sent to you/);
    expect(intruder.payload).toBeUndefined();

    // Opening it burns it. The client fires this the instant the photo opens.
    await bob.timeout(8000).emitWithAck('action', {
      roomId,
      type: 'seen',
      payload: Buffer.from('sealed-seen').toString('base64'),
      meta: { id: attachId, burn: attachId },
    });

    // THE POINT OF THE WHOLE FEATURE: the bytes are gone from the server, for
    // the viewer who just watched it burn as much as for anybody else.
    expect((await fetchSeq0(bob, roomId, attachId)).missing).toBe(true);
    expect((await fetchSeq0(alice, roomId, attachId)).missing).toBe(true);

    // And a device that was never there does not learn the message exists:
    // deleting the seq-0 slice takes it out of the replay envelope list too.
    const late = await connectGuest();
    const replay = await late.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    expect((replay.envelopes as { attachId: string }[]).map((e) => e.attachId))
      .not.toContain(attachId);
  });

  it('leaves an ordinary attachment alone, even when told to burn it', async () => {
    const alice = await connectGuest();
    const bob = await connectGuest();
    const roomId = 'test-plain-' + hex(8);
    const attachId = hex(8);

    await alice.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    await bob.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    await sendSlice(alice, roomId, attachId, { id: attachId, seq: 0, total: 1 }, 'ordinary-photo');

    // No `once` marker, so meta.burn must be inert — otherwise anyone in the
    // room could delete any attachment by guessing its id.
    await bob.timeout(8000).emitWithAck('action', {
      roomId,
      type: 'seen',
      payload: Buffer.from('sealed-seen').toString('base64'),
      meta: { id: attachId, burn: attachId },
    });

    const still = await fetchSeq0(bob, roomId, attachId);
    expect(Buffer.from(still.payload, 'base64').toString()).toBe('ordinary-photo');

    // A plain attachment also stays fetchable by everyone who has the room —
    // the claim only applies to view-once.
    const other = await connectGuest();
    await other.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    expect((await fetchSeq0(other, roomId, attachId)).error).toBeUndefined();
  });

  it('never lets the sender consume the recipient\'s single view', async () => {
    const alice = await connectGuest();
    const bob = await connectGuest();
    const roomId = 'test-vo-self-' + hex(8);
    const attachId = hex(8);

    await alice.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    await bob.timeout(8000).emitWithAck('join', { roomId, since: 0 });
    await sendSlice(alice, roomId, attachId, { id: attachId, seq: 0, total: 1, once: true });

    // The sender re-fetching their own photo (a store shed, a reload) must not
    // register as "the view", or the recipient would be locked out of a photo
    // they had never seen.
    expect((await fetchSeq0(alice, roomId, attachId)).error).toBeUndefined();
    expect((await fetchSeq0(bob, roomId, attachId)).error).toBeUndefined();
  });
});
