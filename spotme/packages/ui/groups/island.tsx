/**
 * The composed Groups surface the island host mounts (slice 3).
 *
 * Unlike Exchange, Groups is a LIVE surface, so the island takes injected
 * deps rather than fixtures: the live adapters (lib/groups-api.js, lib/db.js,
 * lib/group-perms.js, lib/rooms.js — reused, not rewritten) are built in
 * apps/web/src/views/groups-island.js and passed in at mount. Nothing here
 * touches the network or storage directly; only ports do.
 *
 * ADR-035 §(g): every persisted write goes through `deps.local`, whose live
 * implementation is the same db the legacy views use — same keys, same
 * schema, same encodings. Flag-off rollback lands on an unchanged store.
 */
import { useEffect, useState } from 'react';
import { GroupsListScreen, mergeEntries, type ListEntry } from './list';
import { GroupWizard, MemberPicker, type WizardProps } from './wizard';
import { GroupManageScreen } from './manage';
import type { CreateGroupInput, GroupsDeps, GroupSummary, GroupView, PersonView, Role } from './ports';

export interface GroupsIslandProps {
  deps: GroupsDeps;
  screen: 'list' | 'manage';
  groupId?: string;
}

function JoinSheet({ onJoin, onClose }: { onJoin(handle: string): void; onClose(): void }) {
  const [value, setValue] = useState('');
  const submit = () => {
    const handle = value.trim().toLowerCase().replace(/^@/, '');
    if (handle) onJoin(handle); else onClose();
  };
  return (
    <div className="g-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="g-sheet" role="dialog" aria-label="Join a public group">
        <div className="g-title">Join a public group</div>
        <p className="g-hint">Public groups are joinable by handle. The server holds their key.</p>
        <input
          type="text" className="g-input" maxLength={16} placeholder="group_handle"
          aria-label="Group handle" autoComplete="off" autoFocus
          value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <button type="button" className="g-pill g-ok" onClick={submit}>Join</button>
        <button type="button" className="g-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function AddMembersSheet({ deps, group, onDone, onClose }: {
  deps: GroupsDeps; group: GroupView; onDone(): void; onClose(): void;
}) {
  const [selected, setSelected] = useState<Map<string, PersonView>>(new Map());
  const [busy, setBusy] = useState(false);
  const exclude = new Set(group.members.map((m) => m.userId));
  const toggle = (p: PersonView) => {
    const next = new Map(selected);
    if (next.has(p.id)) next.delete(p.id); else next.set(p.id, p);
    setSelected(next);
  };
  const add = async () => {
    setBusy(true);
    const failed: string[] = [];
    // One call per person: a partial success must still land the people it can.
    for (const userId of selected.keys()) {
      try { await deps.api.addMember(group.id, userId); } catch { failed.push(userId); }
    }
    deps.host.toast(failed.length
      ? `Could not add ${failed.length} of ${selected.size}`
      : selected.size === 1 ? 'Member added' : `${selected.size} members added`);
    onDone();
  };
  return (
    <div className="g-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="g-sheet" role="dialog" aria-label="Add members">
        <div className="g-title">Add members</div>
        <p className="g-hint">Pick from contacts, or find anyone by @username.</p>
        <MemberPicker people={deps.people} selected={selected} exclude={exclude} onToggle={toggle} />
        <div className="g-actions">
          <button type="button" className="g-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="g-pill g-ok" disabled={busy || selected.size === 0} onClick={add}>
            {busy ? 'Adding…' : selected.size ? `Add ${selected.size}` : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupsList({ deps }: { deps: GroupsDeps }) {
  const [serverGroups, setServerGroups] = useState<GroupSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'none' | 'join' | 'wizard'>('none');
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<ListEntry | null>(null);
  const [, bump] = useState(0);

  const loadServer = () => {
    deps.api.listMine()
      .then((list) => { setServerGroups(Array.isArray(list) ? list : []); setLoadError(null); })
      .catch(() => setLoadError('Could not reach the group server — showing what is on this device.'));
  };
  useEffect(() => {
    loadServer();
    return deps.local.subscribe(() => bump((n) => n + 1));
  }, []);

  const entries = mergeEntries(serverGroups, deps.local.convos());

  const join = async (handle: string) => {
    setSheet('none');
    try {
      const joined = await deps.api.joinPublic(handle);
      const roomId = joined.roomId ?? joined.group?.roomId;
      const secret = joined.secretKey ?? joined.key ?? joined.group?.secretKey;
      if (!roomId || !secret) {
        deps.host.toast('Joined, but the server sent no key for this group');
        loadServer();
        return;
      }
      const name = joined.name ?? joined.group?.name ?? `@${handle}`;
      deps.local.upsertGroupConvo({ roomId, secret, name, groupId: joined.id ?? joined.group?.id });
      deps.rooms.ensure(roomId);
      deps.host.openThread(roomId);
    } catch (err) {
      deps.host.toast(String((err as Error)?.message || 'Could not join that group'));
    }
  };

  const create: WizardProps['onCreate'] = async (input: CreateGroupInput) => {
    setBusy(true);
    const roomId = deps.local.newId();
    const secret = deps.local.newId();
    const payload = { roomId, ...input };
    // The key is sent ONLY for public groups. Sending it for a private one
    // would quietly destroy the property the private option is chosen for.
    if (input.visibility === 'PUBLIC') (payload as { secretKey?: string }).secretKey = secret;
    try {
      const group = await deps.api.create(payload);
      deps.local.upsertGroupConvo({ roomId, secret, name: input.name, groupId: group?.id });
      deps.rooms.ensure(roomId);
      setSheet('none');
      deps.host.openThread(roomId);
    } catch (err) {
      deps.host.toast(String((err as Error)?.message || 'Could not create the group'));
    } finally {
      setBusy(false);
    }
  };

  const menuItems = (entry: ListEntry) => {
    const { group, convo } = entry;
    const items: { label: string; danger?: boolean; run(): void }[] = [];
    if (group) items.push({ label: 'Manage group', run: () => deps.host.nav(`#/group/${group.id}`) });
    if (convo) {
      items.push({
        label: 'Share invite link',
        run: () => void deps.host.share(
          deps.host.inviteUrl({ roomId: convo.roomId, secret: convo.secret! }, entry.title), entry.title),
      });
      items.push({ label: 'Archive', run: () => { deps.local.setArchived(convo.roomId, true); deps.host.toast('Group archived'); } });
    }
    items.push({
      label: 'Leave group',
      danger: true,
      async run() {
        // Server first: dropping it locally while the roster still holds you
        // is the state where a "left" group keeps waking your phone.
        if (group) {
          try { await deps.api.leave(group.id); } catch (err) {
            deps.host.toast(String((err as Error)?.message || 'Could not leave')); return;
          }
        }
        if (convo) { deps.rooms.leave(convo.roomId); deps.local.removeConvo(convo.roomId); }
        deps.host.toast('You left the group');
        loadServer();
      },
    });
    return items;
  };

  return (
    <>
      <GroupsListScreen
        entries={entries}
        loadError={loadError}
        onOpen={(e) => { if (e.convo) deps.host.openThread(e.convo.roomId); else if (e.group) deps.host.nav(`#/group/${e.group.id}`); }}
        onMenu={setMenuFor}
        onJoin={() => setSheet('join')}
        onNewGroup={() => setSheet('wizard')}
      />
      {sheet === 'join' && <JoinSheet onJoin={join} onClose={() => setSheet('none')} />}
      {sheet === 'wizard' && (
        <GroupWizard
          people={deps.people}
          checkUsername={(u) => deps.api.usernameAvailable(u)}
          busy={busy}
          onCreate={create}
          onClose={() => setSheet('none')}
        />
      )}
      {menuFor && (
        <div className="g-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setMenuFor(null); }}>
          <div className="g-sheet" role="menu" aria-label={menuFor.title}>
            <div className="g-title">{menuFor.title}</div>
            {menuItems(menuFor).map((a) => (
              <button key={a.label} type="button" role="menuitem"
                className={'g-menu-item' + (a.danger ? ' danger' : '')}
                onClick={() => { setMenuFor(null); a.run(); }}>{a.label}</button>
            ))}
            <button type="button" className="g-cancel" onClick={() => setMenuFor(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

function GroupManage({ deps, groupId }: { deps: GroupsDeps; groupId: string }) {
  const [group, setGroup] = useState<GroupView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = () => {
    deps.api.getOne(groupId)
      .then((g) => { setGroup(g); setLoadError(null); })
      .catch((err) => setLoadError(String((err as Error)?.message || 'Could not load this group')));
  };
  useEffect(load, [groupId]);

  /** Every mutation ends the same way: re-read the truth, or say why not. */
  const run = (fn: () => Promise<unknown>) => {
    fn().then(load).catch((err) => deps.host.toast(String((err as Error)?.message || 'That did not work')));
  };

  const leave = () => run(async () => {
    await deps.api.leave(groupId);
    const convo = deps.local.convos().find((c) => c.groupId === groupId);
    if (convo) { deps.rooms.leave(convo.roomId); deps.local.removeConvo(convo.roomId); }
    deps.host.toast('You left the group');
    deps.host.nav('#/groups');
  });

  const doDelete = () => run(async () => {
    await deps.api.remove(groupId);
    const convo = deps.local.convos().find((c) => c.groupId === groupId);
    if (convo) deps.local.removeConvo(convo.roomId);
    deps.host.toast('Group deleted');
    deps.host.nav('#/groups');
  });

  const shareInvite = async () => {
    const convo = deps.local.convos().find((c) => c.groupId === groupId);
    if (!convo?.secret) { deps.host.toast('No invite key on this device'); return; }
    await deps.host.share(
      deps.host.inviteUrl({ roomId: convo.roomId, secret: convo.secret }, group?.name || 'Group'),
      group?.name || 'Group');
  };

  return (
    <>
      <GroupManageScreen
        group={group}
        loadError={loadError}
        perms={deps.perms}
        actions={{
          onSetRole: (userId, role: Role) => run(() => deps.api.setRole(groupId, userId, role)),
          onMute: (userId, minutes) => run(() => deps.api.setMute(groupId, userId, minutes)),
          onBan: (userId, banned) => run(() => deps.api.setBan(groupId, userId, banned)),
          onRemove: (userId) => run(() => deps.api.removeMember(groupId, userId)),
          onTransfer: (userId) => run(() => deps.api.transfer(groupId, userId)),
        }}
        onBack={() => deps.host.nav('#/groups')}
        onToggleDefault={(key, next) => run(() => deps.api.update(groupId, { [key]: next }))}
        onAddMembers={() => setAdding(true)}
        onShareInvite={() => void shareInvite()}
        onLeave={leave}
        onDelete={() => setConfirmDelete(true)}
        onNoActions={() => deps.host.toast('You cannot manage this member')}
      />
      {adding && group && (
        <AddMembersSheet deps={deps} group={group}
          onDone={() => { setAdding(false); load(); }} onClose={() => setAdding(false)} />
      )}
      {confirmDelete && (
        <div className="g-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false); }}>
          <div className="g-sheet" role="alertdialog" aria-label="Delete group">
            <div className="g-title">Recoverable for 30 days, then gone</div>
            <button type="button" className="g-menu-item danger" onClick={() => { setConfirmDelete(false); doDelete(); }}>
              Delete for everyone
            </button>
            <button type="button" className="g-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

export function GroupsIsland({ deps, screen, groupId }: GroupsIslandProps) {
  if (screen === 'manage' && groupId) return <GroupManage deps={deps} groupId={groupId} />;
  return <GroupsList deps={deps} />;
}
