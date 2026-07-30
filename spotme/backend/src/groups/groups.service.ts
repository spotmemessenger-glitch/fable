import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { GroupRole, GroupVisibility, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Groups ride the room transport: a Group row is keyed by the same opaque
 * `roomId` that RoomEvent/RoomMember use, so message fan-out, history replay
 * and read receipts need no group-specific code. This service is the authority
 * layer — it decides who may do what, and never needs to read message content.
 *
 * The client generates roomId and the room secret. For PRIVATE groups the
 * secret is never sent here (it travels in the invite URL fragment). For
 * PUBLIC groups it is stored so a stranger joining by @username can be handed
 * the key — a deliberate, documented narrowing of the E2E guarantee.
 */

/** Strict ranking. An actor may only act on someone strictly below them. */
const RANK: Record<GroupRole, number> = {
  [GroupRole.OWNER]: 3,
  [GroupRole.ADMIN]: 2,
  [GroupRole.MODERATOR]: 1,
  [GroupRole.MEMBER]: 0,
};

/** Grants an Owner can hand to an Admin/Moderator. Also the API's allow-list. */
export const GRANT_FIELDS = [
  'canAddAdmin',
  'canBan',
  'canMute',
  'canRemove',
  'canDeleteMessages',
  'canControlInvites',
] as const;
export type Grant = (typeof GRANT_FIELDS)[number];

const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const ROOM_ID_RE = /^[a-f0-9]{16,128}$/i;
const NAME_MAX = 40;
const MIN_OTHER_MEMBERS = 2;

/** Soft-deleted groups are purged after this long. */
const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_SWEEP_MS = 6 * 60 * 60 * 1000;

const memberInclude = {
  members: {
    where: { leftAt: null },
    include: { user: { select: { id: true, username: true, name: true, avatarUrl: true } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  },
} satisfies Prisma.GroupInclude;

export type GroupPolicy = {
  groupId: string;
  /** Whose policy this is — the gateway compares it against meta.owner. */
  selfId: string;
  visibility: GroupVisibility;
  role: GroupRole;
  banned: boolean;
  muted: boolean;
  canMessage: boolean;
  canMedia: boolean;
  canDeleteOthers: boolean;
};

@Injectable()
export class GroupsService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  /** Daily-ish purge of soft-deleted groups. A setInterval rather than a cron
   *  dependency — one timer, and a missed sweep just runs on the next boot. */
  onModuleInit() {
    void this.purgeExpired().catch(() => undefined);
    const timer = setInterval(() => void this.purgeExpired().catch(() => undefined), PURGE_SWEEP_MS);
    timer.unref?.();
  }

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - PURGE_AFTER_MS);
    const doomed = await this.prisma.group.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: { id: true, roomId: true },
    });
    if (!doomed.length) return 0;
    const roomIds = doomed.map((g) => g.roomId);
    await this.prisma.$transaction([
      // Members cascade with the group; the room's contents do not, and leaving
      // them behind would keep ciphertext for a group nobody can open.
      this.prisma.roomEvent.deleteMany({ where: { roomId: { in: roomIds } } }),
      this.prisma.roomMember.deleteMany({ where: { roomId: { in: roomIds } } }),
      this.prisma.group.deleteMany({ where: { id: { in: doomed.map((g) => g.id) } } }),
    ]);
    return doomed.length;
  }

  // ── creation ──────────────────────────────────────────────────────────

  async create(
    ownerId: string,
    input: {
      roomId: string;
      name: string;
      memberIds: string[];
      avatarUrl?: string;
      visibility?: GroupVisibility;
      username?: string;
      secretKey?: string;
      membersCanAdd?: boolean;
      membersCanMessage?: boolean;
      membersCanMedia?: boolean;
    },
  ) {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('group name is required');
    if (name.length > NAME_MAX) throw new BadRequestException(`name must be ${NAME_MAX} characters or fewer`);
    if (!ROOM_ID_RE.test(input.roomId ?? '')) throw new BadRequestException('invalid roomId');

    // Dedupe, drop the creator (they are always the owner), keep order stable.
    const memberIds = [...new Set(input.memberIds ?? [])].filter((id) => id && id !== ownerId);
    if (memberIds.length < MIN_OTHER_MEMBERS) {
      throw new BadRequestException(`select at least ${MIN_OTHER_MEMBERS} members`);
    }

    // Every selected member must be a real, live account — the spec's
    // "validate all selected members exist before creating the group".
    const found = await this.prisma.user.findMany({
      where: { id: { in: memberIds }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== memberIds.length) {
      const alive = new Set(found.map((u) => u.id));
      throw new BadRequestException(
        `unknown or deactivated user(s): ${memberIds.filter((id) => !alive.has(id)).join(', ')}`,
      );
    }

    const visibility = input.visibility ?? GroupVisibility.PRIVATE;
    let username: string | null = null;
    if (visibility === GroupVisibility.PUBLIC) {
      username = (input.username ?? '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) {
        throw new BadRequestException('public groups need a username: 3-16 chars, a-z 0-9 _');
      }
      if (!(await this.usernameAvailable(username))) {
        throw new BadRequestException('that username is taken');
      }
      if (!input.secretKey) {
        throw new BadRequestException('public groups must supply secretKey so joiners can be let in');
      }
    }

    try {
      const group = await this.prisma.$transaction(async (tx) => {
        const created = await tx.group.create({
          data: {
            roomId: input.roomId,
            name,
            avatarUrl: input.avatarUrl ?? null,
            username,
            visibility,
            // Stored for PUBLIC groups only — a PRIVATE group's key must never
            // reach the server even if a client sends one by mistake.
            secretKey: visibility === GroupVisibility.PUBLIC ? (input.secretKey ?? null) : null,
            ownerId,
            membersCanAdd: input.membersCanAdd ?? true,
            membersCanMessage: input.membersCanMessage ?? true,
            membersCanMedia: input.membersCanMedia ?? true,
            members: {
              create: [
                { userId: ownerId, role: GroupRole.OWNER },
                ...memberIds.map((userId) => ({ userId, role: GroupRole.MEMBER })),
              ],
            },
          },
          include: memberInclude,
        });
        await tx.roomMember.createMany({
          data: [ownerId, ...memberIds].map((userId) => ({ roomId: input.roomId, userId })),
          skipDuplicates: true,
        });
        return created;
      });
      return this.shape(group, ownerId);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: string })?.target ?? '');
        throw new BadRequestException(
          target.includes('username') ? 'that username is taken' : 'that room already has a group',
        );
      }
      throw e;
    }
  }

  /** Free across BOTH namespaces — a group must never shadow a person. */
  async usernameAvailable(username: string): Promise<boolean> {
    const [user, group] = await Promise.all([
      this.prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } }),
      this.prisma.group.findFirst({
        where: { username: { equals: username, mode: 'insensitive' }, deletedAt: null },
      }),
    ]);
    return !user && !group;
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async listMine(userId: string) {
    const groups = await this.prisma.group.findMany({
      where: { deletedAt: null, members: { some: { userId, leftAt: null, bannedAt: null } } },
      include: memberInclude,
      orderBy: { updatedAt: 'desc' },
    });
    return groups.map((g) => this.shape(g, userId));
  }

  async getOne(groupId: string, userId: string) {
    const { group } = await this.requireMember(groupId, userId);
    return this.shape(group, userId);
  }

  /** Public directory lookup. Returns enough to render a join card — never
   *  the key; joinPublic hands that over only once someone actually joins. */
  async findByUsername(username: string) {
    const group = await this.prisma.group.findFirst({
      where: {
        username: { equals: username.toLowerCase(), mode: 'insensitive' },
        visibility: GroupVisibility.PUBLIC,
        deletedAt: null,
      },
      include: memberInclude,
    });
    if (!group) throw new NotFoundException('no public group with that username');
    return {
      id: group.id,
      roomId: group.roomId,
      name: group.name,
      avatarUrl: group.avatarUrl,
      username: group.username,
      memberCount: group.members.length,
    };
  }

  /** Instant join for a PUBLIC group — hands back the server-held room key. */
  async joinPublic(username: string, userId: string) {
    const group = await this.prisma.group.findFirst({
      where: {
        username: { equals: username.toLowerCase(), mode: 'insensitive' },
        visibility: GroupVisibility.PUBLIC,
        deletedAt: null,
      },
    });
    if (!group) throw new NotFoundException('no public group with that username');

    const existing = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    if (existing?.bannedAt) throw new ForbiddenException('you are banned from this group');

    await this.prisma.$transaction([
      this.prisma.groupMember.upsert({
        where: { groupId_userId: { groupId: group.id, userId } },
        create: { groupId: group.id, userId, role: GroupRole.MEMBER },
        // Rejoining clears the tombstone but never restores a former role.
        update: { leftAt: null, role: existing?.role ?? GroupRole.MEMBER },
      }),
      this.prisma.roomMember.upsert({
        where: { roomId_userId: { roomId: group.roomId, userId } },
        create: { roomId: group.roomId, userId },
        update: {},
      }),
    ]);
    const full = await this.prisma.group.findUniqueOrThrow({
      where: { id: group.id },
      include: memberInclude,
    });
    return { ...this.shape(full, userId), secretKey: group.secretKey };
  }

  // ── membership ────────────────────────────────────────────────────────

  async addMember(groupId: string, byUserId: string, newUserId: string) {
    const { group, me } = await this.requireMember(groupId, byUserId);
    const mayInvite =
      me.role === GroupRole.OWNER ||
      me.canControlInvites ||
      (me.role === GroupRole.MEMBER ? group.membersCanAdd : true);
    if (!mayInvite) throw new ForbiddenException('you cannot add members to this group');

    const user = await this.prisma.user.findFirst({
      where: { id: newUserId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new BadRequestException('unknown or deactivated user');

    const existing = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: newUserId } },
    });
    if (existing?.bannedAt) throw new ForbiddenException('that user is banned from this group');
    if (existing && !existing.leftAt) throw new BadRequestException('already a member');

    await this.prisma.$transaction([
      this.prisma.groupMember.upsert({
        where: { groupId_userId: { groupId, userId: newUserId } },
        create: { groupId, userId: newUserId, role: GroupRole.MEMBER },
        update: { leftAt: null, role: GroupRole.MEMBER },
      }),
      this.prisma.roomMember.upsert({
        where: { roomId_userId: { roomId: group.roomId, userId: newUserId } },
        create: { roomId: group.roomId, userId: newUserId },
        update: {},
      }),
      this.prisma.group.update({ where: { id: groupId }, data: { updatedAt: new Date() } }),
    ]);
    return this.getOne(groupId, byUserId);
  }

  async removeMember(groupId: string, byUserId: string, targetId: string) {
    if (byUserId === targetId) return this.leave(groupId, byUserId);
    const { group, me } = await this.requireMember(groupId, byUserId);
    const target = await this.requireTarget(groupId, targetId);
    this.assertOutranks(me, target, 'remove');
    if (me.role !== GroupRole.OWNER && !me.canRemove) {
      throw new ForbiddenException('you do not have permission to remove members');
    }
    await this.detach(group.id, group.roomId, targetId);
    return this.getOne(groupId, byUserId);
  }

  async leave(groupId: string, userId: string) {
    const { group, me } = await this.requireMember(groupId, userId);
    if (me.role === GroupRole.OWNER) {
      // An owner walking out without a successor would orphan the group.
      const heir = await this.prisma.groupMember.findFirst({
        where: { groupId, leftAt: null, bannedAt: null, role: GroupRole.ADMIN },
        orderBy: { joinedAt: 'asc' },
      });
      if (!heir) {
        throw new ForbiddenException(
          'transfer ownership before leaving — no admin is available to take over',
        );
      }
      await this.prisma.$transaction([
        this.prisma.groupMember.update({ where: { id: heir.id }, data: { role: GroupRole.OWNER } }),
        this.prisma.group.update({ where: { id: groupId }, data: { ownerId: heir.userId } }),
      ]);
    }
    await this.detach(group.id, group.roomId, userId);
    return { ok: true, groupId };
  }

  async transferOwnership(groupId: string, byUserId: string, targetId: string) {
    const { me } = await this.requireMember(groupId, byUserId);
    if (me.role !== GroupRole.OWNER) throw new ForbiddenException('only the owner can transfer ownership');
    const target = await this.requireTarget(groupId, targetId);
    if (target.bannedAt) throw new BadRequestException('cannot hand a group to a banned member');
    await this.prisma.$transaction([
      this.prisma.groupMember.update({ where: { id: target.id }, data: { role: GroupRole.OWNER } }),
      // The former owner stays as an Admin rather than being dropped.
      this.prisma.groupMember.update({ where: { id: me.id }, data: { role: GroupRole.ADMIN } }),
      this.prisma.group.update({ where: { id: groupId }, data: { ownerId: targetId } }),
    ]);
    return this.getOne(groupId, byUserId);
  }

  // ── roles & grants ────────────────────────────────────────────────────

  async setRole(groupId: string, byUserId: string, targetId: string, role: GroupRole) {
    if (role === GroupRole.OWNER) {
      throw new BadRequestException('use transfer-ownership to change the owner');
    }
    const { me } = await this.requireMember(groupId, byUserId);
    const target = await this.requireTarget(groupId, targetId);
    if (target.role === GroupRole.OWNER) throw new ForbiddenException("the owner's role cannot be changed");

    if (me.role !== GroupRole.OWNER) {
      // Delegated role management: granted, and never above your own rank.
      if (!me.canAddAdmin) throw new ForbiddenException('you cannot change roles in this group');
      if (RANK[role] >= RANK[me.role]) {
        throw new ForbiddenException('you cannot assign a role at or above your own');
      }
      this.assertOutranks(me, target, 'change the role of');
    }
    await this.prisma.groupMember.update({
      where: { id: target.id },
      // Demotion to MEMBER drops every grant — otherwise a demoted admin keeps
      // ban/mute powers the group settings never intended them to have.
      data: role === GroupRole.MEMBER ? { role, ...this.clearedGrants() } : { role },
    });
    return this.getOne(groupId, byUserId);
  }

  async setGrants(
    groupId: string,
    byUserId: string,
    targetId: string,
    grants: Partial<Record<Grant, boolean>>,
  ) {
    const { me } = await this.requireMember(groupId, byUserId);
    if (me.role !== GroupRole.OWNER) {
      throw new ForbiddenException('only the owner sets per-member permissions');
    }
    const target = await this.requireTarget(groupId, targetId);
    if (target.role === GroupRole.OWNER) throw new BadRequestException('the owner already has every permission');
    if (target.role === GroupRole.MEMBER) {
      throw new BadRequestException('promote to moderator or admin before granting permissions');
    }
    const data: Partial<Record<Grant, boolean>> = {};
    for (const key of GRANT_FIELDS) {
      if (typeof grants[key] === 'boolean') data[key] = grants[key];
    }
    if (!Object.keys(data).length) throw new BadRequestException('no permissions supplied');
    await this.prisma.groupMember.update({ where: { id: target.id }, data });
    return this.getOne(groupId, byUserId);
  }

  // ── moderation ────────────────────────────────────────────────────────

  async setBan(groupId: string, byUserId: string, targetId: string, banned: boolean) {
    const { group, me } = await this.requireMember(groupId, byUserId);
    const target = await this.requireTarget(groupId, targetId);
    this.assertOutranks(me, target, 'ban');
    if (me.role !== GroupRole.OWNER && !me.canBan) {
      throw new ForbiddenException('you do not have permission to ban members');
    }
    await this.prisma.groupMember.update({
      where: { id: target.id },
      data: banned ? { bannedAt: new Date(), leftAt: new Date() } : { bannedAt: null },
    });
    if (banned) {
      // Drop the room row too, or the ban would not stop delivery.
      await this.prisma.roomMember.deleteMany({ where: { roomId: group.roomId, userId: targetId } });
    }
    return this.getOne(groupId, byUserId);
  }

  async setMute(groupId: string, byUserId: string, targetId: string, minutes: number | null) {
    const { me } = await this.requireMember(groupId, byUserId);
    const target = await this.requireTarget(groupId, targetId);
    this.assertOutranks(me, target, 'mute');
    if (me.role !== GroupRole.OWNER && !me.canMute) {
      throw new ForbiddenException('you do not have permission to mute members');
    }
    const mutedUntil =
      minutes == null
        ? null
        : new Date(Date.now() + Math.max(1, Math.min(minutes, 60 * 24 * 365)) * 60_000);
    await this.prisma.groupMember.update({ where: { id: target.id }, data: { mutedUntil } });
    return this.getOne(groupId, byUserId);
  }

  // ── group profile & lifecycle ─────────────────────────────────────────

  async update(
    groupId: string,
    byUserId: string,
    patch: {
      name?: string;
      avatarUrl?: string | null;
      visibility?: GroupVisibility;
      username?: string;
      secretKey?: string;
      membersCanAdd?: boolean;
      membersCanMessage?: boolean;
      membersCanMedia?: boolean;
    },
  ) {
    const { group, me } = await this.requireMember(groupId, byUserId);
    // Admins may edit the profile; only the owner changes visibility/defaults.
    if (RANK[me.role] < RANK[GroupRole.ADMIN]) {
      throw new ForbiddenException('only admins and the owner can edit this group');
    }
    const ownerOnly =
      patch.visibility !== undefined ||
      patch.username !== undefined ||
      patch.membersCanAdd !== undefined ||
      patch.membersCanMessage !== undefined ||
      patch.membersCanMedia !== undefined;
    if (ownerOnly && me.role !== GroupRole.OWNER) {
      throw new ForbiddenException('only the owner can change visibility or member permissions');
    }

    const data: Prisma.GroupUpdateInput = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException('group name is required');
      if (name.length > NAME_MAX) throw new BadRequestException(`name must be ${NAME_MAX} characters or fewer`);
      data.name = name;
    }
    if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl;
    if (patch.membersCanAdd !== undefined) data.membersCanAdd = patch.membersCanAdd;
    if (patch.membersCanMessage !== undefined) data.membersCanMessage = patch.membersCanMessage;
    if (patch.membersCanMedia !== undefined) data.membersCanMedia = patch.membersCanMedia;

    const nextVisibility = patch.visibility ?? group.visibility;
    if (nextVisibility === GroupVisibility.PUBLIC) {
      const username = (patch.username ?? group.username ?? '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) {
        throw new BadRequestException('public groups need a username: 3-16 chars, a-z 0-9 _');
      }
      if (username !== group.username && !(await this.usernameAvailable(username))) {
        throw new BadRequestException('that username is taken');
      }
      const secretKey = patch.secretKey ?? group.secretKey;
      if (!secretKey) throw new BadRequestException('going public requires secretKey so joiners can be let in');
      data.username = username;
      data.visibility = GroupVisibility.PUBLIC;
      data.secretKey = secretKey;
    } else if (patch.visibility === GroupVisibility.PRIVATE) {
      // Going private releases the name and forgets the key we were holding.
      data.visibility = GroupVisibility.PRIVATE;
      data.username = null;
      data.secretKey = null;
    }

    try {
      await this.prisma.group.update({ where: { id: groupId }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('that username is taken');
      }
      throw e;
    }
    return this.getOne(groupId, byUserId);
  }

  /** Soft delete. Hidden at once, purged by the sweep after 30 days. */
  async softDelete(groupId: string, byUserId: string) {
    const { me } = await this.requireMember(groupId, byUserId);
    if (me.role !== GroupRole.OWNER) throw new ForbiddenException('only the owner can delete this group');
    await this.prisma.group.update({
      where: { id: groupId },
      // The name is released immediately — holding it for 30 days would let a
      // deleted group squat a username nobody can see.
      data: { deletedAt: new Date(), username: null, secretKey: null },
    });
    return { ok: true, groupId, purgeAfter: new Date(Date.now() + PURGE_AFTER_MS) };
  }

  // ── gateway enforcement ───────────────────────────────────────────────

  /**
   * What this user may do in this room, or null if the room is not a group
   * (a DM — the gateway keeps its existing know-the-id access model there).
   */
  async policyFor(roomId: string, userId: string): Promise<GroupPolicy | null> {
    const group = await this.prisma.group.findUnique({
      where: { roomId },
      select: {
        id: true,
        deletedAt: true,
        visibility: true,
        membersCanMessage: true,
        membersCanMedia: true,
        members: { where: { userId }, take: 1 },
      },
    });
    if (!group) return null;
    const me = group.members[0];
    const banned = group.deletedAt ? true : !me || !!me.bannedAt || !!me.leftAt;
    const role = me?.role ?? GroupRole.MEMBER;
    const elevated = RANK[role] > RANK[GroupRole.MEMBER];
    const muted = !!me?.mutedUntil && me.mutedUntil.getTime() > Date.now();
    return {
      groupId: group.id,
      selfId: userId,
      visibility: group.visibility,
      role,
      banned,
      muted,
      canMessage: !banned && !muted && (elevated || group.membersCanMessage),
      canMedia: !banned && !muted && (elevated || group.membersCanMedia),
      canDeleteOthers: role === GroupRole.OWNER || !!me?.canDeleteMessages,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────

  private clearedGrants(): Record<Grant, boolean> {
    return Object.fromEntries(GRANT_FIELDS.map((k) => [k, false])) as Record<Grant, boolean>;
  }

  private async detach(groupId: string, roomId: string, userId: string) {
    await this.prisma.$transaction([
      this.prisma.groupMember.updateMany({
        where: { groupId, userId, leftAt: null },
        data: { leftAt: new Date() },
      }),
      this.prisma.roomMember.deleteMany({ where: { roomId, userId } }),
    ]);
  }

  private assertOutranks(me: { role: GroupRole }, target: { role: GroupRole }, verb: string) {
    if (RANK[me.role] <= RANK[target.role]) {
      throw new ForbiddenException(`you cannot ${verb} someone at or above your own role`);
    }
  }

  private async requireTarget(groupId: string, userId: string) {
    const target = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!target || target.leftAt) throw new NotFoundException('that person is not in this group');
    return target;
  }

  /** Throws unless the caller is a live, unbanned member of a live group. */
  private async requireMember(groupId: string, userId: string) {
    const group = await this.prisma.group.findFirst({
      where: { id: groupId, deletedAt: null },
      include: memberInclude,
    });
    if (!group) throw new NotFoundException('group not found');
    const me = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    // Ban is checked FIRST: setBan also stamps leftAt, so testing leftAt first
    // would tell a banned person they simply are not a member — and would hide
    // the ban from every caller that distinguishes the two.
    if (me?.bannedAt) throw new ForbiddenException('you are banned from this group');
    if (!me || me.leftAt) throw new ForbiddenException('not a member of this group');
    return { group, me };
  }

  /** Wire shape. secretKey is never included — joinPublic adds it explicitly. */
  private shape(group: Prisma.GroupGetPayload<{ include: typeof memberInclude }>, viewerId: string) {
    const me = group.members.find((m) => m.userId === viewerId);
    return {
      id: group.id,
      roomId: group.roomId,
      name: group.name,
      avatarUrl: group.avatarUrl,
      username: group.username,
      visibility: group.visibility,
      ownerId: group.ownerId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      permissions: {
        membersCanAdd: group.membersCanAdd,
        membersCanMessage: group.membersCanMessage,
        membersCanMedia: group.membersCanMedia,
      },
      myRole: me?.role ?? null,
      myGrants: me ? Object.fromEntries(GRANT_FIELDS.map((k) => [k, me[k]])) : null,
      members: group.members.map((m) => ({
        userId: m.userId,
        username: m.user.username,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        mutedUntil: m.mutedUntil,
        bannedAt: m.bannedAt,
        joinedAt: m.joinedAt,
        grants: Object.fromEntries(GRANT_FIELDS.map((k) => [k, m[k]])),
      })),
    };
  }
}
