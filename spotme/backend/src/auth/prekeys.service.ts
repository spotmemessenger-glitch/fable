import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * X3DH prekey distribution (ADR-004 §8, e2e_v3).
 *
 * WHAT THE SERVER DOES AND DOES NOT KNOW. It stores and serves PUBLIC prekeys.
 * It never sees a private half, never a shared secret, never a session — X3DH
 * runs entirely on the two clients. The one integrity property the server owes
 * is the atomicity of one-time-prekey consumption: it must hand each OPK to at
 * most one fetcher, or the "one-time" in the name is a lie and the first
 * message's forward secrecy silently weakens.
 *
 * The signed prekey signature is NOT verified here. It is Ed25519 over
 * (IK || SPK), and the key that verifies it is the peer's PUBLISHED SIGNING
 * KEY — which the FETCHER holds and the FETCHER checks, because the server is
 * the adversary in this model and a server that vouched for signatures would
 * be trusted to vouch for substituted ones. The server carries `sig` opaquely.
 */

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/; // 16 bytes, hex
const X25519_RAW = 32;
const ED25519_SIG = 64;

/** Reject an over-large OPK batch before it touches the DB — a bundle upload is
 *  attacker-shaped, and "publish ten thousand prekeys" is a storage-exhaustion
 *  probe, not a legitimate refill. */
const MAX_OPKS_PER_UPLOAD = 200;

function rawLen(b64: string): number {
  return Buffer.from(b64, 'base64').length;
}

type SpkInput = { keyId?: number; pub?: string; sig?: string };
type OpkInput = { keyId?: number; pub?: string };
type PublishInput = { deviceId?: string; spk?: SpkInput; opks?: OpkInput[] };

@Injectable()
export class PreKeysService {
  constructor(private prisma: PrismaService) {}

  /**
   * Publish (or refill) MY device's prekeys. Keyed off the JWT principal; the
   * deviceId is which of my devices, not whose keys — a body userId would let
   * one account poison another's bundle.
   *
   * The SPK is replace-on-publish (one active per device); OPKs accumulate up
   * to the batch cap so a client can top the pool back up as it drains.
   */
  async publish(userId: string, body: PublishInput) {
    const deviceId = String(body?.deviceId ?? '').trim();
    if (!DEVICE_ID.test(deviceId)) {
      throw new BadRequestException('deviceId must be 16 bytes hex');
    }
    const spk = body?.spk;
    const spkKeyId = spk?.keyId;
    if (!spk || typeof spkKeyId !== 'number' || spkKeyId < 0) {
      throw new BadRequestException('spk.keyId must be a non-negative integer');
    }
    const spkPub = String(spk.pub ?? '').trim();
    const spkSig = String(spk.sig ?? '').trim();
    if (!B64.test(spkPub) || rawLen(spkPub) !== X25519_RAW) {
      throw new BadRequestException('spk.pub must be a raw X25519 key (32 bytes) base64');
    }
    if (!B64.test(spkSig) || rawLen(spkSig) !== ED25519_SIG) {
      throw new BadRequestException('spk.sig must be a 64-byte Ed25519 signature base64');
    }

    const rawOpks = Array.isArray(body?.opks) ? body.opks : [];
    if (rawOpks.length > MAX_OPKS_PER_UPLOAD) {
      throw new BadRequestException(`at most ${MAX_OPKS_PER_UPLOAD} one-time prekeys per upload`);
    }
    const opks: { keyId: number; pub: string }[] = rawOpks.map((opk) => {
      const keyId = opk?.keyId;
      if (typeof keyId !== 'number' || keyId < 0) {
        throw new BadRequestException('every opk.keyId must be a non-negative integer');
      }
      const pub = String(opk?.pub ?? '').trim();
      if (!B64.test(pub) || rawLen(pub) !== X25519_RAW) {
        throw new BadRequestException('every opk.pub must be a raw X25519 key (32 bytes) base64');
      }
      return { keyId, pub };
    });

    await this.prisma.$transaction(async (tx) => {
      // Replace the device's signed prekey: retire any different-id active one,
      // upsert this one. Retire (not delete) so an in-flight initial message
      // naming the old SPKID can still resolve for its short window.
      await tx.signedPreKey.updateMany({
        where: { userId, deviceId, retiredAt: null, keyId: { not: spkKeyId } },
        data: { retiredAt: new Date() },
      });
      await tx.signedPreKey.upsert({
        where: { userId_deviceId_keyId: { userId, deviceId, keyId: spkKeyId } },
        create: { userId, deviceId, keyId: spkKeyId, pub: spkPub, sig: spkSig },
        update: { pub: spkPub, sig: spkSig, retiredAt: null },
      });
      for (const opk of opks) {
        await tx.oneTimePreKey.upsert({
          where: { userId_deviceId_keyId: { userId, deviceId, keyId: opk.keyId } },
          create: { userId, deviceId, keyId: opk.keyId, pub: opk.pub },
          update: { pub: opk.pub },
        });
      }
    });

    const remaining = await this.prisma.oneTimePreKey.count({ where: { userId, deviceId } });
    return { ok: true, opksStored: remaining };
  }

  /**
   * How many one-time prekeys MY device has left — so a client knows when to
   * refill before the pool drains and its peers fall back to no-OPK sessions.
   */
  async count(userId: string, deviceId: string) {
    if (!DEVICE_ID.test(deviceId)) {
      throw new BadRequestException('deviceId must be 16 bytes hex');
    }
    const opks = await this.prisma.oneTimePreKey.count({ where: { userId, deviceId } });
    const spk = await this.prisma.signedPreKey.findFirst({
      where: { userId, deviceId, retiredAt: null },
    });
    return { opks, hasSignedPreKey: Boolean(spk) };
  }

  /**
   * Fetch a peer's bundle and ATOMICALLY consume one OPK.
   *
   * The consumption is the whole point of doing this in a transaction: the OPK
   * row is deleted in the SAME transaction that reads it, so two concurrent
   * fetchers cannot both receive the same OPKID. When the pool is empty the
   * bundle is served with `opk: null` — the caller puts OPKID = 0xFFFFFFFF on
   * the wire, a weaker-but-functional session, and the absence is visible
   * rather than a silent downgrade.
   *
   * `sig` is returned verbatim for the fetcher to verify against the peer's
   * signing key. The server does not and must not vouch for it.
   */
  async fetchBundle(peerUserId: string, deviceId: string) {
    if (!DEVICE_ID.test(deviceId)) {
      throw new BadRequestException('deviceId must be 16 bytes hex');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: peerUserId, deletedAt: null },
      select: { id: true, publicKey: true },
    });
    if (!user) throw new NotFoundException('no such user');
    if (!user.publicKey) {
      throw new NotFoundException('that user has not published an agreement identity key');
    }

    const spk = await this.prisma.signedPreKey.findFirst({
      where: { userId: peerUserId, deviceId, retiredAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!spk) {
      throw new NotFoundException('that device has no signed prekey — no v3 bundle available');
    }

    // Consume one OPK atomically: SELECT ... then DELETE by primary key inside
    // one transaction. If two fetchers race, at most one delete of a given row
    // succeeds; the loser simply gets a different OPK or none.
    const opk = await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.oneTimePreKey.findFirst({
        where: { userId: peerUserId, deviceId },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;
      const deleted = await tx.oneTimePreKey.deleteMany({ where: { id: candidate.id } });
      // deleteMany returns count 0 if another transaction already took it —
      // treat that as "no OPK this time" rather than serving a consumed key.
      return deleted.count === 1 ? candidate : null;
    });

    return {
      userId: user.id,
      deviceId,
      ik: user.publicKey, // the X25519 agreement identity (raw, base64)
      spk: { keyId: spk.keyId, pub: spk.pub, sig: spk.sig },
      opk: opk ? { keyId: opk.keyId, pub: opk.pub } : null,
    };
  }
}
