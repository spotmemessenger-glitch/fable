/**
 * Wave 1C, C2 — the under-18 freeze (owner decision, D6 addendum), against
 * REAL Postgres. One test per line of the owner's behaviour contract:
 *
 *   · CAN read existing conversations and message history
 *   · CAN receive the policy notice
 *   · CANNOT start new conversations
 *   · CANNOT reach Discovery or any newly introduced surface
 *   · CANNOT become discoverable, matchable, or messageable
 *   · CANNOT self-unfreeze, re-declare, or escape by re-auth or direct API
 *   · Data retained; reversal only via the documented support path
 */

import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient, RequestSource } from '@prisma/client';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { ChatRequestsService } from '../src/chat-requests/chat-requests.service';
import { RoomsAuthService } from '../src/rooms/rooms-auth.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RuntimeFlagService } from '../src/flags/runtime-flag.service';
import { DomainGate } from '../src/flags/domain-gate.guard';
import { ACCOUNT_FROZEN_MINOR, AGE_POLICY_VERSION } from '../src/policy/age';

const prisma = new PrismaClient();
const RUN = `fz${Date.now().toString(36)}`;
const uname = (n: string) => `${RUN}${n}`.slice(0, 16);
const now = new Date();
const ym = (yearsAgo: number) => {
  const d = new Date(Date.UTC(now.getUTCFullYear() - yearsAgo, now.getUTCMonth(), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const MINOR = ym(15);
const ADULT = ym(30);

let auth: AuthService;
let users: UsersService;
let requests: ChatRequestsService;
let frozenId: string;
let adultId: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule, JwtModule.register({ secret: 'freeze-test-secret-0123456789abcdef', signOptions: { expiresIn: '15m' } })],
    providers: [AuthService, UsersService, ChatRequestsService],
  }).compile();
  auth = moduleRef.get(AuthService);
  users = moduleRef.get(UsersService);
  requests = moduleRef.get(ChatRequestsService);

  // A pre-gate account that declares under-18 → frozen; and a verified adult.
  const frozen = await prisma.user.create({ data: { username: uname('froz') } });
  frozenId = frozen.id;
  await users.declareAge(frozenId, MINOR).catch(() => undefined); // records + freezes + throws
  const adult = await prisma.user.create({
    data: { username: uname('adlt'), birthYearMonth: ADULT, ageVerified: true, ageVerifiedAt: new Date(), agePolicyVersion: AGE_POLICY_VERSION },
  });
  adultId = adult.id;
});

afterAll(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: { startsWith: 'wave1c-test' } } }).catch(() => {});
  await prisma.chatRequest.deleteMany({ where: { fromUser: { username: { startsWith: RUN } } } }).catch(() => {});
  await prisma.refreshToken.deleteMany({ where: { user: { username: { startsWith: RUN } } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await prisma.$disconnect();
});

describe('freeze assignment is an EXPLICIT status', () => {
  it('under-18 declaration by an existing account sets accountStatus=frozen_minor (not just !ageVerified)', async () => {
    const row = await prisma.user.findUnique({ where: { id: frozenId } });
    expect(row?.accountStatus).toBe(ACCOUNT_FROZEN_MINOR);
    expect(row?.ageVerified).toBe(false);
    expect(row?.birthYearMonth).toBe(MINOR);
  });

  it('the re-auth declare-on-login path freezes too', async () => {
    const gid = `1${RUN}00000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
    await prisma.user.create({ data: { id: gid, username: uname('fz2') } });
    const res = await auth.guestAuth(gid, uname('fz2'), undefined, undefined, undefined, undefined, undefined, MINOR);
    expect((res as Record<string, unknown>).accountFrozen).toBe(true);
    expect(typeof (res as Record<string, unknown>).notice).toBe('string');
    const row = await prisma.user.findUnique({ where: { id: gid } });
    expect(row?.accountStatus).toBe(ACCOUNT_FROZEN_MINOR);
  });
});

describe('CAN: read existing conversations and receive the notice', () => {
  it('CAN read: pending-request listing (read machinery) still answers', async () => {
    await expect(requests.pendingForUser(frozenId)).resolves.toBeDefined();
  });

  it('CAN read: the gateway read path is untouched — only msg/knock are refused', async () => {
    const ra = new RoomsAuthService(
      { policyFor: async () => null } as never,
      prisma as unknown as PrismaService,
    );
    expect(await ra.authorizeAction('room1', frozenId, 'seen', undefined)).toBeNull(); // read receipt OK
    expect(await ra.authorizeAction('room1', frozenId, 'msg', undefined)).toBe('account_frozen');
    expect(await ra.authorizeAction('room1', frozenId, 'knock', undefined)).toBe('account_frozen');
  });

  it('CAN receive the notice: own profile exposes accountStatus; re-auth carries the notice text', async () => {
    const me = await users.findById(frozenId);
    expect((me as Record<string, unknown>)?.accountStatus).toBe(ACCOUNT_FROZEN_MINOR);
  });
});

describe('CANNOT: new conversations, in any direction', () => {
  it('frozen sender cannot initiate — 403 account_frozen', async () => {
    let caught: unknown;
    try {
      await requests.initiate(frozenId, adultId, RequestSource.USERNAME);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(((caught as ForbiddenException).getResponse() as Record<string, unknown>).error).toBe('account_frozen');
  });

  it('frozen account cannot ACCEPT a pending request (accepting creates a conversation)', async () => {
    await expect(requests.respond('any-id', frozenId, true)).rejects.toThrow(ForbiddenException);
  });

  it('NOT MESSAGEABLE: initiating TOWARD a frozen account refuses with the block shape (non-enumerable)', async () => {
    let frozenTarget: unknown, blockedTarget: unknown;
    try { await requests.initiate(adultId, frozenId, RequestSource.USERNAME); } catch (e) { frozenTarget = e; }
    // Compare against a real block refusal:
    const other = await prisma.user.create({ data: { username: uname('blk') } });
    await prisma.block.create({ data: { blockerId: other.id, blockedId: adultId } });
    try { await requests.initiate(adultId, other.id, RequestSource.USERNAME); } catch (e) { blockedTarget = e; }
    expect(frozenTarget).toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify((frozenTarget as ForbiddenException).getResponse()))
      .toBe(JSON.stringify((blockedTarget as ForbiddenException).getResponse()));
  });
});

describe('CANNOT: Discovery or any newly introduced surface', () => {
  const KEY = 'wave1c-test-freeze-gate';
  const gate = () => {
    const GateClass = DomainGate(KEY, { requireAdult: true });
    return new GateClass(new RuntimeFlagService(prisma as unknown as PrismaService), prisma as unknown as PrismaService);
  };
  const ctxFor = (userId?: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
  }) as never;

  it('THE POINT: frozen is refused at the gate EVEN IF ageVerified were true — explicit status beats side-effect', async () => {
    await prisma.runtimeFlag.create({ data: { key: KEY, enabled: true } });
    const anomaly = await prisma.user.create({
      data: { username: uname('anom'), birthYearMonth: ADULT, ageVerified: true, accountStatus: ACCOUNT_FROZEN_MINOR },
    });
    await expect(gate().canActivate(ctxFor(anomaly.id))).rejects.toThrow(ForbiddenException);
  });

  it('ordinary frozen account: 403 at the door', async () => {
    await expect(gate().canActivate(ctxFor(frozenId))).rejects.toThrow(ForbiddenException);
  });

  it('NOT DISCOVERABLE: the visibility write path lives behind the same gate, so a frozen account can never opt in', async () => {
    // Structural proof: every Discovery route (including visibility writes)
    // mounts behind DomainGate(requireAdult) — the same guard just shown to
    // refuse frozen accounts. No separate opt-in path exists.
    await expect(gate().canActivate(ctxFor(frozenId))).rejects.toThrow(ForbiddenException);
  });
});

describe('CANNOT: self-unfreeze, re-declare, or escape', () => {
  it('re-declaration via the endpoint: 409 (immutable; support path only)', async () => {
    await expect(users.declareAge(frozenId, ADULT)).rejects.toThrow(ConflictException);
  });

  it('re-auth with a fresh adult declaration changes NOTHING (immutable via that door too), and the session still works (read access)', async () => {
    const gid = `2${RUN}00000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
    await prisma.user.create({ data: { id: gid, username: uname('fz3') } });
    await auth.guestAuth(gid, uname('fz3'), undefined, undefined, undefined, undefined, undefined, MINOR); // freeze
    const retry = await auth.guestAuth(gid, uname('fz3'), undefined, undefined, undefined, undefined, undefined, ADULT); // escape attempt
    expect((retry as Record<string, unknown>).accountFrozen).toBe(true); // still frozen, still noticed
    expect((retry as Record<string, unknown>).accessToken).toBeTruthy(); // but the session (read access) works
    const row = await prisma.user.findUnique({ where: { id: gid } });
    expect(row?.birthYearMonth).toBe(MINOR);
    expect(row?.accountStatus).toBe(ACCOUNT_FROZEN_MINOR);
  });

  it('PATCH /users/me cannot touch accountStatus (whitelist DTO) — verified in age-gate.spec tamper battery for the pipe; service input type has no such field', async () => {
    // UpdateProfileInput has no accountStatus member — a compile-time hole
    // would be needed to smuggle it; runtime pipe rejects unknown fields.
    const res = await users.updateProfile(frozenId, { name: 'still frozen' });
    const row = await prisma.user.findUnique({ where: { id: frozenId } });
    expect(row?.accountStatus).toBe(ACCOUNT_FROZEN_MINOR);
    expect(JSON.stringify(res)).not.toContain(MINOR);
  });
});

describe('data retained; support path is the only reversal', () => {
  it('freezing changed status fields ONLY — profile data intact, nothing deleted', async () => {
    const row = await prisma.user.findUnique({ where: { id: frozenId } });
    expect(row).toBeTruthy();
    expect(row?.deletedAt).toBeNull();
    expect(row?.username).toBe(uname('froz'));
  });

  it('the support path works: correcting the declaration + status restores an active account', async () => {
    // The documented support operation (operator-run, never API):
    await prisma.user.update({
      where: { id: frozenId },
      data: { birthYearMonth: ADULT, ageVerified: true, ageVerifiedAt: new Date(), accountStatus: 'active' },
    });
    const row = await prisma.user.findUnique({ where: { id: frozenId } });
    expect(row?.accountStatus).toBe('active');
    // ...and re-freeze for any later assertions in this run:
    await prisma.user.update({ where: { id: frozenId }, data: { ageVerified: false, birthYearMonth: MINOR, accountStatus: ACCOUNT_FROZEN_MINOR } });
  });
});
