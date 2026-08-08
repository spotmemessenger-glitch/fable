/**
 * Slice 3 — permission gating battery.
 *
 * The rules are NOT re-derived here: this imports the REAL
 * apps/web/src/lib/group-perms.js (framework-free, already covered by
 * apps/web/test/groups-permissions.test.js) and proves the React manage
 * surface offers exactly what those rules allow — ban/unban, role changes,
 * mute, remove, transfer — and nothing more.
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — plain JS module from the app, reused verbatim (ADR-035 slice 3).
import * as perms from '../../../apps/web/src/lib/group-perms.js';
import { memberActions, canAddMembers } from '../groups/manage';
import type { GroupMemberView, GroupView, PermsPort, Role } from '../groups/ports';

const P = perms as unknown as PermsPort;

const member = (over: Partial<GroupMemberView> = {}): GroupMemberView => ({
  userId: 'u2', name: 'Asha', username: 'asha', role: 'MEMBER', ...over,
});

const group = (over: Partial<GroupView> = {}): GroupView => ({
  id: 'g1', roomId: 'r1', name: 'Test group', visibility: 'PRIVATE',
  myRole: 'MEMBER', members: [], ...over,
});

const cb = () => ({
  onSetRole: vi.fn(), onMute: vi.fn(), onBan: vi.fn(), onRemove: vi.fn(), onTransfer: vi.fn(),
});

const labels = (g: GroupView, m: GroupMemberView) => memberActions(g, m, P, cb()).map((a) => a.label);

describe('member action gating (real lib/group-perms.js)', () => {
  it('a plain member gets no actions on anyone', () => {
    expect(labels(group({ myRole: 'MEMBER' }), member())).toEqual([]);
  });

  it('equal rank is refused — two admins cannot ban each other', () => {
    const g = group({ myRole: 'ADMIN', myGrants: { canBan: true, canAddAdmin: true } });
    expect(labels(g, member({ role: 'ADMIN' }))).toEqual([]);
  });

  it('an admin with only canBan sees ban and nothing else', () => {
    const g = group({ myRole: 'ADMIN', myGrants: { canBan: true } });
    expect(labels(g, member())).toEqual(['Ban from group']);
  });

  it('a banned member shows Lift ban instead', () => {
    const g = group({ myRole: 'ADMIN', myGrants: { canBan: true } });
    expect(labels(g, member({ bannedAt: '2026-08-01T00:00:00.000Z' }))).toEqual(['Lift ban']);
  });

  it('ban/unban call the api with the right direction', () => {
    const g = group({ myRole: 'OWNER' });
    const c = cb();
    memberActions(g, member(), P, c).find((a) => a.label === 'Ban from group')!.run();
    expect(c.onBan).toHaveBeenCalledWith('u2', true);
    memberActions(g, member({ bannedAt: 'x' }), P, c).find((a) => a.label === 'Lift ban')!.run();
    expect(c.onBan).toHaveBeenCalledWith('u2', false);
  });

  it('role changes never offer at-or-above the viewer rank', () => {
    const g = group({ myRole: 'ADMIN', myGrants: { canAddAdmin: true } });
    const offered = labels(g, member());
    // An ADMIN may promote to MODERATOR only — never to ADMIN (own rank).
    expect(offered).toContain('Make moderator');
    expect(offered).not.toContain('Make admin');
  });

  it('the owner can offer every lower role, mute choices, ban, remove, transfer', () => {
    const g = group({ myRole: 'OWNER' });
    const offered = labels(g, member());
    for (const want of ['Make admin', 'Make moderator', 'Mute for 1 hour', 'Ban from group', 'Remove from group', 'Transfer ownership']) {
      expect(offered).toContain(want);
    }
    expect(offered).not.toContain('Make member'); // target is already MEMBER
  });

  it('nobody outranks the owner — no actions offered on OWNER, even by OWNER', () => {
    const g = group({ myRole: 'OWNER' });
    expect(labels(g, member({ role: 'OWNER' }))).toEqual([]);
  });

  it('a muted member gets Unmute; role change fires the chosen role', () => {
    const g = group({ myRole: 'OWNER' });
    const c = cb();
    const soon = new Date(Date.now() + 60_000).toISOString();
    const acts = memberActions(g, member({ mutedUntil: soon }), P, c);
    acts.find((a) => a.label === 'Unmute')!.run();
    expect(c.onMute).toHaveBeenCalledWith('u2', null);
    acts.find((a) => a.label === 'Make admin')!.run();
    expect(c.onSetRole).toHaveBeenCalledWith('u2', 'ADMIN' as Role);
  });
});

describe('canAddMembers mirrors groups.service.addMember', () => {
  it('owner, canControlInvites, or the membersCanAdd default', () => {
    expect(canAddMembers(group({ myRole: 'OWNER' }))).toBe(true);
    expect(canAddMembers(group({ myRole: 'MEMBER', myGrants: { canControlInvites: true } }))).toBe(true);
    expect(canAddMembers(group({ myRole: 'MEMBER', permissions: { membersCanAdd: true } }))).toBe(true);
    expect(canAddMembers(group({ myRole: 'MEMBER' }))).toBe(false);
  });
});
