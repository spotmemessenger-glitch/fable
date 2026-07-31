import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../common/enums/role.enum';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL_DAYS = 30;

function randomOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Prefix `releaseUsername` renames a row to when it hands the name back. */
const RELEASED_PREFIX = 'released_';

/**
 * Was this account DELETED, or did it merely give up its @username?
 *
 * `deletedAt` is written by two very different operations. `softDeleteAccount`
 * means the account is gone. `releaseUsername` also stamps it — while renaming
 * the row to `released_<id>_<ts>` and explicitly keeping the user alive so that
 * "conversations referencing the user survive". Treating the second as a
 * deletion locks a live user out of their own account permanently, with no
 * in-app recovery, and the username-change flow can reach it through a race.
 *
 * The rename is the distinguishing mark, so it is what this reads. A dedicated
 * column would be better and needs a migration; this is the version that does
 * not require one, and it fails SAFE — an unrecognised shape stays logged in.
 */
function isDeletedAccount(user: { deletedAt: Date | null; username: string | null }): boolean {
  if (!user.deletedAt) return false;
  return !user.username?.startsWith(RELEASED_PREFIX);
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async signup(username: string, email: string, name?: string) {
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
    if (existing) throw new ConflictException('username or email already taken');
    return this.prisma.user.create({ data: { username, email, name, role: Role.USER } });
  }

  /** Returns the plaintext OTP only so the caller can send it — never persisted in the clear. */
  async requestOtp(email: string): Promise<{ code: string; userId: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('no account for that email');
    const code = randomOtp();
    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        codeHash: hash(code),
        channel: 'email',
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    return { code, userId: user.id };
  }

  async verifyOtp(email: string, code: string, deviceId?: string, platform?: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('invalid code');

    const candidate = await this.prisma.otpCode.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate || candidate.codeHash !== hash(code)) {
      throw new UnauthorizedException('invalid or expired code');
    }
    await this.prisma.otpCode.update({ where: { id: candidate.id }, data: { consumedAt: new Date() } });

    if (deviceId) {
      await this.prisma.device.upsert({
        where: { id: deviceId },
        create: { id: deviceId, userId: user.id, platform: platform || 'web' },
        update: { lastSeenAt: new Date() },
      });
    }

    return this.issueTokens(user.id, user.role, deviceId);
  }

  async refresh(refreshToken: string) {
    const tokenHash = hash(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('refresh token invalid or expired');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });
    /* A DELETED ACCOUNT MUST NOT BE ABLE TO RENEW ITSELF.
     *
     * Without this, `deletedAt` was a label with no teeth: the row dropped out
     * of username search and key lookup, but the session went on refreshing
     * every 15 minutes forever. Discovery made that visible — the nearby list
     * is built from ephemeral `hello` broadcasts by whoever is CONNECTED, not
     * from a query the soft-delete filters — so a deleted test account kept
     * announcing itself as "Active now" to real users indefinitely.
     *
     * The refresh token is revoked on the way out rather than left to expire,
     * so the session cannot be resumed from a copy of it. */
    if (isDeletedAccount(user)) {
      await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('this account has been deleted');
    }
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(user.id, user.role, stored.deviceId ?? undefined);
  }

  private async issueTokens(userId: string, role: string, deviceId?: string) {
    const accessToken = this.jwt.sign(
      { sub: userId, role },
      { secret: process.env.JWT_ACCESS_SECRET || 'dev-only-secret', expiresIn: ACCESS_TTL },
    );
    const refreshToken = crypto.randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hash(refreshToken),
        deviceId,
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
      },
    });
    return { accessToken, refreshToken };
  }

  /**
   * Guest identity: create-or-reauthenticate in one call. The web client has
   * no accounts — its device-generated id + claimed username ARE the identity,
   * and the claim secret's hash proves later calls come from the same device.
   */
  /**
   * Record that a device exists, and that it opened the app for the first time.
   *
   * Guest auth is the one call every client makes on every launch, web or
   * native, so it is the only place that sees all of them. Nothing wrote Device
   * or InstallEvent before this, which is why "how many phones is the app on?"
   * had no answer: 228 sessions had been minted and not one recorded what it
   * came from.
   *
   * Telemetry must never cost someone a login, so every failure here is
   * swallowed — a missing row is a worse metric, not a broken app.
   */
  private async trackDevice(userId: string, platform?: string, appVersion?: string) {
    const plat = platform ?? 'unknown';
    try {
      // One row per (user, platform). A guest identity already lives in a
      // single device's storage, so that pair is effectively the device.
      const existing = await this.prisma.device.findFirst({ where: { userId, platform: plat } });
      if (existing) {
        await this.prisma.device.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date(), appVersion: appVersion ?? existing.appVersion },
        });
        return;
      }
      await this.prisma.device.create({ data: { userId, platform: plat, appVersion } });
      await this.prisma.installEvent.create({
        data: { userId, kind: 'first_open', platform: plat },
      });
    } catch {
      /* metrics are not worth an auth failure */
    }
  }

  async guestAuth(
    id: string,
    username: string,
    name?: string,
    secret?: string,
    publicKey?: string,
    platform?: string,
    appVersion?: string,
  ) {
    const secretHash = secret ? hash(secret) : null;
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (existing) {
      if (existing.claimSecretHash && existing.claimSecretHash !== secretHash) {
        throw new UnauthorizedException('claim secret does not match this identity');
      }
      /* Guest auth is create-or-reauth, so a deleted account would otherwise
       * walk straight back in on the next launch and undo the deletion — the
       * same hole as `refresh` above, through the other door. Refused rather
       * than silently re-created under a new id: this identity is the ONLY
       * source of a v2 room key, and quietly minting a different one is how a
       * device ends up unable to read its own conversations. */
      if (isDeletedAccount(existing)) {
        throw new UnauthorizedException('this account has been deleted');
      }
      const updates: { name?: string; publicKey?: string; username?: string } = {};
      if (name && name !== existing.name) updates.name = name;
      if (publicKey && publicKey !== existing.publicKey) updates.publicKey = publicKey;
      if (username && username !== existing.username) {
        const taken = await this.prisma.user.findUnique({ where: { username } });
        if (!taken) updates.username = username;
      }
      if (Object.keys(updates).length) {
        await this.prisma.user.update({ where: { id }, data: updates });
      }
      const tokens = await this.issueTokens(existing.id, existing.role, undefined);
      await this.trackDevice(existing.id, platform, appVersion);
      return { ...tokens, userId: existing.id, username: updates.username || existing.username };
    }
    const taken = await this.prisma.user.findUnique({ where: { username } });
    if (taken) throw new ConflictException('username taken');
    const user = await this.prisma.user.create({
      data: { id, username, name, claimSecretHash: secretHash, publicKey, role: Role.USER },
    });
    const tokens = await this.issueTokens(user.id, user.role, undefined);
    await this.trackDevice(user.id, platform, appVersion);
    return { ...tokens, userId: user.id, username: user.username };
  }

  async usernameCheck(username: string) {
    // Users and groups share ONE namespace. Checking only User would let a
    // group claim a name a person already holds (and vice versa), so @name
    // would no longer identify one thing.
    const [user, group] = await Promise.all([
      this.prisma.user.findUnique({ where: { username } }),
      this.prisma.group.findFirst({
        where: { username: { equals: username, mode: 'insensitive' }, deletedAt: null },
        select: { id: true },
      }),
    ]);
    return { available: !user && !group };
  }

  /** Prefix search for the inbox @username lookup — public-safe fields only. */
  async usernameSearch(prefix: string) {
    const users = await this.prisma.user.findMany({
      where: { username: { startsWith: prefix }, deletedAt: null },
      select: { username: true, id: true, name: true },
      orderBy: { username: 'asc' },
      take: 8,
    });
    return { results: users };
  }

  /** Release a claimed name (device reset) — gated by the claim secret. */
  async usernameRelease(username: string, secret: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user) return { ok: true };
    if (!user.claimSecretHash || user.claimSecretHash !== hash(secret)) {
      throw new UnauthorizedException('claim secret does not match');
    }
    // Rename rather than delete: conversations referencing the user survive,
    // the name itself returns to the pool.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { username: `released_${user.id.slice(0, 8)}_${Date.now().toString(36)}`, deletedAt: new Date() },
    });
    return { ok: true };
  }

  // ── Employee (staff dashboard) auth — separate account space entirely ──
  async employeeLogin(email: string, password: string) {
    const employee = await this.prisma.employee.findUnique({ where: { email } });
    if (!employee || !employee.active) throw new UnauthorizedException('invalid credentials');
    const ok = await argon2.verify(employee.passwordHash, password);
    if (!ok) throw new UnauthorizedException('invalid credentials');
    await this.prisma.employee.update({ where: { id: employee.id }, data: { lastLoginAt: new Date() } });
    const accessToken = this.jwt.sign(
      { sub: employee.id, role: employee.role },
      { secret: process.env.JWT_ACCESS_SECRET || 'dev-only-secret', expiresIn: ACCESS_TTL },
    );
    return { accessToken, role: employee.role, name: employee.name };
  }
}
