import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_FROZEN_MINOR } from '../policy/age';
import { GroupPolicy, GroupsService } from '../groups/groups.service';

/**
 * The ONE place that decides whether somebody may join a room or send into it.
 *
 * WHY THIS FILE EXISTS. `policy()` and `refuse()` used to be private methods on
 * RoomsGateway, which meant the only way to authorise a Centrifugo publication
 * was to write a second copy. The 2026-07-31 audit had already found that "the
 * rooms gateway previously authorised NOTHING" — knowing a roomId was the whole
 * access model — and two authorisation paths that start identical and drift is
 * how that hole gets reopened through a new door (ADR-002 §3).
 *
 * The logic below is the gateway's, moved not rewritten. Both transports now
 * call `authorizeJoin` / `authorizeAction`; neither reimplements anything.
 */

/** How long a cached group policy is trusted — also the worst-case delay
 *  before a ban or mute takes effect on an already-connected socket. */
const POLICY_TTL_MS = 5_000;
const POLICY_CACHE_MAX = 10_000;

@Injectable()
export class RoomsAuthService {
  // Group policy is consulted on every send, so it is cached briefly rather
  // than hitting Postgres per keystroke-sized event. The TTL is the blast
  // radius: a ban or mute takes at most this long to bite.
  private policyCache = new Map<string, { policy: GroupPolicy | null; expires: number }>();

  constructor(
    private groups: GroupsService,
    private prisma: PrismaService,
  ) {}

  // Wave 1C (D6 addendum): frozen-status lookups ride the same short-TTL
  // pattern as group policy — the freeze takes at most POLICY_TTL_MS to bite
  // on an already-connected socket.
  private frozenCache = new Map<string, { frozen: boolean; expires: number }>();

  private async isFrozen(userId: string): Promise<boolean> {
    const hit = this.frozenCache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.frozen;
    const row = await this.prisma.user
      .findUnique({ where: { id: userId }, select: { accountStatus: true } })
      .catch(() => null);
    const frozen = row?.accountStatus === ACCOUNT_FROZEN_MINOR;
    this.frozenCache.set(userId, { frozen, expires: Date.now() + POLICY_TTL_MS });
    return frozen;
  }

  /**
   * Null means "not a group" — a DM, where knowing the roomId is still the
   * whole access model. For groups this is the ONLY thing standing between a
   * banned or muted member and the room, because the client cannot be trusted
   * to enforce its own restrictions.
   */
  async policy(roomId: string, userId: string): Promise<GroupPolicy | null> {
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
  refuse(
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

  /** Why this user may not join, or null to admit them. */
  async authorizeJoin(roomId: string, userId: string): Promise<string | null> {
    const policy = await this.policy(roomId, userId);
    return policy?.banned ? 'not a member of this group' : null;
  }

  /**
   * Why this action is refused, or null to allow it.
   *
   * A room with no group policy is a DM, and there the roomId IS the access
   * model — exactly as on the Socket.IO path. Callers that need more than that
   * (the HTTP publish proxy, which has no join handshake to lean on) check
   * membership separately before getting here.
   */
  async authorizeAction(
    roomId: string,
    userId: string,
    type: string,
    meta: Record<string, unknown> | undefined,
  ): Promise<string | null> {
    /* Wave 1C (D6 addendum): a FROZEN account's existing chat is READ-ONLY.
     * Outbound communication types are refused at the same seam that enforces
     * group mutes; read machinery (seen, profile sync, fetch) still works, so
     * the person can read their history and the policy notice. */
    if ((type === 'msg' || type === 'knock') && (await this.isFrozen(userId))) {
      return 'account_frozen';
    }
    const policy = await this.policy(roomId, userId);
    return policy ? this.refuse(policy, type, meta) : null;
  }
}
