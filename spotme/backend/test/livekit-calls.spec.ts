import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { CallsController } from '../src/calls/calls.controller';
import { LiveKitService } from '../src/calls/livekit.service';

/**
 * The call-token contract, pinned. ADR-003.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. A LiveKit token is a bearer credential
 * for a media room, so the failure modes worth a test are the ones that hand
 * one to the wrong person or for the wrong room — not "does it return a
 * string". Each test below corresponds to a way this could leak:
 *
 *   - identity taken from the body  -> join a call as someone else
 *   - room name taken from the body -> membership checked on room A, token
 *                                      issued for room B
 *   - no membership check           -> join any conversation's call
 *   - long or absent expiry         -> a scraped token stays usable
 *   - a wider grant than needed     -> a participant evicts the other party
 *
 * The claim SHAPE is asserted literally (`iss`, `sub`, `video.roomJoin`, …)
 * because the token is hand-minted rather than produced by livekit-server-sdk.
 * That trade is only defensible if a drift in what LiveKit expects fails here
 * instead of failing a real call, where it would look like a network fault.
 *
 * No database and no network: Prisma is stubbed to a single membership answer,
 * and nothing in these paths calls out except `endRoom`, which is not exercised
 * here. What is under test is the decision logic and the claims.
 */

const SYNTHETIC_ENV = {
  LIVEKIT_URL: 'wss://livekit.example.invalid',
  LIVEKIT_API_KEY: 'synthetic-api-key',
  LIVEKIT_API_SECRET: 'synthetic-api-secret-not-a-real-credential',
};

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));

/** Prisma stubbed down to the one question this controller asks. */
const prismaWith = (isMember: boolean) =>
  ({
    roomMember: { findUnique: async () => (isMember ? { roomId: 'r1', userId: 'u1' } : null) },
  }) as any;

const principal = { id: 'u1' } as any;

describe('LiveKit call tokens', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [k, v] of Object.entries(SYNTHETIC_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const k of Object.keys(SYNTHETIC_ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('mints a token whose identity is the authenticated principal, not the body', async () => {
    const controller = new CallsController(prismaWith(true), new LiveKitService());

    // The body carries an identity claim it must not be able to influence.
    const res = await controller.token(principal, {
      roomId: 'r1',
      identity: 'someone-else',
    } as any);

    expect(decode(res.token).sub).toBe('u1');
  });

  it('derives the LiveKit room name and ignores any room name in the body', async () => {
    const controller = new CallsController(prismaWith(true), new LiveKitService());

    const res = await controller.token(principal, {
      roomId: 'r1',
      roomName: 'someone-elses-room',
    } as any);

    expect(res.roomName).toBe('spotme-call-r1');
    expect(decode(res.token).video.room).toBe('spotme-call-r1');
  });

  it('refuses a caller who is not a member of the room', async () => {
    const controller = new CallsController(prismaWith(false), new LiveKitService());

    await expect(controller.token(principal, { roomId: 'r1' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('scopes the grant to one room: join, publish, subscribe — no admin, no data', () => {
    const claims = decode(
      new LiveKitService().mintToken({ identity: 'u1', roomName: 'spotme-call-r1' }).token,
    );

    expect(claims.video).toEqual({
      room: 'spotme-call-r1',
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    // Absent, not merely false — a participant must not be able to evict the
    // person they are calling, nor enumerate the project's other rooms.
    expect(claims.video.roomAdmin).toBeUndefined();
    expect(claims.video.roomCreate).toBeUndefined();
    expect(claims.video.roomList).toBeUndefined();
  });

  it('is short-lived and signed with the configured key', () => {
    const { token, expiresIn } = new LiveKitService().mintToken({
      identity: 'u1',
      roomName: 'spotme-call-r1',
    });
    const claims = decode(token);

    expect(expiresIn).toBe(LiveKitService.TOKEN_TTL_SECONDS);
    expect(claims.exp - claims.iat).toBe(LiveKitService.TOKEN_TTL_SECONDS);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);
    // `iss` is how the SFU picks the secret to verify against; a wrong or
    // missing one fails every connection with an opaque error.
    expect(claims.iss).toBe(SYNTHETIC_ENV.LIVEKIT_API_KEY);
    expect(claims.nbf).toBeLessThanOrEqual(claims.iat);
    expect(token.split('.')).toHaveLength(3);
  });

  it('says "not configured" rather than 500ing when LIVEKIT_* is unset', async () => {
    delete process.env.LIVEKIT_API_SECRET;
    const controller = new CallsController(prismaWith(true), new LiveKitService());

    await expect(controller.token(principal, { roomId: 'r1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(controller.config().available).toBe(false);
  });

  it('will not end a call in a room the caller does not belong to', async () => {
    const controller = new CallsController(prismaWith(false), new LiveKitService());

    await expect(controller.end(principal, { roomId: 'r1' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
