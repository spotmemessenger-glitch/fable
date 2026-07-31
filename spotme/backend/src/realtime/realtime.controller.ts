import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedPrincipal } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RoomsService } from '../rooms/rooms.service';
import { RoomsAuthService } from '../rooms/rooms-auth.service';

/**
 * Centrifugo connection tokens and the server-side publish proxy. ADR-002 §3-4.
 *
 * Centrifugo authenticates a connection with a JWT that WE sign, using a secret
 * only this server and the broker share. That is the whole point of minting it
 * here rather than letting the client present its own credential: the broker
 * never has to know what a Spot Me account is.
 */

/** Short by design — the client SDK re-fetches on expiry without reconnecting. */
const TOKEN_TTL_SECONDS = 10 * 60;

/** Mirrors `roomChannel()` in web/src/lib/transport/centrifugo-adapter.js. */
const roomChannel = (roomId: string) => `room:${roomId}`;

/** Same ceiling the Socket.IO gateway allows a frame (maxHttpBufferSize). */
const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface PublishBody {
  roomId?: string;
  type?: string;
  payload?: string | null;
  meta?: Record<string, unknown>;
  target?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('v2/realtime')
export class RealtimeController {
  constructor(
    private prisma: PrismaService,
    private rooms: RoomsService,
    private auth: RoomsAuthService,
  ) {}

  /**
   * A Centrifugo connection token for the CALLING user.
   *
   * `sub` comes from the verified JWT principal, never from the body — taking
   * it from the body would let any signed-in user mint a token impersonating
   * anyone, which is the same class of mistake the key-upload endpoint avoids
   * by keying off the principal.
   */
  @Post('token')
  @HttpCode(200)
  async token(@CurrentUser() principal: AuthenticatedPrincipal) {
    const secret = process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY;
    if (!secret) {
      // Absent config is "this transport is not available here", not a 500.
      // The client falls back to Socket.IO and says why.
      throw new ServiceUnavailableException('centrifugo is not configured on this deployment');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: principal.id, iat: now, exp: now + TOKEN_TTL_SECONDS }));
    const signature = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());

    return { token: `${header}.${payload}.${signature}`, expiresIn: TOKEN_TTL_SECONDS };
  }

  /**
   * Server-side publish proxy — the ONLY way a client may put anything into a
   * Centrifugo channel. Client-side publish must stay disabled in the channel
   * config: an unused capability is still a capability.
   *
   * IT RUNS THE GATEWAY'S OWN CHECKS, NOT COPIES OF THEM. `RoomsAuthService`
   * and `RoomsService` are the same providers the Socket.IO gateway injects, so
   * a ban, a mute or a permission change bites identically on both transports.
   * This endpoint returned 501 until that extraction existed, because a second
   * authorisation path that starts identical and drifts is how the "gateway
   * authorised NOTHING" hole from the 2026-07-31 audit gets reopened.
   *
   * Order matters: broker config, then shape, then membership, then policy,
   * then persistence, then broadcast. Persisting before we know the broker can
   * deliver would append events nobody receives.
   *
   * KNOWN GAPS, stated rather than hidden:
   *  - No push notification. The gateway skips push for anyone holding a live
   *    socket; presence on this path lives in the broker, not in that map, so a
   *    correct check needs a presence query this cannot make until Centrifugo is
   *    actually deployed. Notifying everyone would wake people who are already
   *    reading the message.
   *  - `meta.burn` (view-once destruction) is handled on the socket path only.
   *
   * CORRECTED: an earlier version of this note claimed Express caps the body at
   * 100kb. It does by default, but this app does not — `main.ts` mounts
   * `json({ limit: '8mb' })`, matching the socket's maxHttpBufferSize. Slices
   * are 128KB, so they fit. Phase 4 moves media to presigned object storage
   * anyway (`storage/media.controller.ts`), which takes the bytes off this
   * path entirely.
   */
  @Post('centrifugo/publish')
  @HttpCode(200)
  async publish(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() body: PublishBody,
  ) {
    const apiUrl = process.env.CENTRIFUGO_API_URL;
    const apiKey = process.env.CENTRIFUGO_API_KEY;
    if (!apiUrl || !apiKey) {
      throw new ServiceUnavailableException('centrifugo is not configured on this deployment');
    }

    const roomId = String(body?.roomId ?? '');
    const type = String(body?.type ?? '');
    if (!roomId || roomId.length > 128) throw new BadRequestException('roomId required');
    if (!type) throw new BadRequestException('type required');
    if (!this.rooms.isKnownType(type)) {
      throw new BadRequestException(`unknown action type: ${type}`);
    }
    // Base64 TEXT, never binary — see the framing note in rooms.gateway.ts.
    const payload = body?.payload ?? '';
    if (typeof payload !== 'string') {
      throw new BadRequestException('payload must be base64 text, not binary');
    }
    if (payload.length > MAX_PAYLOAD_CHARS) throw new BadRequestException('payload too large');

    // The socket path learns membership from the join handshake. HTTP has no
    // handshake, so the RoomMember row that join writes IS the check.
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: principal.id } },
    });
    if (!member) throw new ForbiddenException('not a member of this room');

    const refusal = await this.auth.authorizeAction(roomId, principal.id, type, body?.meta);
    if (refusal) throw new ForbiddenException(refusal);

    let seq: number | undefined;
    if (this.rooms.isPersisted(type)) {
      const created = await this.rooms.append(
        roomId,
        type,
        principal.id,
        payload.length ? Buffer.from(payload, 'base64') : Buffer.alloc(0),
        body?.meta,
        typeof body?.meta?.id === 'string' ? body.meta.id : undefined,
      );
      seq = created.id;
    }

    // Same frame shape the gateway emits on 'action', so nothing downstream can
    // tell which transport carried it.
    const frame = { roomId, seq, type, from: principal.id, payload, meta: body?.meta };

    await this.broadcast(roomChannel(roomId), frame, body?.target);
    return { seq };
  }

  /**
   * Hand the frame to Centrifugo's server API.
   *
   * A failure here is reported, never swallowed. The event is already in the
   * log and will replay on the next join, but telling a sender "delivered" when
   * the broker refused is exactly the silent-failure shape that kept a dead
   * socket invisible for a day.
   */
  private async broadcast(channel: string, frame: unknown, target?: string): Promise<void> {
    const apiUrl = String(process.env.CENTRIFUGO_API_URL);
    const apiKey = String(process.env.CENTRIFUGO_API_KEY);
    // A targeted send goes to that user's personal channel rather than the
    // room, mirroring the gateway's per-socket emit for {target}.
    const dest = target ? `${channel}#${target}` : channel;

    let res: Response;
    try {
      res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ channel: dest, data: frame }),
      });
    } catch (err) {
      throw new ServiceUnavailableException(
        `centrifugo unreachable: ${err instanceof Error ? err.message : 'network error'}`,
      );
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(`centrifugo publish failed: HTTP ${res.status}`);
    }
    // Centrifugo answers 200 with {"error":{...}} on a rejected publish, so the
    // status code alone is not proof of delivery.
    const parsed = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (parsed?.error) {
      throw new ServiceUnavailableException(
        `centrifugo publish failed: ${parsed.error.message || 'broker error'}`,
      );
    }
  }
}
