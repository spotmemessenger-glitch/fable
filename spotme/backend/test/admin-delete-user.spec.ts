import { Test } from '@nestjs/testing';
import { UnauthorizedException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { AdminService } from '../src/admin/admin.service';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { Role } from '../src/common/enums/role.enum';

/**
 * Deleting a user has to actually remove them, not just label them.
 *
 * WHY THIS ROUTE EXISTS. `DELETE /api/users/me` is self-service — it acts on
 * the JWT's subject — so removing an account needs a token AS that account, and
 * `claimSecretHash` is set only at creation. Two probe accounts created on
 * throwaway sessions were unreachable by every route the server had: their
 * claim secrets died with the devices, and `AdminController` had no
 * user-deletion route at all.
 *
 * THE HALF-FIX THIS GUARDS AGAINST, which is the real content of this file.
 * Adding the route alone would have been decorative. `deletedAt` dropped a row
 * out of username search and key lookup, but NOTHING checked it at auth time:
 * `refresh` fetched the user with `findUniqueOrThrow` and no filter, and
 * `guestAuth` is create-or-reauth, so a deleted account could renew itself
 * every 15 minutes or simply walk back in on the next launch.
 *
 * That mattered because of how Discovery works. The nearby list is not a query
 * the soft-delete filters — it is built from ephemeral `hello` broadcasts by
 * whoever is CONNECTED. So a "deleted" account with a live session went on
 * announcing itself to real users as a live neighbour, forever. Deleting it
 * changed what the admin dashboard counted and nothing a user could see.
 *
 * Runs against the dev Postgres in DATABASE_URL and cleans up after itself.
 */
jest.setTimeout(60_000);

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('admin user deletion — and the auth teeth that make it real', () => {
  let admin: AdminService;
  let auth: AuthService;
  let prisma: PrismaService;

  const ghostId = hex(16);
  const ghostName = `ghost_${hex(4)}`;
  const staffId = hex(16);
  const staffName = `staff_${hex(4)}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, JwtModule.register({ secret: 'test-secret' })],
      providers: [AdminService, UsersService, AuthService],
    }).compile();
    admin = moduleRef.get(AdminService);
    auth = moduleRef.get(AuthService);
    prisma = moduleRef.get(PrismaService);

    await prisma.user.create({
      data: { id: ghostId, username: ghostName, name: 'Ghost', role: Role.USER },
    });
    await prisma.user.create({
      data: { id: staffId, username: staffName, name: 'Staff', role: Role.ADMIN },
    });
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId: { in: [ghostId, staffId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ghostId, staffId] } } });
  });

  it('deletes an ordinary user and stamps deletedAt', async () => {
    const result = await admin.softDeleteUser(ghostId);
    expect(result.alreadyDeleted).toBe(false);
    expect(result.deletedAt).toBeTruthy();
    const row = await prisma.user.findUnique({ where: { id: ghostId } });
    expect(row?.deletedAt).toBeTruthy();
  });

  it('is idempotent — deleting twice reports it rather than re-stamping', async () => {
    const first = await prisma.user.findUnique({ where: { id: ghostId } });
    const again = await admin.softDeleteUser(ghostId);
    expect(again.alreadyDeleted).toBe(true);
    // The original timestamp survives: a second call must not extend the grace
    // period the hard-delete job measures from.
    expect(again.deletedAt?.getTime()).toBe(first?.deletedAt?.getTime());
  });

  it('404s on an id that does not exist', async () => {
    await expect(admin.softDeleteUser(`missing_${hex(8)}`)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to delete an elevated account through the ghost-cleanup path', async () => {
    await expect(admin.softDeleteUser(staffId)).rejects.toBeInstanceOf(ForbiddenException);
    const row = await prisma.user.findUnique({ where: { id: staffId } });
    expect(row?.deletedAt).toBeNull();
  });

  /* ---- the teeth: without these, deletion is a label and nothing more ---- */

  it('THE TEETH: a deleted account cannot refresh its session', async () => {
    // Issue a real refresh token, then delete underneath it — exactly the shape
    // of a ghost with a tab already open.
    const token = hex(48);
    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.refreshToken.create({
      data: {
        userId: ghostId,
        tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await expect(auth.refresh(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('…and that refresh token is revoked, so a copy of it cannot be replayed', async () => {
    const rows = await prisma.refreshToken.findMany({ where: { userId: ghostId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('THE OTHER DOOR: a deleted account cannot walk back in through guest auth', async () => {
    // guestAuth is create-or-reauth; without the check it would hand back
    // tokens and silently undo the deletion on the next app launch.
    await expect(
      auth.guestAuth(ghostId, ghostName, 'Ghost', `anon_${ghostId}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * `deletedAt` is written by TWO different operations, and only one of them
   * means the account is gone. `releaseUsername` stamps it while renaming the
   * row to `released_<id>_<ts>` and deliberately keeping the user alive so
   * "conversations referencing the user survive". Reading it as a deletion
   * locks a live user out of their own account permanently, with no in-app
   * recovery — and the username-change flow can reach that state through a
   * race. Caught in review of the first cut of this work.
   */
  it('a RELEASED username is not a deleted account — that user still gets in', async () => {
    const releasedId = hex(16);
    try {
      await prisma.user.create({
        data: { id: releasedId, username: `released_${releasedId.slice(0, 8)}_x`, name: 'Renamed', role: Role.USER, deletedAt: new Date() },
      });
      const out = await auth.guestAuth(releasedId, `reclaim_${hex(3)}`, 'Renamed', `anon_${releasedId}`);
      expect(out.userId).toBe(releasedId);
      expect(out.accessToken).toBeTruthy();
    } finally {
      await prisma.refreshToken.deleteMany({ where: { userId: releasedId } });
      await prisma.user.deleteMany({ where: { id: releasedId } });
    }
  });

  it('a LIVE account still authenticates normally — the check is not a blanket refusal', async () => {
    const liveId = hex(16);
    const liveName = `live_${hex(4)}`;
    try {
      const out = await auth.guestAuth(liveId, liveName, 'Live', `anon_${liveId}`);
      expect(out.userId).toBe(liveId);
      expect(out.accessToken).toBeTruthy();
    } finally {
      await prisma.refreshToken.deleteMany({ where: { userId: liveId } });
      await prisma.user.deleteMany({ where: { id: liveId } });
    }
  });
});
