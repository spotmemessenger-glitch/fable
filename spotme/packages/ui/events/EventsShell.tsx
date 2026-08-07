/**
 * Live Nearby Events shell (Phase 4C) — renders the controller's state through
 * the pure components. Inert: fixtures only, no routing/auth/backend. NOT
 * deployed and NOT mounted by App (the 4D fence asserts this).
 */

import type { EventsController, EventsState } from './controller';
import { CategoryPicker, EventCard, EventDetail } from './components';

const CATEGORIES = ['music', 'nightlife', 'arts', 'theatre', 'film', 'food', 'sports', 'community', 'family', 'education', 'festival'];

export function EventsShell(p: {
  controller: EventsController;
  state: EventsState;
  rerender(): void;
}) {
  const c = p.controller;

  return (
    <main className="ev-shell" aria-label="Live Nearby Events">
      <h1>Nearby events</h1>

      <div className="ev-controls">
        <CategoryPicker categories={CATEGORIES} value={c.category} onChange={(cat) => { c.category = cat; void c.browse({ category: cat }).then(p.rerender); }} />
        <button className="ev-touch ev-primary" onClick={() => void c.browse().then(p.rerender)}>Find events</button>
      </div>

      {p.state.kind === 'locating' && <p role="status">Finding events near you…</p>}
      {p.state.kind === 'permission-required' && <p role="alert">Location permission is required to find nearby events.</p>}
      {p.state.kind === 'location-unavailable' && <p role="alert">Location unavailable — {p.state.reason}.</p>}
      {p.state.kind === 'offline' && <p role="status">You appear to be offline. Try again when connected.</p>}
      {p.state.kind === 'unavailable' && <p role="status">Nearby events are temporarily unavailable.</p>}
      {p.state.kind === 'empty' && <p role="status">Nothing on nearby right now — check back later.</p>}
      {p.state.kind === 'failed' && <p role="alert">{p.state.message}</p>}
      {c.actionError && <p className="ev-error" role="alert">{c.actionError}</p>}

      {p.state.kind === 'browsing' && (
        <section aria-label="Results">
          {p.state.page.results.map((e) => (
            <EventCard
              key={e.id}
              event={e}
              onOpen={() => void c.openDetail(e.id).then(p.rerender)}
              onToggleSave={() => void c.toggleSave(e.id).then(p.rerender)}
            />
          ))}
        </section>
      )}

      {p.state.kind === 'detail' && (
        <EventDetail
          event={p.state.event}
          onBack={() => void c.browse().then(p.rerender)}
          onToggleSave={() => void c.toggleSave((p.state as { event: { id: string } }).event.id).then(p.rerender)}
        />
      )}
    </main>
  );
}
