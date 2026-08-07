/**
 * Slice 3 — Groups UI: list rendering (two-truths merge, pending groups,
 * unread state), the manage screen's gated member menu driving real api
 * calls, and wizard step order (people before name — the wall appears before
 * work is invested).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
// @ts-expect-error — plain JS module from the app, reused verbatim.
import * as perms from '../../../apps/web/src/lib/group-perms.js';
import { GroupsIsland } from '../groups/island';
import { mergeEntries } from '../groups/list';
import { makeDeps } from '../groups/fixtures';
import type { GroupView, PermsPort } from '../groups/ports';

afterEach(cleanup);
const P = perms as unknown as PermsPort;

const g1: GroupView = {
  id: 'g1', roomId: 'r1', name: 'Hikers', visibility: 'PUBLIC', username: 'hikers',
  myRole: 'OWNER', permissions: { membersCanAdd: true, membersCanMessage: true, membersCanMedia: true },
  members: [
    { userId: 'me', name: 'You', username: 'you', role: 'OWNER' },
    { userId: 'u2', name: 'Asha', username: 'asha', role: 'MEMBER' },
    { userId: 'u3', name: 'Banned Bo', username: 'bo', role: 'MEMBER', bannedAt: '2026-08-01T00:00:00.000Z' },
  ],
};

describe('groups list', () => {
  it('merges server groups with local convos and shows key-less groups as pending', () => {
    const rows = mergeEntries(
      [{ id: 'g1', roomId: 'r1', name: 'Hikers', visibility: 'PRIVATE', myRole: 'MEMBER' }],
      [
        { roomId: 'r2', title: 'Offline crew', kind: 'group', secret: 's', last: { ts: 2, text: 'hey' } },
        { roomId: 'r-x', title: 'A chat', kind: 'dm' },
        { roomId: 'r-arch', title: 'Old', kind: 'group', archived: true },
      ],
    );
    expect(rows.map((r) => r.title)).toEqual(['Offline crew', 'Hikers']);
    expect(rows[1].convo).toBeNull(); // server group with no local key
  });

  it('renders rows, the pending explainer, and the @handle mark', async () => {
    const world = makeDeps({
      perms: P,
      groups: [g1],
      convos: [{ roomId: 'r2', title: 'Offline crew', kind: 'group', secret: 's', unread: 3, last: { ts: 1, text: 'hello' } }],
    });
    render(<GroupsIsland deps={world.deps} screen="list" />);
    expect(await screen.findByText('Hikers')).toBeTruthy();
    expect(screen.getByText('@hikers')).toBeTruthy();
    expect(screen.getByText('Invite pending — open the invite link to get the key')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy(); // unread badge
  });

  it('opening a key-less server group navigates to manage, a keyed one opens the thread', async () => {
    const world = makeDeps({
      perms: P, groups: [g1],
      convos: [{ roomId: 'r2', title: 'Offline crew', kind: 'group', secret: 's' }],
    });
    render(<GroupsIsland deps={world.deps} screen="list" />);
    fireEvent.click(await screen.findByText('Hikers'));
    expect(world.navs).toContain('#/group/g1');
    fireEvent.click(screen.getByText('Offline crew'));
    expect(world.openedThreads).toContain('r2');
  });

  it('join by handle stores the key through the app-shaped port and opens the thread', async () => {
    const world = makeDeps({ perms: P });
    render(<GroupsIsland deps={world.deps} screen="list" />);
    fireEvent.click(screen.getByText('Join'));
    fireEvent.change(screen.getByLabelText('Group handle'), { target: { value: '@Hikers' } });
    fireEvent.keyDown(screen.getByLabelText('Group handle'), { key: 'Enter' });
    await waitFor(() => expect(world.openedThreads).toContain('r-join'));
    expect(world.calls.find((c) => c.name === 'joinPublic')?.args).toEqual(['hikers']);
    expect(world.calls.some((c) => c.name === 'upsertGroupConvo')).toBe(true);
    expect(world.calls.some((c) => c.name === 'rooms.ensure')).toBe(true);
  });

  it('the wizard asks for people FIRST and refuses Next below the server minimum', async () => {
    const world = makeDeps({ perms: P, people: [{ id: 'p1', name: 'Asha', username: 'asha' }, { id: 'p2', name: 'Ravi', username: 'ravi' }] });
    render(<GroupsIsland deps={world.deps} screen="list" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'New group' })[0]);
    expect(screen.getByText('Step 1 of 3 — pick at least 2 people.')).toBeTruthy();
    const next = screen.getByRole('button', { name: 'Add 2 more' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Find people'), { target: { value: 'a' } });
    const asha = await screen.findByRole('button', { name: /Asha/ }, { timeout: 2000 });
    fireEvent.click(asha);
    fireEvent.click(screen.getByRole('button', { name: /Ravi/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next · 2' }));
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
  });
});

describe('group manage', () => {
  it('an owner sees the defaults toggles; ban and unban reach the api', async () => {
    const world = makeDeps({ perms: P, groups: [g1] });
    render(<GroupsIsland deps={world.deps} screen="manage" groupId="g1" />);
    expect(await screen.findByText('Hikers')).toBeTruthy();
    expect(screen.getByRole('switch', { name: /Send messages/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Asha/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ban from group' }));
    await waitFor(() => expect(world.calls.some((c) => c.name === 'setBan' && c.args[1] === 'u2' && c.args[2] === true)).toBe(true));

    fireEvent.click(await screen.findByRole('button', { name: /Banned Bo/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lift ban' }));
    await waitFor(() => expect(world.calls.some((c) => c.name === 'setBan' && c.args[1] === 'u3' && c.args[2] === false)).toBe(true));
  });

  it('a role change reaches the api with the chosen role', async () => {
    const world = makeDeps({ perms: P, groups: [g1] });
    render(<GroupsIsland deps={world.deps} screen="manage" groupId="g1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Asha/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make admin' }));
    await waitFor(() => expect(world.calls.some((c) => c.name === 'setRole' && c.args[1] === 'u2' && c.args[2] === 'ADMIN')).toBe(true));
  });

  it('a plain member sees no owner toggles and tapping a peer says so instead of a menu', async () => {
    const asMember: GroupView = { ...g1, myRole: 'MEMBER', myGrants: {}, permissions: { membersCanAdd: false } };
    const world = makeDeps({ perms: P, groups: [asMember] });
    render(<GroupsIsland deps={world.deps} screen="manage" groupId="g1" />);
    expect(await screen.findByText('Hikers')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /Send messages/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Asha/ }));
    expect(world.toasts).toContain('You cannot manage this member');
    expect(screen.queryByRole('menuitem', { name: 'Ban from group' })).toBeNull();
  });

  it('delete is owner-only and confirmed before it reaches the api', async () => {
    const world = makeDeps({ perms: P, groups: [g1] });
    render(<GroupsIsland deps={world.deps} screen="manage" groupId="g1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete group' }));
    expect(world.calls.some((c) => c.name === 'remove')).toBe(false); // not yet
    fireEvent.click(screen.getByRole('button', { name: 'Delete for everyone' }));
    await waitFor(() => expect(world.calls.some((c) => c.name === 'remove')).toBe(true));
    expect(world.navs).toContain('#/groups');
  });
});
