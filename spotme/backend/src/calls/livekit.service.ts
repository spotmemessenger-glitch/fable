import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';

/**
 * LiveKit — the CALL MEDIA path. ADR-003.
 *
 * Scope, because the name invites scope creep: this carries audio and video
 * frames and nothing else. Messages, presence, typing and read receipts stay on
 * the Socket.IO room path; call SIGNALLING (ring / accept / decline / hang up)
 * also stays there, because it already works and is transport-agnostic. What
 * moves here is only the leg that a carrier NAT breaks — the media itself.
 *
 * ---------------------------------------------------------------------------
 * WHY A HAND-MINTED JWT RATHER THAN livekit-server-sdk
 *
 * A LiveKit access token is an HS256 JWT with a documented, stable claim shape
 * (iss = API key, sub = participant identity, exp/nbf, and a `video` grant
 * object). `realtime.controller.ts` already mints the Centrifugo token exactly
 * this way with node:crypto. Adding a dependency to a service another session
 * is actively deploying, to produce twenty lines of JSON, is a cost with no
 * return. `livekit.service.spec.ts` pins the claim shape so a drift in
 * LiveKit's expectations fails a test rather than a call.
 *
 * ---------------------------------------------------------------------------
 * ROOM LIFECYCLE
 *
 * CREATE is implicit: LiveKit materialises a room when its first participant
 * joins with a valid token and reaps it once empty. There is deliberately no
 * create endpoint — one would only be an extra way for the two sides to
 * disagree about whether the room exists.
 *
 * JOIN is `mintToken()`. LEAVE is the client disconnecting; the SFU notices.
 * `endRoom()` is the one genuinely server-side act — it evicts EVERY
 * participant, which a client hanging up cannot do and group calls will need.
 */
@Injectable()
export class LiveKitService {
  /**
   * Short by design. The token is spent within seconds of being minted (the
   * client fetches it and immediately connects), and LiveKit only checks it at
   * connection time — an established call is not dropped when its token
   * expires. Ten minutes is slack for a slow network, not a session length.
   */
  static readonly TOKEN_TTL_SECONDS = 10 * 60;

  /**
   * The LiveKit room name for a Spot Me conversation.
   *
   * DERIVED SERVER-SIDE, NEVER TAKEN FROM THE REQUEST. The client asks to call
   * in a `roomId` it is a member of; this turns that into the media room name.
   * Accepting a room name from the body would let any signed-in user mint a
   * token for any room on the LiveKit project — membership would be checked
   * against one identifier and the token issued for another.
   */
  static roomName(roomId: string): string {
    return `spotme-call-${roomId}`;
  }

  /** False when this deployment has no LiveKit configured — callers 503. */
  isConfigured(): boolean {
    return Boolean(
      process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET,
    );
  }

  /** The wss:// URL the browser connects to. */
  url(): string {
    return String(process.env.LIVEKIT_URL || '');
  }

  /**
   * A join token for ONE participant in ONE room.
   *
   * `identity` must come from the verified JWT principal at the call site, not
   * from a request body — the token is the whole of LiveKit's idea of who this
   * participant is, so a caller who could choose it could join as anyone.
   *
   * The grant is deliberately narrow: join this one room, publish and subscribe
   * media, and nothing else. No roomCreate (rooms appear on join anyway), no
   * roomAdmin (that would let a participant evict the person they are calling),
   * no roomList.
   */
  mintToken(params: {
    identity: string;
    roomName: string;
    name?: string;
    ttlSeconds?: number;
    canPublish?: boolean;
  }): { token: string; url: string; expiresIn: number } {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      throw new ServiceUnavailableException('livekit is not configured on this deployment');
    }

    const ttl = params.ttlSeconds ?? LiveKitService.TOKEN_TTL_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: apiKey,
      sub: params.identity,
      // `nbf` a minute in the past: a phone whose clock runs slightly fast
      // would otherwise mint a token that its own SFU rejects as not-yet-valid.
      nbf: now - 60,
      iat: now,
      exp: now + ttl,
      ...(params.name ? { name: params.name } : {}),
      video: {
        room: params.roomName,
        roomJoin: true,
        canPublish: params.canPublish !== false,
        canSubscribe: true,
        // Chat data does NOT ride LiveKit — it has its own sealed path. Denying
        // the data channel keeps that true by construction rather than by
        // everyone remembering.
        canPublishData: false,
      },
    };

    return { token: this.sign(claims, apiSecret), url, expiresIn: ttl };
  }

  /**
   * End the call for everyone in a room.
   *
   * Needs a roomAdmin grant, which no participant token carries — this mints a
   * separate, thirty-second admin token for the one request. Returns false when
   * LiveKit is unreachable or refuses; the caller decides whether that matters,
   * because for a 1:1 hang-up it does not (both sides disconnect themselves and
   * the room reaps itself seconds later).
   */
  async endRoom(roomName: string): Promise<boolean> {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret || !this.isConfigured()) return false;

    const now = Math.floor(Date.now() / 1000);
    const admin = this.sign(
      {
        iss: apiKey,
        sub: 'spotme-server',
        nbf: now - 60,
        iat: now,
        exp: now + 30,
        video: { room: roomName, roomAdmin: true },
      },
      apiSecret,
    );

    try {
      const res = await fetch(`${this.httpUrl()}/twirp/livekit.RoomService/DeleteRoom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
        body: JSON.stringify({ room: roomName }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * The server API speaks HTTP on the same host the client reaches over
   * WebSocket, so one configured value serves both rather than two that can
   * drift apart.
   */
  private httpUrl(): string {
    return String(process.env.LIVEKIT_URL || '')
      .replace(/^ws/, 'http')
      .replace(/\/$/, '');
  }

  private sign(claims: Record<string, unknown>, secret: string): string {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify(claims));
    const signature = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${signature}`;
  }
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
