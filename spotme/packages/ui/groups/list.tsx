/**
 * Groups list (slice 3) — pure and prop-driven, mirroring views/groups.js:
 * the list is the union of two truths (server groups + local convos), a
 * server group with no local key still shows and says so, and every colour
 * comes from tokens.
 */
import './groups.css';
import { useMemo, useState } from 'react';
import type { ConvoView, GroupSummary } from './ports';

export interface ListEntry {
  group: GroupSummary | null;
  convo: ConvoView | null;
  roomId: string;
  title: string;
}

/** One row per group, keyed by roomId so the two sources line up. */
export function mergeEntries(serverGroups: GroupSummary[], convosIn: ConvoView[]): ListEntry[] {
  const convos = new Map(
    convosIn.filter((c) => c.kind === 'group' && !c.archived).map((c) => [c.roomId, c]),
  );
  const rows: ListEntry[] = serverGroups.map((group) => {
    const convo = convos.get(group.roomId) ?? null;
    convos.delete(group.roomId);
    return { group, convo, roomId: group.roomId, title: group.name };
  });
  // Groups made before the server existed, or made offline, still show.
  for (const convo of convos.values()) {
    rows.push({ group: null, convo, roomId: convo.roomId, title: convo.title || 'Group' });
  }
  return rows.sort(
    (a, b) =>
      (b.convo?.last?.ts || b.convo?.created || 0) - (a.convo?.last?.ts || a.convo?.created || 0),
  );
}

const EXPLAINER =
  'A group is a shared room. Roles and bans are enforced by the server; your messages are not read by it.';

export function fmtDay(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Avatar({ name, size = 52 }: { name: string; size?: number }) {
  return (
    <span className="g-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

export interface GroupsListScreenProps {
  entries: ListEntry[];
  loadError: string | null;
  onOpen(entry: ListEntry): void;
  onMenu(entry: ListEntry): void;
  onJoin(): void;
  onNewGroup(): void;
}

export function GroupsListScreen(p: GroupsListScreenProps) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return p.entries.filter((r) => !needle || r.title.toLowerCase().includes(needle));
  }, [p.entries, q]);

  return (
    <div className="g-screen">
      <div className="g-bar">
        <button type="button" className="g-pill" onClick={p.onJoin}>Join</button>
        <span className="g-sp" />
        <button type="button" className="g-pill g-ok" onClick={p.onNewGroup}>New group</button>
      </div>
      <h1 className="g-h1">Groups</h1>
      <input
        type="text"
        className="g-search"
        placeholder="Search groups..."
        autoComplete="off"
        aria-label="Search groups"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="g-list">
        {rows.length === 0 && (
          <div className="g-empty">
            <p>{q ? 'No group matches your search.' : p.loadError || EXPLAINER}</p>
            {!q && (
              <button type="button" className="g-pill g-ok" onClick={p.onNewGroup}>New group</button>
            )}
          </div>
        )}
        {rows.map((entry) => {
          const { group, convo, title } = entry;
          const unread = convo?.unread || 0;
          const preview = convo?.last
            ? `${convo.last.fromMe ? 'You: ' : ''}${convo.last.text}`
            : convo
              ? 'No messages yet'
              : 'Invite pending — open the invite link to get the key';
          return (
            <div
              key={entry.roomId}
              className={'g-row' + (unread ? ' unread' : '') + (convo ? '' : ' pending')}
              role="button"
              tabIndex={0}
              onClick={() => p.onOpen(entry)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(entry); } }}
            >
              <Avatar name={title} />
              <div className="g-mid">
                <div className="g-l1">
                  <span className="g-nm">{title}</span>
                  {convo?.last ? <span className="g-tm">{fmtDay(convo.last.ts)}</span> : null}
                </div>
                <div className="g-l2">
                  <span className="g-pv">{preview}</span>
                  {group?.visibility === 'PUBLIC' && (
                    <span className="g-mark">@{group.username}</span>
                  )}
                  {unread ? <span className="g-bdg">{unread > 99 ? '99+' : unread}</span> : null}
                </div>
              </div>
              <button
                type="button"
                className="g-more"
                aria-label="Group options"
                onClick={(e) => { e.stopPropagation(); p.onMenu(entry); }}
              >⋯</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
