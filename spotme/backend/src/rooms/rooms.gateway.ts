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
import { PushService } from '../push/push.service';
import { GroupPolicy, GroupsService } from '../groups/groups.service';
import { RoomsService } from './rooms.service';

interface JoinPayload {
  roomId: string;
  since?: number;
}

interface ActionPayload {
  roomId: string;
  type: string;
  /** base64 ciphertext — see the binary-framing note below. */
  payload?: string | null;
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
 * fetchreq/fetchres are the transport's peer-to-peer lazy-fetch fallback.
 * `hello` is the discovery lobby's presence heartbeat: replaying an old
 * "I am nearby" would tell the user something untrue, so it must never
 * reach the log. */
const EPHEMERAL = new Set([
  'typing', 'call', 'locup', 'rtc', 'history', 'fetchreq', 'fetchres', 'hello',
]);

/** How long a cached group policy is trusted — also the worst-case delay
 *  before a ban or mute takes effect on an already-connected socket. */
const POLICY_TTL_MS = 5_000;
const POLICY_CACHE_MAX = 10_000;

/**
 * PAYLOADS TRAVEL AS BASE64 TEXT, NEVER AS BINARY ATTACHMENTS.
 *
 * socket.io encodes a Buffer as a placeholder in the JSON packet plus one
 * separate binary frame per Buffer, and the client's decoder then expects
 * exactly those frames next. That sequence is NOT atomic: a heartbeat ping or
 * another emit can land between the frames, the decoder receives text where it
 * expects binary, and it kills the connection with `parse error`. Measured
 * here: a join whose replay carried ~8-11 Buffers dropped the socket every
 * time, and the failure threshold moved with unrelated traffic — which is what
 * proves it is interleaving rather than size.
 *
 * A dead socket is near-invisible from the UI (sends fail asynchronously and
 * screens simply stop updating), so the protocol trades ~33% on ciphertext for
 * a single text frame that cannot be split. Media moves to signed R2 URLs in
 * Phase 2, which removes the bulk of this cost.
 */
const decodeB64 = (data: string | null | undefined): Buffer =>
  typeof data === 'string' && data.length ? Buffer.from(data, 'base64') : Buffer.alloc(0);

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

  // Group policy is consulted on every send, so it is cached briefly rather
  // than hitting Postgres per keystroke-sized event. The TTL is the blast
  // radius: a ban or mute takes at most this long to bite.
  private policyCache = new Map<string, { policy: GroupPolicy | null; expires: number }>();

  constructor(
    private roomsService: RoomsService,
    private jwt: JwtService,
    private push: PushService,
    private groups: GroupsService,
  ) {}

  /**
   * Null means "not a group" — a DM, where knowing the roomId is still the
   * whole access model. For groups this is the ONLY thing standing between a
   * banned or muted member and the room, because the client cannot be trusted
   * to enforce its own restrictions.
   */
  private async policy(roomId: string, userId: string): Promise<GroupPolicy | null> {
    const key = `${roomId}|${userId}`;
    const hit = this.policyCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.policy;
    const policy = await this.groups.policyFor(roomId, userId).catch(() => null);
    this.policyCache.set(key, { policy, expires: Date.now() + POLICY_TTL_MS });
    if (this.policyCache.size > POLICY_CACHE_MAX) {
      // Cheap bound: drop the oldest insertions rather than track LRU.
      const excess = this.policyCache.size - POLICY_CACHE_MAX;
      let dropped = 0;
      for (const k of this.policyCache.keys()) {
        this.policyCache.delete(k);
        if (++dropped >= excess) break;
      }
    }
    return policy;
  }

  /** Users with at least one live socket anywhere — they need no push. */
  private connectedUsers(): Set<string> {
    const live = new Set<string>();
    for (const room of this.rooms.values()) {
      for (const [userId, sockets] of room) {
        if (sockets.size) live.add(userId);
      }
    }
    return live;
  }

  /**
   * Tell absent members something arrived.
   *
   * Never awaited by the send path: a message must land whether or not
   * Apple's push service is reachable this second, and a sender should not
   * wait on it either.
   */
  private pushForEvent(roomId: string, type: string, senderId: string): void {
    const title = type === 'knock' ? 'New chat request' : 'New message';
    void (async () => {
      try {
        const members = await this.push.membersToNotify(roomId, senderId);
        const live = this.connectedUsers();
        const absent = members.filter((id) => !live.has(id));
        if (!absent.length) return;
        // No message text: the payload passes through Apple and Google, and
        // handing them content is exactly what the encryption exists to stop.
        await this.push.notify(absent, {
          title,
          body: type === 'knock' ? 'Someone wants to chat' : 'Open Spot Me to read it',
          tag: roomId,
        });
      } catch {
        /* push is a courtesy; never let it break delivery */
      }
    })();
  }

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
    // For a group room, membership is authoritative and knowing the id is NOT
    // enough — a removed or banned member still has the id and would otherwise
    // walk straight back in and replay the whole history.
    const policy = await this.policy(roomId, userId);
    if (policy?.banned) return { error: 'not a member of this group' };

    // Rooms are opaque ids the server cannot decode, so membership is learned
    // from who joins — and it is the only way to know whom to notify later.
    void this.push.remember(roomId, userId).catch(() => undefined);

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
        payload: Buffer.from(e.payload).toString('base64'),
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

    // Group permissions are enforced here or not at all: the client cannot be
    // trusted to honour its own mute, and every restriction below is invisible
    // to the transport otherwise.
    const policy = await this.policy(roomId, userId);
    if (policy) {
      const refusal = this.refuse(policy, type, body.meta);
      if (refusal) return { error: refusal };
    }

    const payload = decodeB64(body.payload);
    let seq: number | undefined;
    if (this.roomsService.isPersisted(type)) {
      const created = await this.roomsService.append(
        roomId, type, userId, payload, body.meta, body.attachId,
      );
      seq = created.id;
      // Only things a person would want waking their phone. Read receipts and
      // profile syncs are persisted too, and a notification for those would
      // teach people to swipe Spot Me away without looking.
      if (type === 'msg' || type === 'knock') {
        this.pushForEvent(roomId, type, userId);
      }
    } else if (!EPHEMERAL.has(type)) {
      return { error: `unknown action type: ${type}` };
    }

    // Relay the base64 the sender gave us, untouched — no re-encode, and no
    // Buffer on the wire (see decodeB64's note).
    const frame = { roomId, seq, type, from: userId, payload: body.payload ?? '', meta: body.meta };
    if (target) {
      // Targeted send — deliver to every live socket of that user in this room.
      const sockets = this.rooms.get(roomId)?.get(target);
      if (sockets) for (const s of sockets) s.emit('action', frame);
    } else {
      client.to(`r:${roomId}`).emit('action', frame);
    }
    return { seq };
  }

  /**
   * Why a group action is refused, or null to allow it.
   *
   * DELETE IS ONLY PARTLY ENFORCEABLE. The id of the message being deleted
   * travels inside the ciphertext, so the server cannot tell whose message it
   * is. Clients therefore put the original sender in cleartext meta.owner —
   * the same "routing only, no content" channel attachment slices use. When it
   * is absent (older clients) the delete is allowed, because refusing every
   * unlabelled delete would break existing installs. Tightening this to a hard
   * requirement is safe once clients have rolled forward.
   */
  private refuse(
    policy: GroupPolicy,
    type: string,
    meta: Record<string, unknown> | undefined,
  ): string | null {
    if (policy.banned) return 'not a member of this group';
    switch (type) {
      case 'msg':
        if (!policy.canMessage) {
          return policy.muted ? 'you are muted in this group' : 'members cannot send messages here';
        }
        return null;
      case 'bin':
        if (!policy.canMedia) {
          return policy.muted ? 'you are muted in this group' : 'members cannot send media here';
        }
        return null;
      case 'edit':
        // You may only ever edit your own message, so a mute is the only bar.
        return policy.muted ? 'you are muted in this group' : null;
      case 'del': {
        const owner = typeof meta?.owner === 'string' ? meta.owner : null;
        if (owner && owner !== policy.selfId && !policy.canDeleteOthers) {
          return 'you cannot delete other people’s messages';
        }
        return null;
      }
      default:
        return null;
    }
  }

  @SubscribeMessage('fetch')
  async onFetch(@ConnectedSocket() client: Socket, @MessageBody() body: FetchPayload) {
    if (!body?.roomId || !body?.attachId) return { error: 'bad fetch' };
    if (!(client.data.joined as Set<string>)?.has(body.roomId)) return { error: 'not joined' };
    const slice = await this.roomsService.fetchSlice(
      body.roomId, body.attachId, Number(body.seq) || 0,
    );
    if (!slice) return { missing: true };
    return {
      payload: Buffer.from(slice.payload).toString('base64'),
      meta: slice.meta,
      total: slice.total,
    };
  }
}
