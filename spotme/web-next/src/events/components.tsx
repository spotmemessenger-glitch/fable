/**
 * Live Nearby Events UI components (Phase 4C) — pure, prop-driven, accessible.
 * No fetch, no state beyond local control; the controller owns application state.
 * A11y at the Phase 2 bar: semantic HTML, labels, 44px targets, visible focus,
 * keyboard operability. No age/gender control exists anywhere (A3).
 */

import type { EventView, EventMapMarker } from './ports';

const STATE_LABEL: Record<EventView['state'], string> = {
  'upcoming': 'Upcoming',
  'happening-now': 'Happening now',
  'ended': 'Ended',
  'cancelled': 'Cancelled',
  'postponed': 'Postponed',
};

/* ------------------------------------------------------------ ranking why */

export function RankingWhy(props: { ranking: EventView['ranking'] }) {
  const r = props.ranking;
  return (
    <details className="ev-why">
      <summary>Why this ranking</summary>
      <ul>
        {r.components.map((c) => (
          <li key={c.signal}>{c.signal}: {c.value.toFixed(2)} × {c.weight.toFixed(2)} = {c.weighted.toFixed(3)}</li>
        ))}
        {r.omittedSignals.map((s) => (
          <li key={s} className="ev-omitted">{s}: not provided by the source — omitted</li>
        ))}
        <li><strong>total {r.total.toFixed(3)}</strong></li>
      </ul>
    </details>
  );
}

/* -------------------------------------------------------------- event card */

export function EventCard(props: {
  event: EventView;
  onOpen?(): void;
  onToggleSave?(): void;
}) {
  const e = props.event;
  return (
    <article className="ev-card" aria-label={`${e.title} — ${STATE_LABEL[e.state]}`}>
      <header>
        <strong>{e.title}</strong>
        <span className={`ev-state ev-state-${e.state}`}>{STATE_LABEL[e.state]}</span>
      </header>
      <p className="ev-cat">{e.category}{e.distanceBand ? ` · ${e.distanceBand}` : ''}</p>
      {e.description && <p>{e.description}</p>}

      {(e.state === 'cancelled' || e.state === 'postponed') && e.source.provenance && (
        <p className="ev-provenance" role="status">
          {STATE_LABEL[e.state]} — per {e.source.provenance.assertedBy}{e.source.provenance.note ? `: ${e.source.provenance.note}` : ''}
        </p>
      )}

      <p className="ev-pop">
        {typeof e.popularity === 'number'
          ? <>Popularity {(e.popularity * 100).toFixed(0)}% <span className="ev-note">· as reported by the source</span></>
          : <span className="ev-note">Popularity not provided by the source</span>}
      </p>

      <p className="ev-source">
        Source: {e.source.sourceName ?? e.source.provider}
        {e.source.url && <> · <a href={e.source.url} rel="noreferrer noopener" target="_blank">listing</a></>}
        {typeof e.source.confidence === 'number' && <span className="ev-note"> · confidence {(e.source.confidence * 100).toFixed(0)}%</span>}
      </p>
      <p className="ev-area">Approximate venue area only</p>

      <RankingWhy ranking={e.ranking} />

      <footer>
        {props.onOpen && <button className="ev-touch" onClick={props.onOpen}>Details</button>}
        {props.onToggleSave && (
          <button className="ev-touch" aria-pressed={e.saved === true} onClick={props.onToggleSave}>
            {e.saved ? 'Saved' : 'Save'}
          </button>
        )}
        <a
          className="ev-touch ev-maps"
          href={`geo:${e.venue.lat},${e.venue.lon}`}
          aria-label={`Open ${e.title} venue in maps (approximate area)`}
        >
          Open in maps
        </a>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------ event detail */

export function EventDetail(props: { event: EventView; onBack?(): void; onToggleSave?(): void }) {
  const e = props.event;
  return (
    <section className="ev-detail" aria-label={`Event: ${e.title}`}>
      {props.onBack && <button className="ev-touch" onClick={props.onBack}>← Back</button>}
      <h2>{e.title}</h2>
      <p className={`ev-state ev-state-${e.state}`}>{STATE_LABEL[e.state]}</p>
      {e.description && <p>{e.description}</p>}
      {(e.state === 'cancelled' || e.state === 'postponed') && e.source.provenance && (
        <p className="ev-provenance" role="status">
          {STATE_LABEL[e.state]} — per {e.source.provenance.assertedBy}{e.source.provenance.note ? `: ${e.source.provenance.note}` : ''}
        </p>
      )}
      <p className="ev-area">Approximate venue area only</p>
      <EventCardMeta event={e} />
      <RankingWhy ranking={e.ranking} />
      {props.onToggleSave && (
        <button className="ev-touch ev-primary" aria-pressed={e.saved === true} onClick={props.onToggleSave}>
          {e.saved ? 'Saved' : 'Save'}
        </button>
      )}
    </section>
  );
}

function EventCardMeta(props: { event: EventView }) {
  const e = props.event;
  return (
    <dl className="ev-meta">
      <dt>Category</dt><dd>{e.category}</dd>
      {e.distanceBand && (<><dt>Distance</dt><dd>{e.distanceBand}</dd></>)}
      <dt>Source</dt><dd>{e.source.sourceName ?? e.source.provider}</dd>
    </dl>
  );
}

/* --------------------------------------------------------------- controls */

export function CategoryPicker(props: { categories: readonly string[]; value?: string; onChange(v: string | undefined): void }) {
  return (
    <label>Filter category
      <select aria-label="Filter category" value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value || undefined)}>
        <option value="">any</option>
        {props.categories.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
  );
}

/** Pure marker projection for a map surface (no user data; venue is public). */
export function eventMapMarker(e: EventView): EventMapMarker {
  return { id: e.id, lat: e.venue.lat, lon: e.venue.lon, title: e.title, state: e.state, category: e.category };
}
