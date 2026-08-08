/**
 * Group management (slice 3) — roles and permissions, mirroring
 * views/group-manage.js. Every gate mirrors groups.service.ts via the
 * INJECTED perms port (lib/group-perms.js, reused not rewritten): the UI
 * hides what the server would refuse, and still shows the server's own words
 * when a call is refused anyway.
 */
import { useState } from 'react';
import { Avatar } from './list';
import { Toggle } from './wizard';
import type { GroupMemberView, GroupView, PermsPort, Role } from './ports';

export const MUTE_CHOICES = [
  { label: 'Mute for 1 hour', minutes: 60 },
  { label: 'Mute for 8 hours', minutes: 8 * 60 },
  { label: 'Mute for a day', minutes: 24 * 60 },
];

export const isMuted = (m: GroupMemberView): boolean =>
  Boolean(m.mutedUntil) && new Date(m.mutedUntil as string).getTime() > Date.now();

export interface MemberAction {
  label: string;
  danger?: boolean;
  run(): void;
}

export interface ManageCallbacks {
  onSetRole(userId: string, role: Role): void;
  onMute(userId: string, minutes: number | null): void;
  onBan(userId: string, banned: boolean): void;
  onRemove(userId: string): void;
  onTransfer(userId: string): void;
}

/**
 * The action list for one member, gated by the injected rules. Exported so
 * the permission battery can test the gating directly against the real
 * lib/group-perms.js module.
 */
export function memberActions(
  group: GroupView, m: GroupMemberView, perms: PermsPort, cb: ManageCallbacks,
): MemberAction[] {
  const items: MemberAction[] = [];
  const canAct = perms.outranks(group.myRole, m.role);

  if (canAct && perms.may(group, 'canAddAdmin')) {
    for (const role of ['ADMIN', 'MODERATOR', 'MEMBER'] as Role[]) {
      // "at or above your own rank" is refused server-side; do not offer it.
      if (role === m.role || !perms.outranks(group.myRole, role)) continue;
      items.push({ label: `Make ${perms.ROLE_LABEL[role].toLowerCase()}`, run: () => cb.onSetRole(m.userId, role) });
    }
  }
  if (canAct && perms.may(group, 'canMute')) {
    if (isMuted(m)) items.push({ label: 'Unmute', run: () => cb.onMute(m.userId, null) });
    else for (const c of MUTE_CHOICES) items.push({ label: c.label, run: () => cb.onMute(m.userId, c.minutes) });
  }
  if (canAct && perms.may(group, 'canBan')) {
    items.push(m.bannedAt
      ? { label: 'Lift ban', run: () => cb.onBan(m.userId, false) }
      : { label: 'Ban from group', danger: true, run: () => cb.onBan(m.userId, true) });
  }
  if (canAct && perms.may(group, 'canRemove')) {
    items.push({ label: 'Remove from group', danger: true, run: () => cb.onRemove(m.userId) });
  }
  if (group.myRole === 'OWNER' && m.role !== 'OWNER') {
    items.push({ label: 'Transfer ownership', danger: true, run: () => cb.onTransfer(m.userId) });
  }
  return items;
}

/** Mirrors groups.service.addMember: owner, canControlInvites, or member-add. */
export const canAddMembers = (group: GroupView): boolean =>
  group.myRole === 'OWNER' ||
  Boolean(group.myGrants?.canControlInvites) ||
  Boolean(group.permissions?.membersCanAdd);

export interface GroupManageScreenProps {
  group: GroupView | null;
  loadError: string | null;
  perms: PermsPort;
  actions: ManageCallbacks;
  onBack(): void;
  onToggleDefault(key: 'membersCanAdd' | 'membersCanMessage' | 'membersCanMedia', next: boolean): void;
  onAddMembers(): void;
  onShareInvite(): void;
  onLeave(): void;
  onDelete(): void;
  onNoActions(): void;
}

export function GroupManageScreen(p: GroupManageScreenProps) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const { group, perms } = p;

  if (!group) {
    return (
      <div className="g-screen g-manage">
        <button type="button" className="g-back" aria-label="Back" onClick={p.onBack}>‹</button>
        <h1 className="g-h1">Group</h1>
        <p className="g-sub">{p.loadError || 'Loading…'}</p>
      </div>
    );
  }

  const openMenu = (m: GroupMemberView) => {
    if (memberActions(group, m, perms, p.actions).length === 0) { p.onNoActions(); return; }
    setOpenFor(openFor === m.userId ? null : m.userId);
  };

  return (
    <div className="g-screen g-manage">
      <button type="button" className="g-back" aria-label="Back" onClick={p.onBack}>‹</button>
      <h1 className="g-h1">{group.name}</h1>
      <p className="g-sub">{perms.ROLE_LABEL[group.myRole] || 'Member'} · {group.members.length} members</p>

      <div className="g-note">
        {group.visibility === 'PUBLIC'
          ? `Public as @${group.username} — the server holds the key and can read this group.`
          : 'Private — the key never reaches the server.'}
      </div>

      <div className="g-actionsrow">
        {canAddMembers(group) && (
          <button type="button" className="g-pill g-ok" onClick={p.onAddMembers}>Add members</button>
        )}
        <button type="button" className="g-pill" onClick={p.onShareInvite}>Invite via link</button>
      </div>

      {/* Member defaults are owner-only server-side; showing them to an admin
          would be showing a switch that always throws. */}
      {group.myRole === 'OWNER' && (
        <>
          <div className="g-sec">Members can</div>
          {(['membersCanAdd', 'membersCanMessage', 'membersCanMedia'] as const).map((key) => (
            <Toggle
              key={key}
              label={{ membersCanAdd: 'Add people', membersCanMessage: 'Send messages', membersCanMedia: 'Send photos and video' }[key]}
              on={Boolean(group.permissions?.[key])}
              onFlip={() => p.onToggleDefault(key, !group.permissions?.[key])}
            />
          ))}
        </>
      )}

      <div className="g-sec">Members · {group.members.length}</div>
      <div className="g-list">
        {group.members.map((m) => {
          const marks = m.bannedAt ? 'banned' : isMuted(m) ? 'muted' : '';
          const items = openFor === m.userId ? memberActions(group, m, perms, p.actions) : null;
          return (
            <div key={m.userId} className={'g-member' + (m.bannedAt ? ' out' : '')}>
              <button type="button" className="g-row g-member-row" onClick={() => openMenu(m)}>
                <Avatar name={m.name || m.username || 'Member'} size={44} />
                <span className="g-mid">
                  <span className="g-l1">
                    <span className="g-nm">{m.name || m.username || 'Member'}</span>
                    <span className="g-role">{perms.ROLE_LABEL[m.role] || m.role}</span>
                  </span>
                  <span className="g-l2">
                    <span className="g-pv">{m.username ? `@${m.username}` : ''}</span>
                    {marks ? <span className="g-mark">{marks}</span> : null}
                  </span>
                </span>
              </button>
              {items && (
                <div className="g-menu" role="menu" aria-label={`Actions for ${m.name || m.username || 'member'}`}>
                  {items.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      role="menuitem"
                      className={'g-menu-item' + (a.danger ? ' danger' : '')}
                      onClick={() => { setOpenFor(null); a.run(); }}
                    >{a.label}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="g-danger">
        <button type="button" className="g-menu-item danger" onClick={p.onLeave}>Leave group</button>
        {group.myRole === 'OWNER' && (
          <button type="button" className="g-menu-item danger" onClick={p.onDelete}>Delete group</button>
        )}
      </div>
    </div>
  );
}
