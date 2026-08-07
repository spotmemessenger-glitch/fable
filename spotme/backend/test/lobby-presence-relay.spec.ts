/**
 * A2 — NEARBY FINDS NOBODY: the server half, verified.
 *
 * The live Nearby list is `lobby.peers()` — Socket.IO room presence — so the
 * first question is whether the server actually relays a lobby `hello`
 * between two connected accounts. This proves it does (and that `hello` stays
 * EPHEMERAL: relayed, never persisted, never replayed to a later joiner),
 * which pins the server half of the mechanism while A2's client half — the
 * orphaned visibility PUT — is fixed in the web tree.
 *
 * What this spec CANNOT prove: two physical phones on carrier NAT. It proves
 * the relay contract those phones depend on.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';

const hex = (n: number) => randomBytes(n).toString('hex');

let app: INestApplication;
let url: string;
const sockets: Socket[] = [];

// The web client's constant (web/src/lib/discovery.js:26): one app-wide room.
const LOBBY_ROOM = 'spotme-lobby-v1';

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'lobby-relay-0123456789abcdef0123456';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }],
  });
  await app.listen(0);
  url = await app.getUrl();
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  await app?.close();
});

async function connectGuest(): Promise<Socket> {
  const id = hex(8);
  const res = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username: 'lb_' + id.slice(0, 10), name: 'Lobby', secret: 'testsecret1', birthYearMonth: '1990-01' }),
  });
  expect(res.status).toBe(201);
  const { accessToken } = (await res.json()) as { accessToken: string };
  const socket = io(`${url}/rooms`, { auth: { token: accessToken }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

describe('A2 — lobby presence relay', () => {
  it('relays hello between two members of the lobby room, and persists nothing', async () => {
    const a = await connectGuest();
    const b = await connectGuest();
    await a.timeout(8000).emitWithAck('join', { roomId: LOBBY_ROOM, since: 0 });
    await b.timeout(8000).emitWithAck('join', { roomId: LOBBY_ROOM, since: 0 });

    const seen: unknown[] = [];
    b.on('action', (frame: { type?: string }) => { if (frame?.type === 'hello') seen.push(frame); });

    const payload = Buffer.from(JSON.stringify({ id: 'a', name: 'A', ts: Date.now() })).toString('base64');
    const ack = await a.timeout(8000).emitWithAck('action', { roomId: LOBBY_ROOM, type: 'hello', payload, meta: null });
    expect(ack).toBeTruthy();

    await new Promise((r) => setTimeout(r, 300));
    expect(seen.length).toBeGreaterThanOrEqual(1);

    // A later joiner replays the log — hello is EPHEMERAL and must not be in it.
    const c = await connectGuest();
    const joined = await c.timeout(8000).emitWithAck('join', { roomId: LOBBY_ROOM, since: 0 });
    const types = ((joined.events ?? []) as Array<{ type: string }>).map((e) => e.type);
    expect(types).not.toContain('hello');
  });
});
