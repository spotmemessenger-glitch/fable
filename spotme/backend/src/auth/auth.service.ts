import { Injectable, UnauthorizedException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION, AGE_REFUSAL_MESSAGE, FREEZE_NOTICE, isAdultYearMonth, isValidBirthYearMonth } from '../policy/age';
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

  /**
   * Wave 1B (D6): the age decision runs FIRST — before any DB query — so an
   * under-18 refusal costs the same work and returns the same 400 SHAPE as any
   * other validation failure (non-enumerable), and no account row ever exists.
   */
  async signup(username: string, email: string, birthYearMonth: string, name?: string) {
    this.assertAdultDeclaration(birthYearMonth);
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
    if (existing) throw new ConflictException('username or email already taken');
    // B5: the response is a safe subset — never the raw row (which now carries
    // the declaration; it also carries credential hashes).
    return this.prisma.user.create({
      data: {
        username,
        email,
        name,
        role: Role.USER,
        birthYearMonth,
        ageVerified: true,
        ageVerifiedAt: new Date(),
        agePolicyVersion: AGE_POLICY_VERSION,
      },
      select: { id: true, username: true, email: true, name: true, ageVerified: true, createdAt: true },
    });
  }

  /**
   * Refuse a missing/invalid/under-18 declaration with the SAME status and
   * body shape the global ValidationPipe produces (statusCode/message[]/error),
   * so the age refusal is not enumerable apart from other 400s. The copy is
   * deliberately clear and non-punitive.
   */
  private assertAdultDeclaration(birthYearMonth: string | undefined): asserts birthYearMonth is string {
    if (!isValidBirthYearMonth(birthYearMonth)) {
      throw new BadRequestException({
        statusCode: 400,
        message: ['birthYearMonth must be a valid year-month (YYYY-MM)'],
        error: 'Bad Request',
      });
    }
    if (!isAdultYearMonth(birthYearMonth)) {
      throw new BadRequestException({
        statusCode: 400,
        message: [AGE_REFUSAL_MESSAGE],
        error: 'Bad Request',
      });
    }
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

    const tokens = await this.issueTokens(user.id, user.role, deviceId);
    // Wave 1B, B2: existing accounts learn on login that the declaration is
    // still owed; nothing about the session itself is withheld.
    return { ...tokens, ageVerificationRequired: !user.ageVerified };
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
      /* 403, NOT 401, and the distinction is load-bearing rather than pedantic.
       * A 401 means "your credentials did not work", which is exactly the case
       * a client SHOULD retry — and this one did, every two seconds, forever,
       * because `guestAuth` throws on any non-OK response and the join loop
       * retries whatever it is handed. The device spun with no explanation.
       *
       * 403 means "we know who you are and the answer is still no". Retrying
       * cannot change it, and `deleted_account` gives the client something
       * stable to branch on that is not a prose message. */
      throw new ForbiddenException({ error: 'deleted_account', message: 'this account has been deleted' });
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
    birthYearMonth?: string,
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
        // Same reasoning as `refresh` above: terminal, so it must not look retryable.
        throw new ForbiddenException({ error: 'deleted_account', message: 'this account has been deleted' });
      }
      const updates: { name?: string; publicKey?: string; username?: string; deletedAt?: Date | null } = {};
      if (name && name !== existing.name) updates.name = name;
      if (publicKey && publicKey !== existing.publicKey) updates.publicKey = publicKey;
      if (username && username !== existing.username) {
        const taken = await this.prisma.user.findUnique({ where: { username } });
        if (!taken) updates.username = username;
      }
      /* RE-CLAIMING A NAME MUST CLEAR THE RELEASE STAMP.
       *
       * `releaseUsername` stamps `deletedAt` AND renames to `released_…`, and
       * `isDeletedAccount` reads the two together: a released name means the row
       * is still alive. Re-claiming an ordinary name above rewrote the username
       * and left `deletedAt` set — so the row became {deletedAt set, ordinary
       * username}, which is the exact shape of a genuinely deleted account. The
       * next refresh returned 403 `deleted_account` and there is no in-app way
       * back.
       *
       * This is not only an attacker's move. It is what our OWN reset flow does
       * when it half-fails: main.js releases the username, then calls
       * wipeDevice() inside a try/catch. In private mode or at quota the wipe
       * throws, the device keeps id + username + claimSecret, re-claims on the
       * next launch — and bricks itself. */
      if (existing.deletedAt && existing.username?.startsWith(RELEASED_PREFIX)) {
        updates.deletedAt = null;
      }
      if (Object.keys(updates).length) {
        await this.prisma.user.update({ where: { id }, data: updates });
      }
      /* Wave 1B (D6), B2: declare-on-login for accounts that predate the gate.
       * FIRST declaration sticks — if the row already holds one, a re-auth
       * payload can never rewrite it (immutability; support path only). An
       * under-18 declaration is RECORDED (so it cannot be retried next launch
       * with a different year) but never verifies; the session still works —
       * existing chat is not taken away (B2) — while every NEW surface stays
       * behind the B3 gate. */
      let ageVerified = existing.ageVerified;
      let accountStatus = existing.accountStatus;
      if (!existing.birthYearMonth && isValidBirthYearMonth(birthYearMonth)) {
        const adult = isAdultYearMonth(birthYearMonth);
        await this.prisma.user.update({
          where: { id },
          data: {
            birthYearMonth,
            agePolicyVersion: AGE_POLICY_VERSION,
            ...(adult
              ? { ageVerified: true, ageVerifiedAt: new Date() }
              : // Wave 1C (D6 addendum): an EXISTING account declaring under-18
                // is FROZEN — explicit status, data retained, support-path only.
                { accountStatus: ACCOUNT_FROZEN_MINOR }),
          },
        });
        ageVerified = adult || ageVerified;
        if (!adult) accountStatus = ACCOUNT_FROZEN_MINOR;
      }
      const tokens = await this.issueTokens(existing.id, existing.role, undefined);
      await this.trackDevice(existing.id, platform, appVersion);
      return {
        ...tokens,
        userId: existing.id,
        username: updates.username || existing.username,
        ageVerificationRequired: !ageVerified,
        // The one surface a frozen account is GUARANTEED: the policy notice.
        ...(accountStatus === ACCOUNT_FROZEN_MINOR ? { accountFrozen: true, notice: FREEZE_NOTICE } : {}),
      };
    }
    /* Wave 1B (D6): a NEW guest identity is an account creation, so the gate
     * runs here exactly as on /signup — server-side, before the uniqueness
     * check, refusal creates no row and shares the validation-failure shape. */
    this.assertAdultDeclaration(birthYearMonth);
    const taken = await this.prisma.user.findUnique({ where: { username } });
    if (taken) throw new ConflictException('username taken');
    const user = await this.prisma.user.create({
      data: {
        id,
        username,
        name,
        claimSecretHash: secretHash,
        publicKey,
        role: Role.USER,
        birthYearMonth,
        ageVerified: true,
        ageVerifiedAt: new Date(),
        agePolicyVersion: AGE_POLICY_VERSION,
      },
    });
    const tokens = await this.issueTokens(user.id, user.role, undefined);
    await this.trackDevice(user.id, platform, appVersion);
    return { ...tokens, userId: user.id, username: user.username, ageVerificationRequired: false };
  }

  /**
   * Fix-the-Foundation F1 — sign back in after local state loss.
   *
   * A guest identity used to live ONLY in device storage: lose the storage
   * (in-app browser, cleared site data) and the account was unreachable
   * forever — the user re-registered under a new name every time. Knowing the
   * claim secret proves the same thing here it proves on re-auth: this caller
   * held the device that claimed the name. The new device ADOPTS the account's
   * id (the id is the account; the device never gets to rename it).
   *
   * NON-ENUMERABLE: unknown username, wrong secret, an account with no secret,
   * and a deleted account all answer the same 401 — a caller learns nothing
   * about which part failed.
   */
  async recoverGuest(username: string, secret: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    const secretMatches = user?.claimSecretHash != null && user.claimSecretHash === hash(secret);
    if (!user || !secretMatches || isDeletedAccount(user)) {
      throw new UnauthorizedException('invalid username or recovery code');
    }
    const tokens = await this.issueTokens(user.id, user.role, undefined);
    return {
      ...tokens,
      userId: user.id,
      username: user.username,
      name: user.name,
      ageVerificationRequired: !user.ageVerified,
      // Same contract as guest re-auth: a frozen account recovers its READ
      // access and is told why everything else is refused (D6 addendum).
      ...(user.accountStatus === ACCOUNT_FROZEN_MINOR ? { accountFrozen: true, notice: FREEZE_NOTICE } : {}),
    };
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
