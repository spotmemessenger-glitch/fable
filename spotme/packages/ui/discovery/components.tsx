/**
 * Discovery UI components (checkpoint 10) — PURE PRESENTATION.
 *
 * Every component is prop-driven: state in, callbacks out. No fetch, no
 * geolocation, no storage, no routing, no auth — the application layer
 * (checkpoint 11) owns behavior; these render it. Accessibility: real
 * buttons/inputs, aria labels, ≥44 px touch targets (discovery.css),
 * reduced-motion respected, fixed-height skeletons (no layout shift).
 *
 * A3/A8: the FilterSheet renders EXACTLY three controls — distance band,
 * category, open-now — and open-now is disabled with a visible "not supported"
 * note unless the current results carry provider hours evidence. No age or
 * gender control exists.
 */

import type {
  DiscoveryFilters,
  DiscoveryResult,
  DiscoveryState,
  DistanceBand,
  NearbyPersonPublic,
  NearbyPlacePublic,
} from '@spotme/contracts';
import { useEffect, useRef, useState } from 'react';

/* ---------------------------------------------------------------- search */

export function SearchBar(props: { value: string; onChange(v: string): void; onSubmit(): void; busy: boolean }) {
  return (
    <form
      className="disc-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <input
        aria-label="Search nearby people, places and usernames"
        placeholder='Try "coffee within 2 km", "people near me", "@username"'
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="submit" className="disc-touch" aria-label="Search" disabled={props.busy}>
        {props.busy ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------ mode toggle */

export type ViewMode = 'map' | 'list' | 'split';

export function ModeToggle(props: { mode: ViewMode; onMode(m: ViewMode): void }) {
  return (
    <div className="disc-modes" role="radiogroup" aria-label="View mode">
      {(['map', 'list', 'split'] as ViewMode[]).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={props.mode === m}
          className={`disc-touch ${props.mode === m ? 'active' : ''}`}
          onClick={() => props.onMode(m)}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ filter sheet */

const BANDS: DistanceBand[] = ['under500m', 'under1km', 'under2km', 'under5km', 'over5km'];

export function FilterSheet(props: {
  filters: DiscoveryFilters;
  categories: string[];
  openNowSupported: boolean;
  onChange(f: DiscoveryFilters): void;
}) {
  const { filters } = props;
  return (
    <fieldset className="disc-filters" aria-label="Filters">
      <legend>Filters</legend>

      <label>
        Distance
        <select
          aria-label="Distance band"
          value={filters.distanceBand ?? ''}
          onChange={(e) =>
            props.onChange({ ...filters, ...(e.target.value ? { distanceBand: e.target.value as DistanceBand } : {}) })
          }
        >
          <option value="">any</option>
          {BANDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      <label>
        Category
        <select
          aria-label="Category"
          value={filters.category ?? ''}
          onChange={(e) => props.onChange({ ...filters, ...(e.target.value ? { category: e.target.value } : {}) })}
        >
          <option value="">any</option>
          {props.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className={props.openNowSupported ? '' : 'disc-unsupported'}>
        <input
          type="checkbox"
          aria-label="Open now (places only)"
          disabled={!props.openNowSupported}
          checked={filters.openNow === true}
          onChange={(e) => props.onChange({ ...filters, ...(e.target.checked ? { openNow: true } : {}) })}
        />
        Open now (places only)
        {!props.openNowSupported && <span className="disc-note"> — not supported by current sources</span>}
      </label>
      {/* A3: deliberately NOTHING else. No age control. No gender control. */}
    </fieldset>
  );
}

/* ------------------------------------------------------------ result cards */

export function PersonCard(props: {
  person: NearbyPersonPublic;
  selected: boolean;
  onSelect(): void;
  onFriendRequest(): void;
  onBlock(): void;
  onReport(): void;
  onHide(): void;
}) {
  const { person } = props;
  const fr = person.friendRequest;
  return (
    <article
      className={`disc-card ${props.selected ? 'selected' : ''}`}
      aria-label={`Nearby person ${person.displayName}`}
      // F7-1: the card is keyboard-operable from the list, not just the map —
      // a real button role, tab stop, aria-pressed, and Enter/Space activation.
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(); } }}
    >
      <header>
        <strong>{person.displayName}</strong>
        {person.handle && <span className="disc-handle">@{person.handle}</span>}
      </header>
      <p className="disc-distance">{person.distanceBand} away</p>
      {person.freshness.stale && <p className="disc-note">may be out of date</p>}
      <footer>
        <button
          className="disc-touch"
          aria-label={`Send friend request to ${person.displayName}`}
          disabled={!fr.canSendRequest || fr.state !== 'none'}
          onClick={(e) => {
            e.stopPropagation();
            props.onFriendRequest();
          }}
        >
          {fr.state === 'none' && 'Friend request'}
          {fr.state === 'pending-sent' && 'Request sent'}
          {fr.state === 'pending-received' && 'Respond to request'}
          {fr.state === 'accepted' && 'Friends — chat available'}
        </button>
        <button className="disc-touch" aria-label="Block" onClick={(e) => { e.stopPropagation(); props.onBlock(); }}>Block</button>
        <button className="disc-touch" aria-label="Report" onClick={(e) => { e.stopPropagation(); props.onReport(); }}>Report</button>
        <button className="disc-touch" aria-label="Hide this result" onClick={(e) => { e.stopPropagation(); props.onHide(); }}>Hide</button>
      </footer>
    </article>
  );
}

export function PlaceCard(props: { place: NearbyPlacePublic; selected: boolean; onSelect(): void; onDirections(): void; onSave(): void }) {
  const { place } = props;
  return (
    <article
      className={`disc-card ${props.selected ? 'selected' : ''}`}
      aria-label={`Place ${place.name}`}
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(); } }}
    >
      <header>
        <strong>{place.name}</strong>
        {place.category && <span className="disc-category">{place.category}</span>}
      </header>
      {typeof place.deviceDistanceM === 'number' && <p className="disc-distance">~{place.deviceDistanceM} m (straight line)</p>}
      {/* A8/P4: open-status ONLY when the source supports it; unknown says nothing. */}
      {place.openNow === true && <p className="disc-open">Open now</p>}
      {place.openNow === false && <p className="disc-closed">Closed</p>}
      <p className="disc-attribution">
        {place.source.kind === 'place-provider' ? `Source: ${place.source.attribution}` : 'Source: Spot Me'}
      </p>
      <footer>
        <button className="disc-touch" aria-label={`Directions to ${place.name}`} onClick={(e) => { e.stopPropagation(); props.onDirections(); }}>Directions</button>
        <button className="disc-touch" aria-label={`Save ${place.name} for later`} onClick={(e) => { e.stopPropagation(); props.onSave(); }}>Save</button>
      </footer>
    </article>
  );
}

/* ------------------------------------------------- virtualized result list */

const ROW_HEIGHT = 132; // fixed row height ⇒ no layout shift while loading

export function ResultList(props: {
  results: readonly DiscoveryResult[];
  selectedId: string | null;
  onSelect(id: string): void;
  onFriendRequest(id: string): void;
  onBlock(id: string): void;
  onReport(id: string): void;
  onHide(id: string): void;
  onDirections(id: string): void;
  onSave(id: string): void;
  viewportRows?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRows = props.viewportRows ?? 6;
  const count = props.results.length;
  // F7-7: clamp scroll to the real maximum so a windowing computation can never
  // exceed the list — a shrunk result set (hide/refresh) or an end-of-list
  // selection would otherwise render blank rows until a native scroll corrects it.
  const maxScroll = Math.max(0, count * ROW_HEIGHT - viewportRows * ROW_HEIGHT);
  const clampedTop = Math.min(scrollTop, maxScroll);
  const start = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(clampedTop / ROW_HEIGHT) - 2));
  const end = Math.min(count, start + viewportRows + 4);
  const visible = props.results.slice(start, end);
  const listRef = useRef<HTMLDivElement>(null);

  // Selection sync: scroll the selected row into the window (stable across
  // refresh). `results` is a dep so a shrinking list re-clamps (F7-7).
  useEffect(() => {
    if (!props.selectedId) return;
    const idx = props.results.findIndex((r) => idOf(r) === props.selectedId);
    if (idx >= 0 && (idx < start || idx >= end)) {
      const target = Math.min(idx * ROW_HEIGHT, maxScroll);
      listRef.current?.scrollTo({ top: target });
      setScrollTop(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId, props.results]);

  return (
    <div
      ref={listRef}
      className="disc-list"
      role="list"
      aria-label="Nearby results"
      style={{ height: viewportRows * ROW_HEIGHT, overflowY: 'auto' }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: props.results.length * ROW_HEIGHT, position: 'relative' }}>
        {visible.map((r, i) => {
          const id = idOf(r);
          return (
            <div
              key={id}
              role="listitem"
              aria-setsize={count}
              aria-posinset={start + i + 1}
              style={{ position: 'absolute', top: (start + i) * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
            >
              {r.type === 'place' ? (
                <PlaceCard
                  place={r.place}
                  selected={props.selectedId === id}
                  onSelect={() => props.onSelect(id)}
                  onDirections={() => props.onDirections(id)}
                  onSave={() => props.onSave(id)}
                />
              ) : (
                <PersonCard
                  person={r.person}
                  selected={props.selectedId === id}
                  onSelect={() => props.onSelect(id)}
                  onFriendRequest={() => props.onFriendRequest(id)}
                  onBlock={() => props.onBlock(id)}
                  onReport={() => props.onReport(id)}
                  onHide={() => props.onHide(id)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function idOf(r: DiscoveryResult): string {
  return r.type === 'place' ? r.place.placeId : r.person.userId;
}

/* ------------------------------------------------------- visibility control */

export function VisibilityControl(props: { enabled: boolean; onToggle(next: boolean): void }) {
  return (
    <section className="disc-visibility" aria-label="Discovery visibility">
      {!props.enabled ? (
        <>
          {/* P3: the explanation is visible BEFORE enabling, not after. */}
          <p className="disc-privacy-explainer" role="note">
            Turning this on shows your <strong>approximate</strong> area (never your exact location) to nearby people
            for 30 minutes. You can turn it off any time with this same switch.
          </p>
          <button className="disc-touch" aria-label="Enable discovery visibility" onClick={() => props.onToggle(true)}>
            Become visible nearby
          </button>
        </>
      ) : (
        <button className="disc-touch disc-visible-on" aria-label="Turn off discovery visibility" onClick={() => props.onToggle(false)}>
          Visible nearby — turn off
        </button>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- state views */

/** Every state renders copy that says WHAT happened and WHAT to do next. */
export function StateBanner(props: { state: DiscoveryState; onRetry(): void; onEnableLocation(): void }) {
  const s = props.state;
  switch (s.kind) {
    case 'idle':
      return <p className="disc-state" role="status">Search nearby people, places and usernames.</p>;
    case 'locating':
      return <p className="disc-state" role="status" aria-busy="true">Finding your area…</p>;
    case 'permission-required':
      return (
        <div className="disc-state" role="alert">
          <p>Location permission is needed to search nearby.</p>
          <button className="disc-touch" onClick={props.onEnableLocation}>Allow location</button>
        </div>
      );
    case 'location-unavailable':
      return (
        <div className="disc-state" role="alert">
          <p>We couldn&apos;t determine your area ({s.reason}).</p>
          <button className="disc-touch" onClick={props.onRetry}>Try again</button>
        </div>
      );
    case 'searching':
      return <SkeletonRows label="Searching nearby…" />;
    case 'partial':
      return <p className="disc-state" role="status">Some sources are still answering ({s.pendingSources.join(', ')})…</p>;
    case 'ready':
      return null;
    case 'empty':
      return (
        <div className="disc-state" role="status">
          <p>Nothing found within {s.radius.km} km.</p>
          {s.suggestion && <p>{s.suggestion}</p>}
          <button className="disc-touch" onClick={props.onRetry}>Search a wider area</button>
        </div>
      );
    case 'provider-unavailable':
      return (
        <div className="disc-state" role="alert">
          <p>Some sources are unavailable right now: {s.providers.join(', ')}. Showing what we have.</p>
          <button className="disc-touch" onClick={props.onRetry}>Retry</button>
        </div>
      );
    case 'offline':
      return (
        <div className="disc-state" role="alert">
          <p>You&apos;re offline.{s.cached ? ' Showing your last results.' : ''}</p>
          <button className="disc-touch" onClick={props.onRetry}>Retry when connected</button>
        </div>
      );
    case 'superseded':
      return null; // a newer search took over; nothing to show for the old one
    case 'failed':
      return (
        <div className="disc-state" role="alert">
          <p>{s.error.message}</p>
          <p>{s.error.nextStep}</p>
          {s.error.retryable && <button className="disc-touch" onClick={props.onRetry}>Retry</button>}
        </div>
      );
  }
}

function SkeletonRows(props: { label: string }) {
  return (
    <div role="status" aria-label={props.label} aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="disc-skeleton" style={{ height: ROW_HEIGHT - 12 }} />
      ))}
    </div>
  );
}
