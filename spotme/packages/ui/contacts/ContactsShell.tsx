/**
 * Contacts — React screen (slice 2, behind spotme.ui.contacts).
 *
 * Prop-driven off a ContactsPort; nothing here fetches, stores, or routes.
 * One deliberate divergence from the legacy view: the manage menu (Block /
 * Remove) opens from a visible per-row button instead of a long-press —
 * long-press is undiscoverable and has no keyboard path (DoD #7).
 */
import './contacts.css';
import { useState, useSyncExternalStore } from 'react';
import type { ContactsPort, ContactRowView } from './ports';

const ICON_SEARCH = 'M11 4a7 7 0 105.3 11.9l3.2 3.2 1-1-3.2-3.2A7 7 0 0011 4z';

export function Disc({ name, url, size, online }: {
  name: string; url: string | null; size: number; online?: boolean;
}) {
  return (
    <span className="c2-disc" style={{ width: size, height: size }} aria-hidden="true">
      {url
        ? <img src={url} alt="" width={size} height={size} />
        : <span className="c2-disc-initial">{(name || '?').slice(0, 1).toUpperCase()}</span>}
      {online && <i className="c2-dot" />}
    </span>
  );
}

function Row({ contact, port }: { contact: ContactRowView; port: ContactsPort }) {
  const [menu, setMenu] = useState(false);
  return (
    <li className="c2-row">
      <button type="button" className="c2-open" onClick={() => port.openContact(contact.id)}>
        <Disc name={contact.name} url={contact.avatarUrl} size={52} online={contact.online} />
        <span className="c2-mid">
          <b className="c2-nm">{contact.name}</b>
          <span className="c2-chip">{contact.langLabel}</span>
          {contact.online && <span className="c2-vh">online</span>}
        </span>
      </button>
      <button
        type="button" className="c2-more" aria-label={`Manage ${contact.name}`}
        aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((v) => !v)}
      >⋯</button>
      {menu && (
        <ul className="c2-menu" role="menu">
          <li role="none">
            <button type="button" role="menuitem" className="c2-danger"
              onClick={() => { setMenu(false); port.block(contact.id); }}>Block</button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" className="c2-danger"
              onClick={() => { setMenu(false); port.remove(contact.id); }}>Remove contact</button>
          </li>
        </ul>
      )}
    </li>
  );
}

export function ContactsShell({ port }: { port: ContactsPort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = snap.contacts.filter((c) =>
    !needle || c.name.toLowerCase().includes(needle) || c.langLabel.toLowerCase().includes(needle));

  return (
    <div className="c2-screen">
      <div className="c2-bar">
        <span className="c2-sp" />
        <Disc name={snap.me.name} url={snap.me.avatarUrl} size={34} />
      </div>
      <h1 className="c2-h1">Contacts</h1>
      <label className="c2-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON_SEARCH} /></svg>
        <span className="c2-vh">Search contacts</span>
        <input type="text" placeholder="Search contacts..." autoComplete="off"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="c2-body">
        <button type="button" className="c2-invite" onClick={port.invite}>
          <b>Invite a friend by link</b>
          <span>A private room only the two of you can open</span>
        </button>
        {shown.length === 0 ? (
          <div className="c2-empty">
            <p>{needle ? 'No one matches your search.' : 'People you accept appear here.'}</p>
            {!needle && (
              <button type="button" className="c2-pill" onClick={port.openDiscovery}>
                Open Discovery
              </button>
            )}
          </div>
        ) : (
          <ul className="c2-list">
            {shown.map((c) => <Row key={c.id} contact={c} port={port} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
