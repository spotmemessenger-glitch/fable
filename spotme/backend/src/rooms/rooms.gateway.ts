import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { RoomsService } from './rooms.service';

interface JoinPayload {
  roomId: string;
  since?: number;
}

interface ActionPayload {
  roomId: string;
  type: string;
  payload?: Buffer | ArrayBuffer | null;
  meta?: Record<string, unknown>;
  target?: string; // userId — targeted send, mirrors Trystero's {target}
  attachId?: string;
}

interface FetchPayload {
  roomId: string;
  attachId: string;
  seq: number;
}

/** Ephemeral action types relayed but never persisted (no ghost replays).
 * fetchreq/fetchres are the transport's peer-to-peer lazy-fetch fallback. */
const EPHEMERAL = new Set(['typing', 'call', 'locup', 'rtc', 'history', 'fetchreq', 'fetchres']);

const toBuffer = (data: Buffer | ArrayBuffer | null | undefined): Buffer =>
  Buffer.isBuffer(data) ? data : data ? Buffer.from(new Uint8Array(data)) : Buffer.alloc(0);

/**
 * Server-backed rooms for the web client — the drop-in replacement for
 * Trystero's tracker-discovered WebRTC rooms. Peers are sockets grouped by
 * roomId; persistent actions land in the RoomEvent log and replay on join,
 * which is what gives Spot Me true offline delivery for the first time.
 *
 * The server relays and stores ciphertext. It can see WHO is in WHICH room
 * and WHEN — the same metadata BitTorrent trackers saw — but not content.
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/rooms',
  maxHttpBufferSize: 8 * 1024 * 1024, // attachment slices are 128KB; headroom, not license
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  // roomId -> userId -> live sockets. In-memory: single node is Phase 1;
  // the Redis adapter replaces this map when the gateway scales out.
  private rooms = new Map<string, Map<string, Set<Socket>>>();

  constructor(
    private roomsService: RoomsService,
    private jwt: JwtService,
  ) {}

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) return client.disconnect();
    try {
      const payload = this.jwt.verify(token, {
        secret: process.env.JWT_ACCESS_SECRET || 'dev-only-secret',
      });
      client.data.userId = payload.sub as string;
      client.data.joined = new Set<string>();
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    for (const roomId of (client.data.joined as Set<string>) ?? []) {
      this.dropMember(roomId, userId, client);
    }
  }

  private members(roomId: string): Map<string, Set<Socket>> {
    let m = this.rooms.get(roomId);
    if (!m) {
      m = new Map();
      this.rooms.set(roomId, m);
    }
    return m;
  }

  private dropMember(roomId: string, userId: string, client: Socket) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const sockets = room.get(userId);
    if (!sockets) return;
    sockets.delete(client);
    if (sockets.size === 0) {
      room.delete(userId);
      // Last socket of this user gone -> the peer left, tell the room.
      this.server.to(`r:${roomId}`).emit('peer', { roomId, peerId: userId, action: 'leave' });
    }
    if (room.size === 0) this.rooms.delete(roomId);
  }

  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() client: Socket, @MessageBody() body: JoinPayload) {
    const userId = client.data.userId as string;
    const { roomId } = body;
    if (!roomId || typeof roomId !== 'string' || roomId.length > 128) {
      return { error: 'bad roomId' };
    }
    const room = this.members(roomId);
    const firstSocket = !room.has(userId);
    if (firstSocket) room.set(userId, new Set());
    room.get(userId)!.add(client);
    (client.data.joined as Set<string>).add(roomId);
    await client.join(`r:${roomId}`);
    if (firstSocket) {
      client.to(`r:${roomId}`).emit('peer', { roomId, peerId: userId, action: 'join' });
    }
    const since = Number.isFinite(body.since) ? Math.max(0, Number(body.since)) : 0;
    const { events, envelopes, lastEventId } = await this.roomsService.replay(roomId, since);
    return {
      peers: [...room.keys()].filter((id) => id !== userId),
      events: events.map((e) => ({
        seq: e.id,
        type: e.type,
        from: e.senderId,
        payload: e.payload,
        meta: e.meta,
      })),
      envelopes: envelopes.map((e) => ({ seq: e.id, from: e.senderId, meta: e.meta, attachId: e.attachId })),
      lastEventId,
    };
  }

  @SubscribeMessage('leave')
  onLeave(@ConnectedSocket() client: Socket, @MessageBody() body: { roomId: string }) {
    const userId = client.data.userId as string;
    if (!body?.roomId) return;
    (client.data.joined as Set<string>)?.delete(body.roomId);
    client.leave(`r:${body.roomId}`);
    this.dropMember(body.roomId, userId, client);
  }

  @SubscribeMessage('action')
  async onAction(@ConnectedSocket() client: Socket, @MessageBody() body: ActionPayload) {
    const userId = client.data.userId as string;
    const { roomId, type, target } = body;
    if (!roomId || !type) return { error: 'bad action' };
    if (!(client.data.joined as Set<string>)?.has(roomId)) return { error: 'not joined' };

    const payload = toBuffer(body.payload);
    let seq: number | undefined;
    if (this.roomsService.isPersisted(type)) {
      const created = await this.roomsService.append(
        roomId, type, userId, payload, body.meta, body.attachId,
      );
      seq = created.id;
    } else if (!EPHEMERAL.has(type)) {
      return { error: `unknown action type: ${type}` };
    }

    const frame = { roomId, seq, type, from: userId, payload, meta: body.meta };
    if (target) {
      // Targeted send — deliver to every live socket of that user in this room.
      const sockets = this.rooms.get(roomId)?.get(target);
      if (sockets) for (const s of sockets) s.emit('action', frame);
    } else {
      client.to(`r:${roomId}`).emit('action', frame);
    }
    return { seq };
  }

  @SubscribeMessage('fetch')
  async onFetch(@ConnectedSocket() client: Socket, @MessageBody() body: FetchPayload) {
    if (!body?.roomId || !body?.attachId) return { error: 'bad fetch' };
    if (!(client.data.joined as Set<string>)?.has(body.roomId)) return { error: 'not joined' };
    const slice = await this.roomsService.fetchSlice(
      body.roomId, body.attachId, Number(body.seq) || 0,
    );
    return slice ?? { missing: true };
  }
}
