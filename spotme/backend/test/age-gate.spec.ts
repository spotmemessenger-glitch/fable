/**
 * Wave 1B — the 18+ gate (owner decision D6), against REAL Postgres.
 *
 * B1: server-side refusal at account creation — no row, validation-failure
 *     shape, immutable declaration.
 * B2: existing accounts — declare-on-login, one-time declaration endpoint,
 *     chat-session tokens still issued.
 * B3: Discovery's DOOR verifies 18+ even with the domain flag ON (flag flipped
 *     in THIS TEST DATABASE only — production RuntimeFlag stays zero rows).
 * B4: the bypass battery — every crafted path must fail SERVER-SIDE.
 * B5: the declaration never appears in any response; only `ageVerified` does.
 */

import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RuntimeFlagService } from '../src/flags/runtime-flag.service';
import { DomainGate } from '../src/flags/domain-gate.guard';
import { SignupDto, GuestAuthDto } from '../src/auth/dto/auth.dto';
import { UpdateProfileDto } from '../src/users/dto/update-profile.dto';
import { AGE_POLICY_VERSION, isAdultYearMonth, isValidBirthYearMonth } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `ag${Date.now().toString(36)}`;
const uname = (n: string) => `${RUN}${n}`.slice(0, 16);

/** A YYYY-MM whose holder is unambiguously an adult / a minor, relative to now. */
const now = new Date();
const ym = (yearsAgo: number, monthShift = 0) => {
  const d = new Date(Date.UTC(now.getUTCFullYear() - yearsAgo, now.getUTCMonth() + monthShift, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const ADULT = ym(30); // 30 years old — clearly eligible
const MINOR = ym(15); // 15 years old — clearly refused
const TURNS_18_THIS_MONTH = ym(18); // birth month exactly 18 years ago — refused BY DESIGN
const TURNED_18_LAST_MONTH = ym(18, -1); // month fully past — eligible

/** The EXACT pipe main.ts installs — tamper tests must run the real config. */
const pipe = () => new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

let auth: AuthService;
let users: UsersService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, JwtModule.register({ secret: 'age-gate-test-secret-0123456789abcdef', signOptions: { expiresIn: '15m' } })],
    providers: [AuthService, UsersService],
  }).compile();
  auth = moduleRef.get(AuthService);
  users = moduleRef.get(UsersService);
});

afterAll(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: { startsWith: 'wave1b-test' } } }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user: { username: { startsWith: RUN } } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await prisma.$disconnect();
});

describe('the policy core (conservative UTC month rule)', () => {
  it('clear adult and clear minor decide correctly', () => {
    expect(isAdultYearMonth(ADULT)).toBe(true);
    expect(isAdultYearMonth(MINOR)).toBe(false);
  });

  it('EDGE: "turns 18 this month" is refused BY DESIGN — in every timezone', () => {
    // No day is stored, so the rule refuses the whole boundary month; a whole
    // month of margin dwarfs any UTC-offset ambiguity (B4 timezone edge).
    expect(isAdultYearMonth(TURNS_18_THIS_MONTH)).toBe(false);
  });

  it('EDGE: the month after their 18th-birthday month is eligible', () => {
    expect(isAdultYearMonth(TURNED_18_LAST_MONTH)).toBe(true);
  });

  it('EDGE: leap-day cannot exist — February year-months carry no day at all', () => {
    // A Feb-2000 declarant (born any day incl. Feb 29) is decided by month math only.
    expect(isAdultYearMonth('2000-02')).toBe(true);
    expect(isValidBirthYearMonth('2000-02')).toBe(true);
  });

  it('structural garbage is invalid: future months, month 13, pre-1900, non-format', () => {
    const nextYear = `${now.getUTCFullYear() + 1}-01`;
    for (const bad of [nextYear, '2020-13', '2020-00', '1850-05', '20200-1', 'yesterday', '2020/05', '']) {
      expect(isValidBirthYearMonth(bad)).toBe(false);
    }
  });
});

describe('B1 — signup path (server-side, no row on refusal)', () => {
  it('adult signup creates a verified account; response has NO declaration in it (B5)', async () => {
    const res = await auth.signup(uname('a1'), `${RUN}a1@t.example`, ADULT);
    expect(res.ageVerified).toBe(true);
    expect(JSON.stringify(res)).not.toContain(ADULT);
    const row = await prisma.user.findUnique({ where: { username: uname('a1') } });
    expect(row?.birthYearMonth).toBe(ADULT);
    expect(row?.agePolicyVersion).toBe(AGE_POLICY_VERSION);
    expect(row?.ageVerifiedAt).toBeTruthy();
  });

  it('THE POINT: under-18 is refused, with the validation-failure shape, and NO row exists', async () => {
    const before = await prisma.user.count();
    let caught: unknown;
    try {
      await auth.signup(uname('m1'), `${RUN}m1@t.example`, MINOR);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as Record<string, unknown>;
    // Non-enumerable: statusCode/message[]/error — the exact ValidationPipe shape.
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.error).toBe('Bad Request');
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.user.findUnique({ where: { username: uname('m1') } })).toBeNull();
  });

  it('EDGE: turns-18-this-month is refused at signup; last-month is accepted', async () => {
    await expect(auth.signup(uname('e1'), `${RUN}e1@t.example`, TURNS_18_THIS_MONTH)).rejects.toThrow(BadRequestException);
    const ok = await auth.signup(uname('e2'), `${RUN}e2@t.example`, TURNED_18_LAST_MONTH);
    expect(ok.ageVerified).toBe(true);
  });

  it('the refusal runs BEFORE any uniqueness lookup (same work as validation → non-enumerable timing)', async () => {
    // A minor declaring an ALREADY-TAKEN username still gets the age 400, not
    // the 409 — proof the decision precedes every DB query.
    await expect(auth.signup(uname('a1'), `${RUN}dup@t.example`, MINOR)).rejects.toThrow(BadRequestException);
  });
});

describe('B1 — guest path (create-or-reauth)', () => {
  const gid = (n: number) => `${n}${RUN}00000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);

  it('CREATE without a declaration is refused; no row', async () => {
    await expect(auth.guestAuth(gid(1), uname('g1'), undefined, 'secret-12345678')).rejects.toThrow(BadRequestException);
    expect(await prisma.user.findUnique({ where: { id: gid(1) } })).toBeNull();
  });

  it('CREATE with an under-18 declaration is refused; no row', async () => {
    await expect(auth.guestAuth(gid(2), uname('g2'), undefined, 'secret-12345678', undefined, undefined, undefined, MINOR)).rejects.toThrow(BadRequestException);
    expect(await prisma.user.findUnique({ where: { id: gid(2) } })).toBeNull();
  });

  it('CREATE with an adult declaration verifies; token response carries no DOB (B5)', async () => {
    const res = await auth.guestAuth(gid(3), uname('g3'), undefined, 'secret-12345678', undefined, undefined, undefined, ADULT);
    expect(res.ageVerificationRequired).toBe(false);
    expect(JSON.stringify(res)).not.toContain(ADULT);
    const row = await prisma.user.findUnique({ where: { id: gid(3) } });
    expect(row?.ageVerified).toBe(true);
  });

  it('B2/B4 REPLAY: a pre-gate guest account still re-auths (chat keeps working) but is flagged, and stays UNVERIFIED', async () => {
    // Simulate an account that predates the gate: row with no declaration.
    await prisma.user.create({ data: { id: gid(4), username: uname('g4'), claimSecretHash: null } });
    const res = await auth.guestAuth(gid(4), uname('g4'));
    expect(res.accessToken ?? (res as Record<string, unknown>).access_token ?? res).toBeTruthy(); // session proceeds
    expect(res.ageVerificationRequired).toBe(true); // but the gate is owed
    const row = await prisma.user.findUnique({ where: { id: gid(4) } });
    expect(row?.ageVerified).toBe(false);
  });

  it('B2 declare-on-login: a pre-gate account presenting an adult YM on re-auth becomes verified', async () => {
    await prisma.user.create({ data: { id: gid(5), username: uname('g5'), claimSecretHash: null } });
    const res = await auth.guestAuth(gid(5), uname('g5'), undefined, undefined, undefined, undefined, undefined, ADULT);
    expect(res.ageVerificationRequired).toBe(false);
    const row = await prisma.user.findUnique({ where: { id: gid(5) } });
    expect(row?.ageVerified).toBe(true);
    expect(row?.agePolicyVersion).toBe(AGE_POLICY_VERSION);
  });

  it('IMMUTABILITY: a re-auth can never rewrite an existing declaration', async () => {
    const before = await prisma.user.findUnique({ where: { id: gid(5) } });
    await auth.guestAuth(gid(5), uname('g5'), undefined, undefined, undefined, undefined, undefined, MINOR);
    const after = await prisma.user.findUnique({ where: { id: gid(5) } });
    expect(after?.birthYearMonth).toBe(before?.birthYearMonth); // first declaration stuck
    expect(after?.ageVerified).toBe(true);
  });

  it('a minor declaring on re-auth is RECORDED (cannot retry) but never verifies; session still issued (B2)', async () => {
    await prisma.user.create({ data: { id: gid(6), username: uname('g6'), claimSecretHash: null } });
    const res = await auth.guestAuth(gid(6), uname('g6'), undefined, undefined, undefined, undefined, undefined, MINOR);
    expect(res.ageVerificationRequired).toBe(true);
    const row = await prisma.user.findUnique({ where: { id: gid(6) } });
    expect(row?.birthYearMonth).toBe(MINOR); // recorded — a different year next launch changes nothing
    expect(row?.ageVerified).toBe(false);
    // ...and the recorded declaration is now immutable too:
    await auth.guestAuth(gid(6), uname('g6'), undefined, undefined, undefined, undefined, undefined, ADULT);
    const still = await prisma.user.findUnique({ where: { id: gid(6) } });
    expect(still?.birthYearMonth).toBe(MINOR);
    expect(still?.ageVerified).toBe(false);
  });
});

describe('B2 — the one-time declaration endpoint', () => {
  it('adult declaration verifies; the response is ONLY the boolean (B5)', async () => {
    const u = await prisma.user.create({ data: { username: uname('d1') } });
    const res = await users.declareAge(u.id, ADULT);
    expect(res).toEqual({ ageVerified: true });
  });

  it('under-18 declaration → 403 age_requirement; recorded; account remains (chat keeps working)', async () => {
    const u = await prisma.user.create({ data: { username: uname('d2') } });
    await expect(users.declareAge(u.id, MINOR)).rejects.toThrow(ForbiddenException);
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row).toBeTruthy(); // no lock-out of the account itself
    expect(row?.birthYearMonth).toBe(MINOR);
    expect(row?.ageVerified).toBe(false);
  });

  it('IMMUTABILITY: any second declaration is 409 — support path only', async () => {
    const u = await prisma.user.create({ data: { username: uname('d3') } });
    await users.declareAge(u.id, ADULT);
    await expect(users.declareAge(u.id, ADULT)).rejects.toThrow(ConflictException);
    // ...and a refused minor cannot re-declare either:
    const m = await prisma.user.create({ data: { username: uname('d4') } });
    await expect(users.declareAge(m.id, MINOR)).rejects.toThrow(ForbiddenException);
    await expect(users.declareAge(m.id, ADULT)).rejects.toThrow(ConflictException);
  });
});

describe('B3 — Discovery\'s door checks 18+ even with the flag ON (test DB only)', () => {
  const KEY = 'wave1b-test-discovery';
  const gate = () => {
    const GateClass = DomainGate(KEY, { requireAdult: true });
    return new GateClass(new RuntimeFlagService(prisma as unknown as PrismaService), prisma as unknown as PrismaService);
  };
  const ctxFor = (userId?: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
  }) as never;

  it('flag OFF: 404 for everyone — the dark posture is unchanged by the age layer', async () => {
    await expect(gate().canActivate(ctxFor('anyone'))).rejects.toThrow(NotFoundException);
  });

  it('THE POINT: flag ON + unverified account → 403 age_requirement (B4 direct-route hit)', async () => {
    await prisma.runtimeFlag.create({ data: { key: KEY, enabled: true } });
    const u = await prisma.user.create({ data: { username: uname('b3u') } }); // no declaration
    let caught: unknown;
    try {
      await gate().canActivate(ctxFor(u.id));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(((caught as ForbiddenException).getResponse() as Record<string, unknown>).error).toBe('age_requirement');
  });

  it('flag ON + anonymous (B4 replayed/absent principal) → 403, fail closed', async () => {
    await expect(gate().canActivate(ctxFor(undefined))).rejects.toThrow(ForbiddenException);
  });

  it('flag ON + verified adult → passes', async () => {
    const u = await prisma.user.create({
      data: { username: uname('b3v'), birthYearMonth: ADULT, ageVerified: true, ageVerifiedAt: new Date(), agePolicyVersion: AGE_POLICY_VERSION },
    });
    await expect(gate().canActivate(ctxFor(u.id))).resolves.toBe(true);
  });

  it('a token minted BEFORE verification proves nothing: the gate reads the CURRENT row', async () => {
    // Same principal id, row flips verified→false (support correction): access follows the ROW.
    const u = await prisma.user.create({
      data: { username: uname('b3r'), birthYearMonth: ADULT, ageVerified: true, ageVerifiedAt: new Date() },
    });
    await expect(gate().canActivate(ctxFor(u.id))).resolves.toBe(true);
    await prisma.user.update({ where: { id: u.id }, data: { ageVerified: false } });
    await expect(gate().canActivate(ctxFor(u.id))).rejects.toThrow(ForbiddenException);
  });
});

describe('B4 — tampered payloads die at the real pipe (main.ts config)', () => {
  it('signup payload missing birthYearMonth → 400 with the standard shape', async () => {
    await expect(
      pipe().transform({ username: 'tamper1', email: 't1@t.example' }, { type: 'body', metatype: SignupDto }),
    ).rejects.toThrow(BadRequestException);
  });

  it('signup payload with a forced ageVerified:true is REJECTED (forbidNonWhitelisted), not honoured', async () => {
    await expect(
      pipe().transform(
        { username: 'tamper2', email: 't2@t.example', birthYearMonth: MINOR, ageVerified: true },
        { type: 'body', metatype: SignupDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('guest payload with forced ageVerified/ageVerifiedAt/attestation fields is rejected', async () => {
    for (const extra of [{ ageVerified: true }, { ageVerifiedAt: new Date().toISOString() }, { attestedAdult: true }]) {
      await expect(
        pipe().transform(
          { id: 'aabbccdd', username: 'tamper3', secret: 'secret-12345678', ...extra },
          { type: 'body', metatype: GuestAuthDto },
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('PATCH /users/me cannot smuggle birthYearMonth or ageVerified', async () => {
    for (const extra of [{ birthYearMonth: ADULT }, { ageVerified: true }]) {
      await expect(
        pipe().transform({ name: 'x', ...extra }, { type: 'body', metatype: UpdateProfileDto }),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('under-18 DOB with every attestation-ish flag forced true STILL refuses server-side', async () => {
    // Even if a tampered client got a payload through some hypothetical relay,
    // the SERVICE recomputes from the declaration — the flags are never read.
    await expect(auth.signup(uname('t5'), `${RUN}t5@t.example`, MINOR)).rejects.toThrow(BadRequestException);
  });
});

describe('B5 — the declaration never leaves the server', () => {
  it('GET /users/me shape: ageVerified boolean present; declaration and hashes absent', async () => {
    const u = await prisma.user.create({
      data: { username: uname('p1'), birthYearMonth: ADULT, ageVerified: true, ageVerifiedAt: new Date(), agePolicyVersion: AGE_POLICY_VERSION, ageVerifyRef: 'ref-secret' },
    });
    const me = await users.findById(u.id);
    expect(me?.ageVerified).toBe(true);
    const json = JSON.stringify(me);
    expect(json).not.toContain(ADULT);
    for (const field of ['birthYearMonth', 'agePolicyVersion', 'ageVerifyRef', 'passwordHash', 'claimSecretHash', 'ageVerifiedAt']) {
      expect(json).not.toContain(field);
    }
  });

  it('public lookup exposes no age facts at all', async () => {
    const u = await prisma.user.create({ data: { username: uname('p2'), birthYearMonth: ADULT, ageVerified: true } });
    const pub = await users.findByUsername(u.username);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(ADULT);
    expect(json).not.toContain('ageVerified'); // not even the boolean travels to strangers
  });

  it('PATCH /users/me response (SELF_USER select) carries no declaration', async () => {
    const u = await prisma.user.create({ data: { username: uname('p3'), birthYearMonth: ADULT, ageVerified: true } });
    const res = await users.updateProfile(u.id, { name: 'renamed' });
    const json = JSON.stringify(res);
    expect(json).not.toContain(ADULT);
    expect(json).not.toContain('birthYearMonth');
    expect(json).not.toContain('claimSecretHash');
  });
});
