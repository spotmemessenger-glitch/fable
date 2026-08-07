/**
 * Inbox — React screen (slice 6, behind spotme.ui.inbox).
 *
 * Prop-driven off an InboxPort; nothing here fetches, stores, or routes.
 * Deliberate divergences from the legacy view, both precedented in slice 2
 * (DoD #7 accessibility):
 *   - swipe-to-archive and long-press become a visible per-row ⋯ menu —
 *     both gestures are undiscoverable and have no keyboard path;
 *   - the pull-to-reveal Archived row is always visible when anything is
 *     archived (revealing UI by touch drag alone fails keyboard parity).
 */
import './inbox.css';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConvoRowView, InboxPort, InboxTab, UserMatch } from './ports';
import { NewChatSheet, RequestSheet } from './sheets';

const SEARCH_DEBOUNCE_MS = 350;
const USERNAME_RE = /^[a-z0-9_]{2,}$/;
const ICON_SEARCH = 'M11 4a7 7 0 105.3 11.9l3.2 3.2 1-1-3.2-3.2A7 7 0 0011 4z';

const TABS: { key: InboxTab; label: string }[] = [
  { key: 'chats', label: 'Chats' },
  { key: 'nearby', label: 'Nearby' },
  { key: 'bt', label: 'Bluetooth' },
];

const EMPTY_COPY: Record<InboxTab, { text: string; btn: string; nav: string }> = {
  chats: { text: 'No chats yet — search a username above or find people in Discovery.', btn: 'Find people', nav: '#/discovery' },
  nearby: { text: 'No nearby chats yet — say hi to someone in Discovery.', btn: 'Find people', nav: '#/discovery' },
  bt: { text: 'No Bluetooth chats yet — start one from the Bluetooth screen.', btn: 'Open Bluetooth', nav: '#/bluetooth' },
};

/** "@yuv" / "yuv" → "yuv" when it looks like a username, else null. */
export function usernameQuery(raw: string): string | null {
  const q = raw.trim().replace(/^@/, '').toLowerCase();
  return USERNAME_RE.test(q) ? q : null;
}

export function Disc({ name, url, size, online }: {
  name: string; url: string | null; size: number; online?: boolean;
}) {
  return (
    <span className="i2-disc" style={{ width: size, height: size }} aria-hidden="true">
      {url
        ? <img src={url} alt="" width={size} height={size} />
        : <span className="i2-disc-initial">{(name || '?').slice(0, 1).toUpperCase()}</span>}
      {online && <i className="i2-dot" />}
    </span>
  );
}

function badge(n: number): string { return n > 99 ? '99+' : String(n); }

function Row({ row, port, confirmingDelete, onConfirmDelete }: {
  row: ConvoRowView;
  port: InboxPort;
  confirmingDelete: boolean;
  onConfirmDelete: (id: string | null) => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <li className={'i2-row' + (row.unread > 0 ? ' unread' : '')}>
      <button type="button" className="i2-open" onClick={() => port.openThread(row.id)}>
        <Disc name={row.name} url={row.avatarUrl} size={52} online={row.online} />
        <span className="i2-mid">
          <span className="i2-l1">
            <b className="i2-nm">{row.name}</b>
            {row.group && <span className="i2-chip">group</span>}
            {row.archived && <span className="i2-chip">Archived</span>}
            <span className="i2-tm">{row.timeLabel}</span>
          </span>
          <span className="i2-l2">
            <span className="i2-pv">{row.preview}</span>
            {row.unread > 0 && <span className="i2-bdg">{badge(row.unread)}</span>}
          </span>
        </span>
      </button>
      <button
        type="button" className="i2-more" aria-label={`Manage ${row.name}`}
        aria-expanded={menu} aria-haspopup="menu"
        onClick={() => { onConfirmDelete(null); setMenu((v) => !v); }}
      >⋯</button>
      {menu && !confirmingDelete && (
        <ul className="i2-menu" role="menu">
          <li role="none">
            <button type="button" role="menuitem" onClick={() => {
              setMenu(false);
              port.setArchived(row.id, !row.archived);
              port.toast(row.archived ? 'Unarchived' : 'Archived');
            }}>{row.archived ? 'Unarchive' : 'Archive'}</button>
          </li>
          <li role="none">
            <button type="button" role="menuitem"
              onClick={() => { setMenu(false); port.exportChat(row.id); }}>Export chat</button>
          </li>
          {row.blockable && (
            <li role="none">
              <button type="button" role="menuitem" className="i2-danger"
                onClick={() => { setMenu(false); port.blockPeer(row.id); }}>Block {row.name}</button>
            </li>
          )}
          <li role="none">
            <button type="button" role="menuitem" className="i2-danger"
              onClick={() => { setMenu(false); onConfirmDelete(row.id); }}>Delete conversation</button>
          </li>
        </ul>
      )}
      {confirmingDelete && (
        <div className="i2-confirm" role="alertdialog" aria-label="Confirm delete">
          <p>Delete your chat with {row.name}? Messages on this device are removed.</p>
          <div className="i2-reqBtns">
            <button type="button" className="i2-cancel" onClick={() => onConfirmDelete(null)}>Cancel</button>
            <button type="button" className="i2-pill i2-dangerPill" onClick={() => {
              onConfirmDelete(null);
              port.deleteConvo(row.id);
              port.toast('Conversation deleted');
            }}>Delete</button>
          </div>
        </div>
      )}
    </li>
  );
}

export function InboxShell({ port }: { port: InboxPort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const [tab, setTab] = useState<InboxTab>('chats');
  const [query, setQuery] = useState('');
  const [archivedMode, setArchivedMode] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [request, setRequest] = useState<UserMatch | null>(null);
  const [results, setResults] = useState<UserMatch[] | null>(null); // null = dropdown closed
  const [deleting, setDeleting] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  /* Registry lookup, debounced; a newer query invalidates in-flight results. */
  useEffect(() => {
    const mine = ++seq.current;
    setResults(null);
    const uname = usernameQuery(query);
    if (!uname) return;
    const t = setTimeout(async () => {
      const matches = await port.searchUsers(uname);
      if (seq.current === mine) setResults(matches);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, port]);

  const needle = query.trim().toLowerCase();
  const matchesQuery = (r: ConvoRowView) =>
    !needle || r.name.toLowerCase().includes(needle) || r.preview.toLowerCase().includes(needle);

  const shown = archivedMode
    ? snap.rows.filter((r) => r.archived && matchesQuery(r))
    : snap.rows.filter((r) => !r.archived && matchesQuery(r) && (tab === 'chats' || r.tab === tab));

  const counts: Record<InboxTab, number> = { chats: 0, nearby: 0, bt: 0 };
  for (const r of snap.rows) if (!r.archived) counts[r.tab] += r.unread;
  const archivedCount = snap.rows.filter((r) => r.archived).length;

  const pickResult = (match: UserMatch) => {
    setResults(null);
    const dm = port.existingDm(match.id);
    if (dm) { port.openThread(dm); return; }
    setRequest(match);
  };

  const empty = () => {
    if (archivedMode) return <div className="i2-empty"><span>No archived chats.</span></div>;
    if (needle) return <div className="i2-empty"><span>{`No matches for "${query.trim()}"`}</span></div>;
    const copy = EMPTY_COPY[tab];
    return (
      <div className="i2-empty">
        <span>{copy.text}</span>
        <button type="button" className="i2-pill" onClick={() => port.nav(copy.nav)}>{copy.btn}</button>
      </div>
    );
  };

  return (
    <div className="i2-screen">
      <div className="i2-bar">
        <button type="button" className="i2-me" aria-label="My profile" onClick={() => port.nav('#/settings')}>
          <Disc name={snap.me.name} url={snap.me.avatarUrl} size={34} />
        </button>
        <span className="i2-sp" />
        <span className="i2-wm">Spot Me</span>
        <span className="i2-sp" />
        <button type="button" className="i2-plus" aria-label="New chat" onClick={() => setSheet(true)}>+</button>
      </div>

      <label className="i2-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON_SEARCH} /></svg>
        <span className="i2-vh">Search users</span>
        <input
          ref={searchRef} type="text" placeholder="Search users..." autoComplete="off"
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        {results !== null && (
          <div className="i2-udrop">
            {results.length === 0
              ? <div className="i2-uEmpty">No one found</div>
              : results.map((m) => (
                <button key={m.id} type="button" className="i2-uRow" onClick={() => pickResult(m)}>
                  <Disc name={m.name || m.username} url={null} size={38} online={m.online} />
                  <span className="i2-uW"><b>@{m.username}</b><span>{m.name}</span></span>
                </button>
              ))}
          </div>
        )}
      </label>

      {archivedMode ? (
        <div className="i2-archHead">
          <button type="button" onClick={() => setArchivedMode(false)}>← Archived</button>
        </div>
      ) : (
        <>
          {archivedCount > 0 && (
            <button type="button" className="i2-archRow" onClick={() => setArchivedMode(true)}>
              <span>Archived</span>
              <span className="i2-apCount">{archivedCount}</span>
            </button>
          )}
          <div className="i2-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key} type="button" role="tab" className="i2-tb"
                aria-selected={t.key === tab} onClick={() => setTab(t.key)}
              >
                {t.label}
                {counts[t.key] > 0 && <span className="i2-tbCt">{badge(counts[t.key])}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="i2-body">
        <h2 className="i2-h2">{archivedMode ? 'Archived' : TABS.find((t) => t.key === tab)?.label}</h2>
        {!archivedMode && tab === 'bt' && (
          <button type="button" className="i2-pill i2-btscan" onClick={() => port.nav('#/bluetooth')}>
            Scan for people nearby
          </button>
        )}
        {shown.length === 0 ? empty() : (
          <ul className="i2-list">
            {shown.map((r) => (
              <Row
                key={r.id} row={r} port={port}
                confirmingDelete={deleting === r.id} onConfirmDelete={setDeleting}
              />
            ))}
          </ul>
        )}
      </div>

      {sheet && (
        <NewChatSheet
          port={port}
          onClose={() => setSheet(false)}
          onArchived={() => setArchivedMode(true)}
          onSearchFocus={() => searchRef.current?.focus()}
        />
      )}
      {request && <RequestSheet match={request} port={port} onClose={() => setRequest(null)} />}
    </div>
  );
}
