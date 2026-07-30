import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PushService } from '../src/push/push.service';

/**
 * Push is about WHO gets woken, and the interesting cases are all the ones
 * where nobody should be.
 *
 * Actually delivering to Apple or Google needs a real browser subscription and
 * a real device, so that half is verified by hand. What is tested here is the
 * decision — the part that silently rots and that nobody notices until users
 * are either missing messages or being spammed for their own read receipts.
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('push routing', () => {
  let app: INestApplication;
  let url: string;
  let push: PushService;
  const sockets: Socket[] = [];
  const notified: { users: string[]; title: string }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    url = await app.getUrl();
    push = app.get(PushService);
    // Record intent instead of contacting a push service: this asserts the
    // decision, which is the part under test.
    jest.spyOn(push, 'notify').mockImplementation(async (users, payload) => {
      notified.push({ users, title: payload.title });
      return { sent: users.length };
    });
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
  });

  async function connect(): Promise<{ socket: Socket; id: string }> {
    const id = hex(16);
    const res = await fetch(`${url}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, username: 'p_' + id.slice(0, 10), name: 'Push', secret: 'pushsecret1',
      }),
    });
    const { accessToken } = (await res.json()) as { accessToken: string };
    const socket = io(`${url}/rooms`, {
      auth: { token: accessToken }, transports: ['websocket'], reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return { socket, id };
  }

  const settle = () => new Promise((r) => setTimeout(r, 400));

  it('does not push to someone who is connected and watching', async () => {
    const room = 'push-live-' + hex(6);
    const a = await connect();
    const b = await connect();
    await a.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    await b.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    notified.length = 0;

    await a.socket.timeout(8000).emitWithAck('action', {
      roomId: room, type: 'msg', payload: Buffer.from('hi').toString('base64'), meta: null,
    });
    await settle();

    // b received it over its own socket; a push would notify about something
    // already on screen.
    expect(notified).toEqual([]);
  });

  it('pushes to a member who has gone away', async () => {
    const room = 'push-away-' + hex(6);
    const a = await connect();
    const b = await connect();
    await a.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    await b.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });

    b.socket.close();                     // phone closed the app
    await settle();
    notified.length = 0;

    await a.socket.timeout(8000).emitWithAck('action', {
      roomId: room, type: 'msg',
      payload: Buffer.from('you there?').toString('base64'), meta: null,
    });
    await settle();

    expect(notified).toHaveLength(1);
    expect(notified[0].users).toEqual([b.id]);
    expect(notified[0].users).not.toContain(a.id);   // never notify the sender
    expect(notified[0].title).toBe('New message');
  });

  it('calls a knock a chat request, not a message', async () => {
    const room = 'push-knock-' + hex(6);
    const a = await connect();
    const b = await connect();
    await a.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    await b.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    b.socket.close();
    await settle();
    notified.length = 0;

    await a.socket.timeout(8000).emitWithAck('action', {
      roomId: room, type: 'knock',
      payload: Buffer.from('knock').toString('base64'), meta: null,
    });
    await settle();

    expect(notified[0]?.title).toBe('New chat request');
  });

  it('stays silent for read receipts and profile syncs', async () => {
    const room = 'push-quiet-' + hex(6);
    const a = await connect();
    const b = await connect();
    await a.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    await b.socket.timeout(8000).emitWithAck('join', { roomId: room, since: 0 });
    b.socket.close();
    await settle();
    notified.length = 0;

    for (const type of ['read', 'profile', 'seen', 'react']) {
      await a.socket.timeout(8000).emitWithAck('action', {
        roomId: room, type, payload: Buffer.from('x').toString('base64'), meta: null,
      });
    }
    await settle();

    // These are persisted and replayed, but waking a phone for a read receipt
    // is how people learn to swipe an app's notifications away unread.
    expect(notified).toEqual([]);
  });

  it('reports itself dormant without VAPID keys, and never claims otherwise', async () => {
    const res = await fetch(`${url}/api/push`);
    const cfg = (await res.json()) as { enabled: boolean; publicKey: string | null };
    expect(res.status).toBe(200);
    if (!process.env.VAPID_PUBLIC_KEY) {
      expect(cfg.enabled).toBe(false);
      expect(cfg.publicKey).toBeNull();
    } else {
      expect(cfg.enabled).toBe(true);
      expect(typeof cfg.publicKey).toBe('string');
    }
  });
});
