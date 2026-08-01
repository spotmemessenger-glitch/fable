import { Test } from '@nestjs/testing';
import { GroupPolicy, GroupsService } from '../src/groups/groups.service';
import { RoomsAuthService } from '../src/rooms/rooms-auth.service';

/**
 * The refusal rules, pinned where BOTH transports can be held to them.
 *
 * WHY THIS FILE EXISTS. `policy()` and `refuse()` were private methods on
 * RoomsGateway. The Centrifugo publish proxy needed the same decisions, and the
 * only alternative to extracting them was a second copy — which is how the
 * "gateway authorised NOTHING" hole from the 2026-07-31 audit gets reopened
 * through a new door (ADR-002 §3).
 *
 * An extraction is only safe if it is behaviour-preserving, so these assert the
 * exact strings the gateway returned, not merely "it refused". The web client
 * surfaces those messages, so a reworded refusal breaks the UI silently.
 *
 * No database: GroupsService is stubbed, because what is under test is the
 * decision logic and its cache, not Prisma.
 */

const basePolicy = (over: Partial<GroupPolicy> = {}): GroupPolicy =>
  ({
    groupId: 'g1',
    selfId: 'me',
    visibility: 'PRIVATE',
    role: 'MEMBER',
    banned: false,
    muted: false,
    canMessage: true,
    canMedia: true,
    canDeleteOthers: false,
    ...over,
  }) as GroupPolicy;

describe('RoomsAuthService — one implementation, both transports', () => {
  let auth: RoomsAuthService;
  let policyFor: jest.Mock;

  beforeEach(async () => {
    policyFor = jest.fn().mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [RoomsAuthService, { provide: GroupsService, useValue: { policyFor } }],
    }).compile();
    auth = moduleRef.get(RoomsAuthService);
  });

  describe('refuse() — the gateway rules, verbatim', () => {
    it('refuses everything from a banned member with the join wording', () => {
      const p = basePolicy({ banned: true, canMessage: true });
      expect(auth.refuse(p, 'msg', undefined)).toBe('not a member of this group');
      expect(auth.refuse(p, 'typing', undefined)).toBe('not a member of this group');
    });

    it('distinguishes a mute from a permission for msg and bin', () => {
      expect(auth.refuse(basePolicy({ canMessage: false, muted: true }), 'msg', undefined))
        .toBe('you are muted in this group');
      expect(auth.refuse(basePolicy({ canMessage: false, muted: false }), 'msg', undefined))
        .toBe('members cannot send messages here');
      expect(auth.refuse(basePolicy({ canMedia: false, muted: true }), 'bin', undefined))
        .toBe('you are muted in this group');
      expect(auth.refuse(basePolicy({ canMedia: false, muted: false }), 'bin', undefined))
        .toBe('members cannot send media here');
    });

    it('bars an edit only when muted — you may only edit your own message', () => {
      expect(auth.refuse(basePolicy({ muted: true }), 'edit', undefined))
        .toBe('you are muted in this group');
      expect(auth.refuse(basePolicy({ muted: false }), 'edit', undefined)).toBeNull();
    });

    it('allows an unlabelled delete but refuses another owner without the grant', () => {
      const p = basePolicy({ canDeleteOthers: false });
      // meta.owner absent -> older client, allowed rather than break installs.
      expect(auth.refuse(p, 'del', undefined)).toBeNull();
      expect(auth.refuse(p, 'del', { owner: 'me' })).toBeNull();
      expect(auth.refuse(p, 'del', { owner: 'someone-else' }))
        .toBe('you cannot delete other people’s messages');
      expect(auth.refuse(basePolicy({ canDeleteOthers: true }), 'del', { owner: 'someone-else' }))
        .toBeNull();
    });

    it('allows unknown types — the type whitelist is RoomsService, not policy', () => {
      expect(auth.refuse(basePolicy(), 'react', undefined)).toBeNull();
    });
  });

  describe('authorizeJoin / authorizeAction — what both callers use', () => {
    it('admits and allows when the room is not a group (a DM)', async () => {
      policyFor.mockResolvedValue(null);
      expect(await auth.authorizeJoin('dm-abc', 'me')).toBeNull();
      expect(await auth.authorizeAction('dm-abc', 'me', 'msg', undefined)).toBeNull();
    });

    it('refuses a banned member on join', async () => {
      policyFor.mockResolvedValue(basePolicy({ banned: true }));
      expect(await auth.authorizeJoin('g-abc', 'me')).toBe('not a member of this group');
    });

    it('admits a merely muted member on join, then refuses their message', async () => {
      policyFor.mockResolvedValue(basePolicy({ muted: true, canMessage: false }));
      expect(await auth.authorizeJoin('g-abc', 'me')).toBeNull();
      expect(await auth.authorizeAction('g-abc', 'me', 'msg', undefined))
        .toBe('you are muted in this group');
    });

    it('treats a policy lookup failure as "not a group" rather than a 500', async () => {
      policyFor.mockRejectedValue(new Error('db down'));
      expect(await auth.authorizeAction('g-abc', 'me', 'msg', undefined)).toBeNull();
    });
  });

  describe('the policy cache', () => {
    it('reuses one lookup across calls — a send must not hit Postgres per keystroke', async () => {
      policyFor.mockResolvedValue(basePolicy());
      await auth.authorizeAction('g-abc', 'me', 'msg', undefined);
      await auth.authorizeAction('g-abc', 'me', 'msg', undefined);
      await auth.authorizeAction('g-abc', 'me', 'typing', undefined);
      expect(policyFor).toHaveBeenCalledTimes(1);
    });

    it('keys on room AND user, so one member’s policy never answers for another', async () => {
      policyFor.mockImplementation(async (_room: string, user: string) =>
        basePolicy({ selfId: user, banned: user === 'banned-user' }));
      expect(await auth.authorizeJoin('g-abc', 'ok-user')).toBeNull();
      expect(await auth.authorizeJoin('g-abc', 'banned-user')).toBe('not a member of this group');
      expect(policyFor).toHaveBeenCalledTimes(2);
    });
  });
});
