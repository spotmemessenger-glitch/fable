import { Test } from '@nestjs/testing';
import { GroupRole, GroupVisibility } from '@prisma/client';
import { GroupsService } from '../src/groups/groups.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';

/**
 * The rules that are expensive to get wrong: who may act on whom, whether a
 * ban actually bars the room, and whether the shared username namespace holds.
 *
 * These run against the dev Postgres in DATABASE_URL and clean up after
 * themselves. Every fixture id is prefixed so a failed run cannot leave rows
 * that look real.
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('GroupsService roles and permissions', () => {
  let groups: GroupsService;
  let prisma: PrismaService;

  const tag = hex(6);
  const uid = (n: string) => `grp_test_${tag}_${n}`;
  const owner = uid('owner');
  const admin = uid('admin');
  const mod = uid('mod');
  const member = uid('member');
  const outsider = uid('outsider');
  const everyone = [owner, admin, mod, member, outsider];

  let groupId: string;
  let roomId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupsService],
    }).compile();
    groups = moduleRef.get(GroupsService);
    prisma = moduleRef.get(PrismaService);

    await prisma.user.createMany({
      data: everyone.map((id, i) => ({ id, username: `u${tag}${i}` })),
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { ownerId: { in: everyone } } });
    await prisma.user.deleteMany({ where: { id: { in: everyone } } });
    await prisma.$disconnect();
  });

  it('makes the creator OWNER and everyone else MEMBER', async () => {
    roomId = hex(32);
    const g = await groups.create(owner, {
      roomId,
      name: 'Test Group',
      memberIds: [admin, mod, member],
    });
    groupId = g.id;
    expect(g.myRole).toBe(GroupRole.OWNER);
    expect(g.members).toHaveLength(4);
    const roles = Object.fromEntries(g.members.map((m) => [m.userId, m.role]));
    expect(roles[owner]).toBe(GroupRole.OWNER);
    expect(roles[admin]).toBe(GroupRole.MEMBER);
    expect(roles[member]).toBe(GroupRole.MEMBER);
  });

  it('refuses a group with fewer than 2 other members', async () => {
    await expect(
      groups.create(owner, { roomId: hex(32), name: 'Too small', memberIds: [member] }),
    ).rejects.toThrow(/at least 2 members/);
  });

  it('refuses members that do not exist', async () => {
    await expect(
      groups.create(owner, {
        roomId: hex(32),
        name: 'Ghosts',
        memberIds: [member, 'grp_test_nobody_at_all'],
      }),
    ).rejects.toThrow(/unknown or deactivated/);
  });

  it('deduplicates members and drops the creator from the member list', async () => {
    const g = await groups.create(owner, {
      roomId: hex(32),
      name: 'Dupes',
      memberIds: [member, member, admin, owner],
    });
    expect(g.members).toHaveLength(3); // owner + member + admin, each once
    expect(g.members.filter((m) => m.userId === member)).toHaveLength(1);
  });

  it('lets only the OWNER promote, and a MEMBER cannot', async () => {
    await expect(groups.setRole(groupId, member, admin, GroupRole.ADMIN)).rejects.toThrow(
      /cannot change roles/,
    );
    const g = await groups.setRole(groupId, owner, admin, GroupRole.ADMIN);
    expect(g.members.find((m) => m.userId === admin)?.role).toBe(GroupRole.ADMIN);
  });

  it('refuses to assign a role at or above the actor’s own', async () => {
    await groups.setGrants(groupId, owner, admin, { canAddAdmin: true });
    // An admin with role-management may create moderators, not fellow admins.
    await expect(groups.setRole(groupId, admin, member, GroupRole.ADMIN)).rejects.toThrow(
      /at or above your own/,
    );
    const g = await groups.setRole(groupId, admin, mod, GroupRole.MODERATOR);
    expect(g.members.find((m) => m.userId === mod)?.role).toBe(GroupRole.MODERATOR);
  });

  it('refuses grants to a plain MEMBER, and strips grants on demotion', async () => {
    await expect(groups.setGrants(groupId, owner, member, { canBan: true })).rejects.toThrow(
      /promote to moderator or admin/,
    );
    await groups.setGrants(groupId, owner, mod, { canMute: true });
    const g = await groups.setRole(groupId, owner, mod, GroupRole.MEMBER);
    const demoted = g.members.find((m) => m.userId === mod);
    expect(demoted?.role).toBe(GroupRole.MEMBER);
    expect(demoted?.grants.canMute).toBe(false);
    await groups.setRole(groupId, owner, mod, GroupRole.MODERATOR);
  });

  it('will not let anyone act on a peer or a superior', async () => {
    // mod is MODERATOR, admin is ADMIN — a moderator must not remove an admin.
    await groups.setGrants(groupId, owner, mod, { canRemove: true });
    await expect(groups.removeMember(groupId, mod, admin)).rejects.toThrow(/at or above your own/);
  });

  it('bans a member, blocks their policy, and bars re-entry', async () => {
    await groups.setGrants(groupId, owner, admin, { canBan: true });
    await groups.setBan(groupId, admin, member, true);

    const policy = await groups.policyFor(roomId, member);
    expect(policy?.banned).toBe(true);
    expect(policy?.canMessage).toBe(false);

    // The room row must be gone, or the ban would not stop delivery.
    const rm = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: member } },
    });
    expect(rm).toBeNull();

    await expect(groups.getOne(groupId, member)).rejects.toThrow(/banned/);
    await expect(groups.addMember(groupId, owner, member)).rejects.toThrow(/banned/);
  });

  it('mutes a member so policy forbids sending but not reading', async () => {
    const g = await groups.addMember(groupId, owner, outsider);
    expect(g.members.find((m) => m.userId === outsider)?.role).toBe(GroupRole.MEMBER);

    await groups.setMute(groupId, owner, outsider, 60);
    const muted = await groups.policyFor(roomId, outsider);
    expect(muted?.muted).toBe(true);
    expect(muted?.canMessage).toBe(false);
    expect(muted?.banned).toBe(false); // still a member, may still read

    await groups.setMute(groupId, owner, outsider, null);
    expect((await groups.policyFor(roomId, outsider))?.canMessage).toBe(true);
  });

  it('honours the members-cannot-message default for MEMBERs only', async () => {
    await groups.update(groupId, owner, { membersCanMessage: false });
    expect((await groups.policyFor(roomId, outsider))?.canMessage).toBe(false);
    // An elevated role bypasses the member default.
    expect((await groups.policyFor(roomId, admin))?.canMessage).toBe(true);
    await groups.update(groupId, owner, { membersCanMessage: true });
  });

  it('shares one username namespace with users', async () => {
    const taken = await prisma.user.findFirst({ where: { id: owner } });
    expect(await groups.usernameAvailable(taken!.username)).toBe(false);

    const free = `g${tag}`;
    expect(await groups.usernameAvailable(free)).toBe(true);
    await groups.update(groupId, owner, {
      visibility: GroupVisibility.PUBLIC,
      username: free,
      secretKey: 'test-key',
    });
    // Now the group holds it, so a user signing up must be refused it too.
    expect(await groups.usernameAvailable(free)).toBe(false);
  });

  it('refuses a public group with no key, since joiners could not get in', async () => {
    await expect(
      groups.create(owner, {
        roomId: hex(32),
        name: 'Keyless',
        memberIds: [admin, mod],
        visibility: GroupVisibility.PUBLIC,
        username: `k${tag}`,
      }),
    ).rejects.toThrow(/secretKey/);
  });

  it('never stores a key for a private group even if one is sent', async () => {
    const g = await groups.create(owner, {
      roomId: hex(32),
      name: 'Private',
      memberIds: [admin, mod],
      visibility: GroupVisibility.PRIVATE,
      secretKey: 'should-be-ignored',
    });
    const row = await prisma.group.findUnique({ where: { id: g.id } });
    expect(row?.secretKey).toBeNull();
  });

  it('blocks an owner from leaving with no admin to inherit', async () => {
    const solo = await groups.create(owner, {
      roomId: hex(32),
      name: 'Solo owner',
      memberIds: [mod, outsider],
    });
    await expect(groups.leave(solo.id, owner)).rejects.toThrow(/transfer ownership/);

    await groups.setRole(solo.id, owner, mod, GroupRole.ADMIN);
    await expect(groups.leave(solo.id, owner)).resolves.toMatchObject({ ok: true });
    const after = await prisma.group.findUnique({ where: { id: solo.id } });
    expect(after?.ownerId).toBe(mod); // the admin inherited it
  });

  it('soft-deletes, hides the group, and releases its username at once', async () => {
    const doomed = await groups.create(owner, {
      roomId: hex(32),
      name: 'Doomed',
      memberIds: [admin, outsider],
      visibility: GroupVisibility.PUBLIC,
      username: `d${tag}`,
      secretKey: 'k',
    });
    await expect(groups.softDelete(doomed.id, admin)).rejects.toThrow(/only the owner/);
    await groups.softDelete(doomed.id, owner);

    expect(await groups.usernameAvailable(`d${tag}`)).toBe(true);
    const mine = await groups.listMine(owner);
    expect(mine.find((g) => g.id === doomed.id)).toBeUndefined();
    await expect(groups.getOne(doomed.id, owner)).rejects.toThrow(/not found/);

    // Still present for 30 days, just invisible.
    const row = await prisma.group.findUnique({ where: { id: doomed.id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('purges only groups past the 30-day window', async () => {
    const recent = await groups.create(owner, {
      roomId: hex(32),
      name: 'Recently deleted',
      memberIds: [admin, outsider],
    });
    await groups.softDelete(recent.id, owner);
    await groups.purgeExpired();
    expect(await prisma.group.findUnique({ where: { id: recent.id } })).not.toBeNull();

    // Backdate past the window and sweep again.
    await prisma.group.update({
      where: { id: recent.id },
      data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    await groups.purgeExpired();
    expect(await prisma.group.findUnique({ where: { id: recent.id } })).toBeNull();
  });
});
