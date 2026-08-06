/**
 * Nearby Moments shell (Phase 5D) — renders the controller's state through the
 * pure components. Inert: fixtures only, no routing/auth/backend. NOT deployed
 * and NOT mounted by App (the 5E fence asserts this).
 */

import type { MomentsController, MomentsState } from './controller';
import type { MomentFeedMode } from './ports';
import { MomentCard, StoriesRail, VirtualList, VisibilityControl, LocationExplanation } from './components';

const MODES: MomentFeedMode[] = ['nearby', 'friends', 'city'];

export function MomentsShell(p: { controller: MomentsController; state: MomentsState; rerender(): void }) {
  const c = p.controller;
  const d = c.draft;

  return (
    <main className="mo-shell" aria-label="Nearby Moments">
      <h1>Moments</h1>

      <div role="tablist" aria-label="Feed" className="mo-tabs">
        {MODES.map((m) => (
          <button key={m} role="tab" className="mo-touch"
            aria-selected={p.state.kind === 'feed' && p.state.mode === m}
            onClick={() => void c.loadFeed(m).then(p.rerender)}>
            {m}
          </button>
        ))}
      </div>

      <StoriesRail stories={c.stories} />

      {/* ----- composer ----- */}
      <section aria-label="Compose" className="mo-composer">
        <label>What's happening nearby?
          <textarea value={d.text} maxLength={4000}
            onChange={(e) => { d.text = e.target.value; if (d.media.length === 0) d.kind = 'text'; p.rerender(); }} />
        </label>
        <button className="mo-touch" onClick={() => void c.pickFromLibrary().then(p.rerender)}>Add from library</button>
        {d.media.map((m) => <span key={m.mediaId} className="mo-note">{m.name}</span>)}
        <VisibilityControl value={d.visibility} onChange={(v) => { c.setVisibility(v); p.rerender(); }} />
        {(d.visibility === 'nearby' || d.visibility === 'public') && !d.location && !d.explainingLocation && (
          <button className="mo-touch" onClick={() => { c.requestLocationAttach(); p.rerender(); }}>Attach location…</button>
        )}
        {d.explainingLocation && (
          <LocationExplanation
            onConfirm={() => void c.confirmLocationAttach().then(p.rerender)}
            onCancel={() => { c.cancelLocationAttach(); p.rerender(); }}
          />
        )}
        {d.location && <p className="mo-area" role="status">Approximate area attached ({d.location.cell ?? 'coarse cell'}) — never your exact position.</p>}
        {c.actionError && <p className="mo-error" role="alert">{c.actionError}</p>}
        <button className="mo-touch mo-primary" onClick={() => void c.publish().then(p.rerender)}>Post</button>
      </section>

      {/* ----- states ----- */}
      {p.state.kind === 'loading' && <p role="status">Loading…</p>}
      {p.state.kind === 'permission-required' && <p role="alert">Location permission is required for the nearby and city feeds.</p>}
      {p.state.kind === 'location-unavailable' && <p role="alert">Location unavailable — {p.state.reason}.</p>}
      {p.state.kind === 'offline' && <p role="status">You appear to be offline. Try again when connected.</p>}
      {p.state.kind === 'unavailable' && <p role="status">Moments are temporarily unavailable.</p>}
      {p.state.kind === 'empty' && <p role="status">Nothing here yet — be the first to post.</p>}
      {p.state.kind === 'failed' && <p role="alert">{p.state.message}</p>}

      {/* ----- virtualized feed ----- */}
      {p.state.kind === 'feed' && (
        <VirtualList
          items={[...p.state.page.results]}
          itemHeight={320}
          viewportHeight={640}
          renderItem={(m) => (
            <MomentCard
              key={m.id}
              moment={m}
              onReact={(r) => void c.react(m.id, r).then(p.rerender)}
              onReport={() => void c.report('moment', m.id, 'spam')}
              onBlock={() => void c.block(m.author.userId).then(p.rerender)}
              onHide={() => void c.hide(m.id).then(p.rerender)}
            />
          )}
        />
      )}
    </main>
  );
}
