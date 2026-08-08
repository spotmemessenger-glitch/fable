/**
 * Profile & Settings — React screen (slice 4, behind spotme.ui.profile).
 *
 * Prop-driven off a ProfilePort; nothing here fetches, stores, or routes.
 * Copy and section order mirror the legacy view (locked design 2026-07-24).
 * One deliberate divergence: inline name editing becomes the Name field
 * sheet — one editor per field, keyboard-reachable (DoD #7).
 */
import './profile.css';
import { useState, useSyncExternalStore } from 'react';
import type { EditableFieldKey, ProfilePort, ToggleKey } from './ports';
import { FieldSheet, LangSheet, UsernameSheet } from './sheets';

/* Simple stroke icons, drawn from the legacy set. */
const ICON: Record<string, string> = {
  cam: 'M3 8.5h3.2l1.4-2.2h8.8L17.8 8.5H21a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1zM15.4 13.5a3.4 3.4 0 11-6.8 0 3.4 3.4 0 016.8 0z',
  map: 'M9 3L3 5.5v16L9 19l6 2.5 6-2.5v-16L15 5.5 9 3zM9 3v16M15 5.5v16',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18',
  checks: 'M2 12l5 5L13 8M11 15l3 3 8-10',
  translit: 'M4 7V5h16v2M9 19h6M12 5v14',
  speaker: 'M11 5L6 9H3v6h3l5 4V5zM16 9a4 4 0 010 6M19 6.5a8 8 0 010 11',
  people: 'M2.6 19.4a5.8 5.8 0 0111.6 0M15 19.4a4.6 4.6 0 016.4-3.6M11.5 9a3.1 3.1 0 11-6.2 0 3.1 3.1 0 016.2 0zM19 10.2a2.4 2.4 0 11-4.8 0 2.4 2.4 0 014.8 0z',
  link: 'M10 14a5 5 0 007.07 0l2.12-2.12a5 5 0 00-7.07-7.07L11 5.93M14 10a5 5 0 00-7.07 0l-2.12 2.12a5 5 0 007.07 7.07L13 18.07',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M10 11v6M14 11v6',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
  blur: 'M12 3.5s6.5 7 6.5 11a6.5 6.5 0 11-13 0c0-4 6.5-11 6.5-11z',
  mic: 'M9 3h6v11H9zM5 11a7 7 0 0014 0M12 18v3',
  chev: 'M9 18l6-6-6-6',
};

function Icon({ d, className = 'p4-ri' }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON[d]} />
    </svg>
  );
}

function Disc({ name, url, size }: { name: string; url: string | null; size: number }) {
  return (
    <span className="p4-disc" style={{ width: size, height: size }} aria-hidden="true">
      {url
        ? <img src={url} alt="" width={size} height={size} />
        : <span className="p4-disc-initial">{(name || '?').slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

function Row({ icon, label, sub, trail, onClick, danger }: {
  icon: string; label: string; sub?: string | null; trail?: React.ReactNode;
  onClick: () => void; danger?: boolean;
}) {
  return (
    <button type="button" className={'p4-row' + (danger ? ' danger' : '')} onClick={onClick}>
      <Icon d={icon} />
      <span className="p4-rl">
        <b>{label}</b>
        {sub && <span className="p4-sub">{sub}</span>}
      </span>
      {trail}
      <Icon d="chev" className="p4-chev" />
    </button>
  );
}

function ToggleRow({ icon, label, sub, on, onFlip }: {
  icon: string; label: string; sub?: string | null; on: boolean; onFlip: (on: boolean) => void;
}) {
  return (
    <button type="button" className="p4-row" role="switch" aria-checked={on} onClick={() => onFlip(!on)}>
      <Icon d={icon} />
      <span className="p4-rl">
        <b>{label}</b>
        {sub && <span className="p4-sub">{sub}</span>}
      </span>
      <span className={'p4-tog' + (on ? ' on' : '')} />
    </button>
  );
}

function Section({ title }: { title: string }) {
  return <div className="p4-sec">{title}</div>;
}

type Sheet =
  | { kind: 'field'; field: EditableFieldKey }
  | { kind: 'username' }
  | { kind: 'lang' }
  | null;

export function ProfileShell({ port }: { port: ProfilePort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);

  const tog = (key: ToggleKey, icon: string, label: string, sub?: string | null) => (
    <ToggleRow icon={icon} label={label} sub={sub} on={snap.toggles[key]}
      onFlip={(on) => port.setToggle(key, on)} />
  );

  const fieldRows: Array<{ key: string; label: string; value: string; empty: string; open: () => void }> = [
    { key: 'name', label: 'Name', value: snap.raw.name, empty: 'Add your name', open: () => setSheet({ kind: 'field', field: 'name' }) },
    { key: 'about', label: 'About', value: snap.raw.about, empty: 'Add a line about you', open: () => setSheet({ kind: 'field', field: 'about' }) },
    { key: 'username', label: 'Username', value: snap.raw.username ? '@' + snap.raw.username : '', empty: 'Claim a username', open: () => setSheet({ kind: 'username' }) },
    { key: 'recovery', label: 'Recovery code', value: snap.hasRecovery ? '••••  tap to copy' : '', empty: '—', open: port.copyRecovery },
    { key: 'phone', label: 'Phone number', value: snap.raw.phone, empty: 'Optional', open: () => setSheet({ kind: 'field', field: 'phone' }) },
  ];

  return (
    <div className="p4-screen">
      <div className="p4-top"><h1>Settings</h1></div>
      <div className="p4-body">

        <div className="p4-head">
          <button type="button" className="p4-pav" aria-label="Change photo" onClick={port.changePhoto}>
            <Disc name={snap.me.name} url={snap.me.avatarUrl} size={104} />
            <span className="p4-cam"><Icon d="cam" className="p4-cami" /></span>
          </button>
          <h2 className="p4-name">{snap.me.name}</h2>
        </div>

        <div className="p4-fields">
          {fieldRows.map((f) => (
            <button key={f.key} type="button" className="p4-pfr" onClick={f.open}>
              <span className="p4-pfl">{f.label}</span>
              <span className={'p4-pfv' + (f.value ? '' : ' none')}>{f.value || f.empty}</span>
              {f.key === 'username' && Boolean(f.value) && (
                <span className="p4-copy" role="button" tabIndex={0} aria-label="Copy my username"
                  onClick={(e) => { e.stopPropagation(); port.copyUsername(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); port.copyUsername(); } }}
                >⧉</span>
              )}
              <Icon d="chev" className="p4-chev" />
            </button>
          ))}
        </div>

        <Section title="My voice" />
        {snap.voice.hasVoice ? (
          <div className="p4-row static">
            <Icon d="mic" />
            <span className="p4-rl">
              <b>{`Your voice — created ${snap.voice.createdLabel}`}</b>
              <span className="p4-sub">One voice per profile. Delete it to record a new one.</span>
            </span>
            <button type="button" className="p4-del" onClick={port.deleteVoice}>Delete voice</button>
          </div>
        ) : (
          <Row icon="mic" label="Create my voice"
            sub="Record a 30-second sample so voice notes can speak in your own voice."
            onClick={port.createVoice} />
        )}

        <Section title="Safety & visibility" />
        {tog('showOnMap', 'map', 'Show me on the map', 'Off is ghost mode: you can see others, they cannot see you.')}
        <Row icon="eye" label="Last seen & online"
          sub="Cooperative: standard apps honour this; connection status is inherently visible in P2P."
          trail={<span className="p4-val">{snap.lastSeenLabel}</span>}
          onClick={port.openLastSeen} />
        {tog('appBlur', 'blur', 'Blur app preview in the app switcher', 'Hides your chats when you switch apps.')}

        <Section title="Notifications" />
        <Row icon="checks" label="Show notifications"
          sub="In your phone's notification tray when the app is in the background."
          trail={<span className="p4-val">{snap.notifLabel}</span>}
          onClick={port.askNotify} />
        {tog('sound', 'speaker', 'Alert sound', 'A short tone when a message arrives in a chat you are not reading.')}
        {tog('vibrate', 'blur', 'Vibrate', 'Where the device supports it.')}
        <div className="p4-note">
          {'“On · closed-app alerts” means this device can be woken when a message arrives. '
            + 'The alert only ever says that something arrived, never what it said — the server '
            + 'cannot read your messages. Plain “On” means push is not set up for this device, '
            + 'so Spot Me has to be open for you to be told.'}
        </div>

        <Section title="Language & translation" />
        <Row icon="globe" label="Your language"
          trail={<span className="p4-val">{snap.langLabel}</span>}
          onClick={() => setSheet({ kind: 'lang' })} />
        <div className="p4-note">Messages from other languages translate into this one.</div>
        {tog('autoTranslate', 'checks', 'Auto-translate incoming messages')}
        {tog('translit', 'translit', 'Transliteration', 'Type in English, send in your script.')}
        {tog('readAloud', 'speaker', 'Read messages aloud')}

        <Section title="Practice" />
        {tog('demoMode', 'people', 'Demo people', 'Practice contacts so you can try every feature alone.')}

        <Section title="What is actually private" />
        <div className="p4-pcard">
          <ul>
            <li>Messages travel device-to-device, encrypted (WebRTC DTLS + room secret). No server stores them.</li>
            <li>Finding peers uses public BitTorrent trackers — who is looking for whom can be observed. Content cannot.</li>
            <li>View-once, timers and delete-for-everyone are cooperative — a modified app could keep copies. That is true of every messenger.</li>
            <li>When on-device translation is unavailable a cloud fallback is used, and labelled “cloud” in the chat.</li>
          </ul>
        </div>

        <Section title="Blocked people" />
        {snap.blocked.length === 0 ? (
          <div className="p4-empty">Nobody blocked</div>
        ) : (
          snap.blocked.map((p) => (
            <div key={p.id} className="p4-brow">
              <Disc name={p.name} url={p.avatarUrl} size={36} />
              <span className="p4-bname">{p.name || 'Unknown'}</span>
              <button type="button" className="p4-pill ok" onClick={() => port.unblock(p.id)}>Unblock</button>
            </div>
          ))
        )}

        <Section title="Invite" />
        <div className="p4-vcard">
          <div className="p4-vtop">
            <Icon d="link" className="p4-vic" />
            <span className="p4-vtx">
              <b>Chat with a friend anywhere</b>
              <span>Send a link that opens a private room between just the two of you.</span>
            </span>
          </div>
          <button type="button" className="p4-vbtn" onClick={port.invite}>Create invite link</button>
        </div>

        <Section title="Danger zone" />
        <Row icon="trash" label="Clear all data" onClick={port.clearAll} danger />

        <div className="p4-foot">Spot Me · P2P over WebRTC · locked design 2026-07-24</div>
      </div>

      {sheet?.kind === 'field' && (
        <FieldSheet field={sheet.field} value={snap.raw[sheet.field]} port={port} onClose={close} />
      )}
      {sheet?.kind === 'username' && (
        <UsernameSheet current={snap.raw.username} port={port} onClose={close} />
      )}
      {sheet?.kind === 'lang' && (
        <LangSheet langs={snap.langs} selected={snap.selectedLang}
          onPick={port.setLang} onClose={close} />
      )}
    </div>
  );
}
