import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  RAW_LEN,
  SUPERSEDE_DOMAIN,
  transcript,
  verifySupersession,
} from './signing-transcript';

/**
 * The published signing-key lifecycle (ADR-008 Phase 2B).
 *
 * THE RULES, and each one's reason:
 *
 *  - At most one ACTIVE row per user, and rows are NEVER deleted. A withdrawn
 *    key is a served tombstone: a key that silently disappears is
 *    indistinguishable from one that never existed, which is exactly the
 *    posture a substituting server would want to manufacture.
 *  - Replacement exists ONLY as supersession. Publishing a different key while
 *    one is active is a 409 — a silent server-side swap is the substitution
 *    attack, so the only path to a new key runs through a statement SIGNED BY
 *    THE OLD ONE.
 *  - A retired key never returns. Re-activating a withdrawn or superseded key
 *    would roll back a rollback — whoever holds the retired private key gets
 *    a second life for it.
 *  - Withdrawal is NOT revocation. It is the owner rolling a deployment back;
 *    peers drop the anchor and return to the pre-A7 posture. Revocation (a
 *    compromise claim, with trust-machine consequences) is ADR-006/A6 scope
 *    and deliberately does not exist here.
 */

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Chain rows served to peers are capped so a hostile account cannot grow an
 *  unbounded response one rotation at a time. Ten covers any legitimate
 *  history; a longer one is a probe. */
const CHAIN_CAP = 10;

type PublishBody = { publicKeyB64?: string; algo?: string };
type SupersedeBody = PublishBody & { supersessionSigB64?: string };

/**
 * Validate a submitted public key AND return it in CANONICAL base64.
 *
 * base64's final quantum leaves unused low bits that the decoder ignores, so
 * ~4 distinct strings decode to identical bytes. Retirement, idempotency and
 * the [userId, publicKeyB64] unique constraint all compare the STRING, so a
 * re-encoded sibling of a retired key would otherwise slip past "a retired key
 * never returns". Re-encoding the decoded bytes (`raw.toString('base64')`)
 * collapses every sibling to one canonical form, which becomes the stored value
 * and the basis of every comparison downstream. Exported so the canonicalization
 * can be unit-tested without a database.
 */
export function validKey(body: PublishBody): { publicKeyB64: string; algo: string } {
  const publicKeyB64 = String(body?.publicKeyB64 ?? '').trim();
  const algo = String(body?.algo ?? '').trim();
  if (!RAW_LEN[algo]) {
    throw new BadRequestException(`algo must be one of: ${Object.keys(RAW_LEN).join(', ')}`);
  }
  if (!publicKeyB64 || !B64.test(publicKeyB64)) {
    throw new BadRequestException('publicKeyB64 must be base64');
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(publicKeyB64, 'base64');
  } catch {
    throw new BadRequestException('publicKeyB64 is not decodable base64');
  }
  if (raw.length !== RAW_LEN[algo]) {
    throw new BadRequestException(
      `a raw ${algo} public key is ${RAW_LEN[algo]} bytes, got ${raw.length}`,
    );
  }
  // Canonical form: the final quantum's unused low bits zeroed. See doc comment.
  return { publicKeyB64: raw.toString('base64'), algo };
}

@Injectable()
export class SigningKeysService {
  constructor(private prisma: PrismaService) {}

  async publish(userId: string, body: PublishBody) {
    const { publicKeyB64, algo } = validKey(body);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize this user's whole key lifecycle. Without it, two concurrent
        // PUTs of DIFFERENT keys both read "no active" under READ COMMITTED and
        // both create, leaving two active rows. The lock is transaction-scoped
        // and auto-releases on commit/rollback; `${userId}` is a Prisma
        // parameter bind, never string-concatenated into the SQL.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
        const active = await tx.signingKey.findFirst({ where: { userId, status: 'active' } });
        if (active) {
          if (active.publicKeyB64 === publicKeyB64) {
            return { ok: true, status: 'active', idempotent: true };
          }
          throw new ConflictException(
            'a different signing key is active — replacement only exists as supersession',
          );
        }
        const retired = await tx.signingKey.findUnique({
          where: { userId_publicKeyB64: { userId, publicKeyB64 } },
        });
        if (retired) {
          throw new ConflictException(
            `that key was retired (${retired.status}) and may not return — a rollback is not undone by republishing`,
          );
        }
        await tx.signingKey.create({
          data: { userId, publicKeyB64, algo, status: 'active' },
        });
        return { ok: true, status: 'active' };
      });
    } catch (e) {
      // A concurrent FIRST-publish of the same key can still lose the create
      // race on the [userId, publicKeyB64] unique constraint (defence in depth
      // behind the lock). PUT is idempotent, so a row for this exact key now
      // existing is success, not a 500: re-read and answer as the idempotent
      // path. A RETIRED sibling row still may not return.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.signingKey.findUnique({
          where: { userId_publicKeyB64: { userId, publicKeyB64 } },
        });
        if (existing?.status === 'active') {
          return { ok: true, status: 'active', idempotent: true };
        }
        if (existing) {
          throw new ConflictException(
            `that key was retired (${existing.status}) and may not return — a rollback is not undone by republishing`,
          );
        }
      }
      throw e;
    }
  }

  async supersede(userId: string, body: SupersedeBody) {
    const { publicKeyB64, algo } = validKey(body);
    const sigB64 = String(body?.supersessionSigB64 ?? '').trim();
    if (!sigB64 || !B64.test(sigB64)) {
      throw new BadRequestException('supersessionSigB64 must be base64');
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialize this user's lifecycle writes and read the active row INSIDE
      // the write transaction. Reading it outside (as this method used to) let
      // a withdraw commit in the read-to-write gap, whereupon the update below
      // silently revived the withdrawn row as 'superseded' and published a
      // fresh active key — reverting a committed rollback. The lock is
      // transaction-scoped; `${userId}` is a Prisma parameter bind.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

      const active = await tx.signingKey.findFirst({
        where: { userId, status: 'active' },
      });
      if (!active) {
        throw new NotFoundException('no active signing key to supersede');
      }
      if (active.publicKeyB64 === publicKeyB64) {
        throw new BadRequestException('the replacement must be a different key');
      }

      /* The statement that authorises the swap: the OLD key signs
       * (domain, userId, oldPublicKeyB64, newPublicKeyB64, newAlgo). The new
       * key's ALGO is bound in because raw lengths collide across protocols
       * (Ed25519 and X25519 are both 32 bytes) — the same two-defence rule the
       * signing module applies to every transcript it signs. Verified BEFORE
       * the chain is touched; a bad signature changes nothing. */
      const bytes = transcript(SUPERSEDE_DOMAIN, [
        userId,
        active.publicKeyB64,
        publicKeyB64,
        algo,
      ]);
      const okSig = await verifySupersession(active.publicKeyB64, active.algo, bytes, sigB64);
      if (!okSig) {
        throw new BadRequestException(
          'supersession signature does not verify against the active key — the chain is unchanged',
        );
      }

      const retired = await tx.signingKey.findUnique({
        where: { userId_publicKeyB64: { userId, publicKeyB64 } },
      });
      if (retired) {
        throw new ConflictException(`that key was retired (${retired.status}) and may not return`);
      }
      const next = await tx.signingKey.create({
        data: { userId, publicKeyB64, algo, status: 'active' },
      });
      await tx.signingKey.update({
        where: { id: active.id },
        data: { status: 'superseded', supersededById: next.id, supersessionSigB64: sigB64 },
      });
      return {
        ok: true,
        status: 'active',
        previousPublicKeyB64: active.publicKeyB64,
      };
    });
  }

  /**
   * Withdraw — the executable rollback ADR-008 §12 demanded. Idempotent on
   * retry (a rollback tool that fails on its second attempt because its first
   * one worked is how rollbacks get abandoned mid-incident), but honest about
   * "there was never anything to withdraw".
   */
  async withdraw(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize this user's lifecycle writes so a withdraw cannot interleave
      // with a racing publish/supersede on the same user. Transaction-scoped
      // lock; `${userId}` is a Prisma parameter bind.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const active = await tx.signingKey.findFirst({ where: { userId, status: 'active' } });
      if (active) {
        await tx.signingKey.update({
          where: { id: active.id },
          data: { status: 'withdrawn', withdrawnAt: new Date() },
        });
        return { ok: true, status: 'withdrawn', publicKeyB64: active.publicKeyB64 };
      }
      const any = await tx.signingKey.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (any?.status === 'withdrawn') {
        return { ok: true, status: 'withdrawn', publicKeyB64: any.publicKeyB64, idempotent: true };
      }
      throw new NotFoundException('no active signing key to withdraw');
    });
  }

  /**
   * What peers see. `none` and a tombstone are DIFFERENT answers on purpose:
   * "never published" and "published then rolled back" must not be
   * conflatable, or a substituting server could erase history by serving the
   * one as the other.
   */
  async fetch(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('no such user');

    const rows = await this.prisma.signingKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: CHAIN_CAP,
    });
    if (!rows.length) return { userId, status: 'none' };

    const current = rows.find((r) => r.status === 'active') ?? rows[0];
    return {
      userId,
      status: current.status,
      publicKeyB64: current.publicKeyB64,
      algo: current.algo,
      createdAt: current.createdAt,
      chain: rows.map((r) => ({
        publicKeyB64: r.publicKeyB64,
        algo: r.algo,
        status: r.status,
        createdAt: r.createdAt,
        supersededById: r.supersededById,
        supersessionSigB64: r.supersessionSigB64,
      })),
    };
  }
}
