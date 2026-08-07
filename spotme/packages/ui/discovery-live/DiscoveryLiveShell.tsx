/**
 * Discovery LIVE — React screen (slice 5, behind spotme.ui.discovery).
 *
 * Prop-driven off a DiscoveryLivePort; nothing here fetches, geolocates,
 * stores, or routes. The map area is the locked design's drawn street plan
 * with radar rings — the same rendering the legacy view uses offline. The
 * live Google map stays a legacy-only feature: loading an external Maps
 * script from this package would breach its isolation fence, and the drawn
 * radar is already the design's canonical fallback.
 *
 * PRIVACY: markers are positioned from RELATIVE metre offsets supplied by
 * the port (derived from the coarse broadcast). No coordinates exist here.
 */
import './discovery-live.css';
import { useState, useSyncExternalStore } from 'react';
import type { DiscoveryLivePort, DiscoveryPeerView } from './ports';

const RANGE_OPTS = [5, 10, 25, 50, 100, 200, 500];
const AGE_BUCKETS: Record<string, [number, number] | null> = {
  all: null, '18-24': [18, 24], '25-34': [25, 34], '35+': [35, 200],
};
const RING_F = [0.29, 0.53, 0.77, 1];
const OUTER_PX = 98;

/* Street plan lifted from the locked design (same SVG as the legacy view). */
const PLAN_SVG = `
<svg viewBox="0 0 372 268" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <rect width="372" height="268" fill="#eceef2"/>
  <rect x="0" y="188" width="104" height="80" fill="#dfeede"/>
  <rect x="286" y="0" width="86" height="66" fill="#d6e4f0"/>
  <g stroke="#ffffff" stroke-linecap="square">
    <path d="M0 62h372M0 132h372M0 206h372" stroke-width="15"/>
    <path d="M58 0v268M148 0v268M232 0v268M312 0v268" stroke-width="13"/>
    <path d="M0 96h372M0 168h372" stroke-width="7"/>
    <path d="M104 0v268M196 0v268M272 0v268" stroke-width="6"/>
  </g>
  <path d="M-10 152 L120 148 L196 108 L300 104 L382 70" stroke="#c3cdf0"
        stroke-width="11" fill="none" stroke-linecap="round"/>
</svg>`;

export function Disc({ name, url, size, dot }: {
  name: string; url: string | null; size: number; dot?: boolean;
}) {
  return (
    <span className="dl-disc" style={{ width: size, height: size }} aria-hidden="true">
      {url
        ? <img src={url} alt="" width={size} height={size} />
        : <span className="dl-disc-initial">{(name || '?').slice(0, 1).toUpperCase()}</span>}
      {dot && <i className="dl-dot" />}
    </span>
  );
}

/** Clamp a metre offset onto the radar; range maps to the outer ring. */
function markerXY(offsetM: { x: number; y: number }, rangeM: number) {
  const scale = OUTER_PX / Math.max(rangeM, 1);
  let x = offsetM.x * scale;
  let y = -offsetM.y * scale;
  const r = Math.hypot(x, y);
  if (r > OUTER_PX) { x = (x / r) * OUTER_PX; y = (y / r) * OUTER_PX; }
  return { x, y };
}

function Radar({ peers, rangeM, visible, located, onPick, onLocate }: {
  peers: DiscoveryPeerView[]; rangeM: number; visible: boolean; located: boolean;
  onPick: (p: DiscoveryPeerView) => void; onLocate: () => void;
}) {
  return (
    <div className={`dl-map${visible ? '' : ' dl-hiddenmode'}`}>
      <div className="dl-plan" dangerouslySetInnerHTML={{ __html: PLAN_SVG }} />
      <div className="dl-rings" aria-hidden="true">
        {RING_F.map((f) => (
          <i key={f} style={{ width: OUTER_PX * 2 * f, height: OUTER_PX * 2 * f }} />
        ))}
      </div>
      <div className="dl-sweep" aria-hidden="true" />
      <div className="dl-you" aria-hidden="true" />
      {peers.map((p) => {
        if (!p.offsetM) return null;
        const { x, y } = markerXY(p.offsetM, rangeM);
        return (
          <button
            key={p.id} type="button" className="dl-mk"
            style={{ left: `calc(50% + ${x.toFixed(1)}px)`, top: `calc(50% + ${y.toFixed(1)}px)` }}
            aria-label={p.distLabel ? `${p.name}, ${p.distLabel} away` : p.name}
            onClick={() => onPick(p)}
          >
            <Disc name={p.name} url={p.avatarUrl} size={42} />
          </button>
        );
      })}
      <span className="dl-count"><i />{peers.length} nearby</span>
      <button type="button" className="dl-mb" aria-label="Update my position" onClick={onLocate}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" /><circle cx="12" cy="12" r="8" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></svg>
      </button>
      {!located && <span className="dl-locchip">Location off — distances approximate</span>}
      {!visible && <span className="dl-hidechip">HIDDEN FROM MAP</span>}
    </div>
  );
}

function ProfileCard({ peer, myLangLabel, port, onClose }: {
  peer: DiscoveryPeerView; myLangLabel: string; port: DiscoveryLivePort; onClose: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const send = () => { port.sendRequest(peer.id, text.trim()); onClose(); };
  return (
    <div className="dl-ov" role="dialog" aria-label={peer.name}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dl-pcard">
        <Disc name={peer.name} url={peer.avatarUrl} size={76} dot />
        <b className="dl-pname">{peer.age ? `${peer.name} · ${peer.age}` : peer.name}</b>
        <span className="dl-plang">{peer.langLabel} → {myLangLabel}</span>
        {peer.distLabel && <span className="dl-dpill">{peer.distLabel}</span>}
        {peer.tags.length > 0 && (
          <div className="dl-tags">{peer.tags.map((t) => <span key={t}>{t}</span>)}</div>
        )}
        {peer.hasChat ? (
          <div className="dl-pacts">
            <span className="dl-plang">Connected</span>
            <button type="button" className="dl-pill" onClick={() => { onClose(); port.openChat(peer.id); }}>
              Open chat
            </button>
          </div>
        ) : asking ? (
          <div className="dl-ask">
            <input
              type="text" placeholder="Say hi — any language" maxLength={300} autoFocus
              value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            />
            <button type="button" className="dl-pill" onClick={send}>Start chat</button>
          </div>
        ) : (
          <div className="dl-pacts">
            <button type="button" className="dl-wave" onClick={() => { port.wave(peer.id); onClose(); }}>
              {'\u{1F44B}'} Wave
            </button>
            <button type="button" className="dl-pill" onClick={() => setAsking(true)}>Message</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DiscoveryLiveShell({ port }: { port: DiscoveryLivePort }) {
  const snap = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const [ageFilter, setAgeFilter] = useState('all');
  const [picked, setPicked] = useState<string | null>(null);

  const bucket = AGE_BUCKETS[ageFilter];
  const shown = snap.peers
    .filter((p) => !bucket || p.age == null || (p.age >= bucket[0] && p.age <= bucket[1]))
    .filter((p) => p.distM == null || p.distM <= snap.rangeM)
    .slice()
    .sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity));
  const pickedPeer = picked ? shown.find((p) => p.id === picked) ?? null : null;
  const rangeOpts = RANGE_OPTS.includes(snap.rangeM)
    ? RANGE_OPTS
    : [...RANGE_OPTS, snap.rangeM].sort((a, b) => a - b);

  return (
    <div className="dl-screen">
      <div className="dl-bar">
        <Disc name={snap.me.name} url={snap.me.avatarUrl} size={34} />
        <h1>Discovery</h1>
        <button
          type="button" className="dl-ghost" aria-pressed={snap.visible}
          aria-label="Show me on the map" onClick={() => port.setVisible(!snap.visible)}
        >
          <span>{snap.visible ? 'Visible' : 'Hidden'}</span>
          <span className="dl-sw" aria-hidden="true" />
        </button>
      </div>
      <Radar
        peers={shown} rangeM={snap.rangeM} visible={snap.visible} located={snap.located}
        onPick={(p) => setPicked(p.id)} onLocate={port.locate}
      />
      <div className="dl-chips">
        <label className="dl-chip"><b>Distance</b>
          <select
            aria-label="Distance filter" value={String(snap.rangeM)}
            onChange={(e) => port.setRange(Number(e.target.value))}
          >
            {rangeOpts.map((m) => <option key={m} value={String(m)}>{m} m</option>)}
          </select>
        </label>
        <label className="dl-chip"><b>Age</b>
          <select aria-label="Age filter" value={ageFilter} onChange={(e) => setAgeFilter(e.target.value)}>
            {Object.keys(AGE_BUCKETS).map((v) => (
              <option key={v} value={v}>{v === 'all' ? 'All' : v.replace('-', '–')}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="dl-lhead"><h2>Nearby Users</h2><span>· {shown.length}</span></div>
      <div className="dl-list">
        {shown.length === 0 ? (
          <p className="dl-empty">
            {snap.peers.length > 0
              ? 'Nobody within this radius. Widen the distance to see more.'
              : 'No one nearby yet. Keep this screen open — people appear the moment they come online.'}
          </p>
        ) : shown.map((p) => (
          <div key={p.id} className="dl-row">
            <button type="button" className="dl-open" onClick={() => setPicked(p.id)}>
              <Disc name={p.name} url={p.avatarUrl} size={48} dot />
              <span className="dl-mid">
                <b>{p.name}</b>
                <span className="dl-st">{p.langLabel} → {snap.myLangLabel} · online now</span>
              </span>
              {p.distLabel && <span className="dl-dpill">{p.distLabel}</span>}
            </button>
            <button
              type="button" className="dl-pill dl-mini"
              onClick={() => (p.hasChat ? port.openChat(p.id) : setPicked(p.id))}
            >
              Message
            </button>
          </div>
        ))}
      </div>
      {pickedPeer && (
        <ProfileCard
          peer={pickedPeer} myLangLabel={snap.myLangLabel} port={port}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}
