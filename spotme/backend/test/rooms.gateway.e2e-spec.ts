import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';

/**
 * Regression guard for the transport bug that killed the whole app.
 *
 * Payloads used to cross the wire as Buffers. socket.io turns each one into a
 * separate binary frame after the JSON packet, and that sequence is not atomic:
 * a heartbeat or another emit lands between frames, the client decoder reads
 * text where it expects binary, and it drops the socket with `parse error`.
 * A join whose replay carried ~10 events did that every single time, and
 * because sends fail asynchronously the only symptom was screens quietly
 * refusing to update — the worst kind of failure to diagnose.
 *
 * So the test that matters is: seed a replay big enough to have broken the old
 * protocol, rejoin, and require the socket to be ALIVE with every event
 * present. If payload framing ever regresses to binary, this fails.
 *
 * Runs against the dev Postgres in DATABASE_URL and cleans up after itself.
 */
jest.setTimeout(60_000);

const EVENT_COUNT = 15; // comfortably past the ~8-11 where the old wire broke

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('RoomsGateway wire protocol', () => {
  let app: INestApplication;
  let url: string;
  let roomId: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    url = await app.getUrl();
    roomId = 'test-' + hex(8);
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
  });

  /** A guest identity + live socket, exactly as the web client does it. */
  async function connectGuest(): Promise<Socket> {
    const id = hex(16);
    const res = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username: 't_' + id.slice(0, 10), name: 'Test', secret: 'testsecret1' }),
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

  it('replays a multi-event backlog without dropping the socket', async () => {
    const sender = await connectGuest();
    await sender.timeout(8000).emitWithAck('join', { roomId, since: 0 });

    for (let i = 0; i < EVENT_COUNT; i++) {
      const ack = await sender.timeout(8000).emitWithAck('action', {
        roomId,
        type: 'msg',
        payload: Buffer.from(`ciphertext-${i}`).toString('base64'),
        meta: null,
      });
      expect(ack.seq).toBeGreaterThan(0);
    }

    const joiner = await connectGuest();
    const dropped: string[] = [];
    joiner.on('disconnect', (reason) => dropped.push(reason));

    const ack = await joiner.timeout(8000).emitWithAck('join', { roomId, since: 0 });

    expect(dropped).toEqual([]);
    expect(joiner.connected).toBe(true);
    expect(ack.events).toHaveLength(EVENT_COUNT);
    // Text on the wire, never a Buffer/placeholder — that is the whole fix.
    for (const event of ack.events) {
      expect(typeof event.payload).toBe('string');
    }
    expect(Buffer.from(ack.events[0].payload, 'base64').toString()).toBe('ciphertext-0');
  });

  it('relays a live action to the other member and persists it once', async () => {
    const a = await connectGuest();
    const b = await connectGuest();
    const liveRoom = 'test-live-' + hex(8);
    await a.timeout(8000).emitWithAck('join', { roomId: liveRoom, since: 0 });
    await b.timeout(8000).emitWithAck('join', { roomId: liveRoom, since: 0 });

    const received = new Promise<Record<string, unknown>>((resolve) =>
      b.once('action', (frame) => resolve(frame)),
    );
    await a.timeout(8000).emitWithAck('action', {
      roomId: liveRoom,
      type: 'msg',
      payload: Buffer.from('hello-live').toString('base64'),
      meta: null,
    });

    const frame = await received;
    expect(typeof frame.payload).toBe('string');
    expect(Buffer.from(frame.payload as string, 'base64').toString()).toBe('hello-live');

    // Present on rejoin too: relay and persistence are one operation.
    const replay = await b.timeout(8000).emitWithAck('join', { roomId: liveRoom, since: 0 });
    expect(replay.events).toHaveLength(1);
  });

  it('refuses an unknown action type and never logs it', async () => {
    const s = await connectGuest();
    const junkRoom = 'test-junk-' + hex(8);
    await s.timeout(8000).emitWithAck('join', { roomId: junkRoom, since: 0 });
    const ack = await s.timeout(8000).emitWithAck('action', {
      roomId: junkRoom, type: 'not-a-real-type', payload: '', meta: null,
    });
    expect(ack.error).toMatch(/unknown action type/);
    const replay = await s.timeout(8000).emitWithAck('join', { roomId: junkRoom, since: 0 });
    expect(replay.events).toHaveLength(0);
  });

  it('rejects a socket with no token', async () => {
    const socket = io(`${url}/rooms`, { transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    const outcome = await new Promise<string>((resolve) => {
      const verdict = setTimeout(
        () => resolve(socket.connected ? 'STILL CONNECTED' : 'closed'),
        4000,
      );
      const settle = (result: string) => { clearTimeout(verdict); resolve(result); };
      socket.once('disconnect', (reason) => settle('disconnected:' + reason));
      socket.once('connect_error', () => settle('connect_error'));
    });
    expect(outcome).not.toBe('STILL CONNECTED');
  });
});
