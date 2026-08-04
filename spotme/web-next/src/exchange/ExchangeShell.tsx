/**
 * Exchange shell (Phase 3D) — renders the controller's state through the pure
 * components. Inert: fixtures only, no routing/auth/backend. NOT deployed.
 */

import { useEffect } from 'react';
import type { ComposeIntentInput } from './ports';
import type { ExchangeController, ExchangeState } from './controller';
import { CategoryPicker, IntentCard, IntentComposer, MatchCard, ModeTabs } from './components';

const CATEGORIES = ['services/plumbing', 'services/tutoring', 'goods/furniture', 'goods/bicycle', 'community/volunteer'];

export function ExchangeShell(p: {
  controller: ExchangeController;
  state: ExchangeState;
  mode: 'compose' | 'browse' | 'mine';
  onMode(m: 'compose' | 'browse' | 'mine'): void;
  rerender(): void;
}) {
  const c = p.controller;
  const busy = p.state.kind === 'submitting' || p.state.kind === 'locating';

  // Entering the "mine" tab loads the principal's own posts (fixture-backed this
  // phase) so the tab is never blank. Runs only on a genuine transition into the
  // tab, not on every render.
  useEffect(() => {
    if (p.mode === 'mine' && p.state.kind !== 'mine') void c.listMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mode]);

  return (
    <main className="ex-shell" aria-label="SpotMe Exchange">
      <h1>Exchange</h1>
      <ModeTabs mode={p.mode} onMode={p.onMode} />

      {p.state.kind === 'permission-required' && <p role="alert">Location permission is required to post to the nearby map.</p>}
      {p.state.kind === 'location-unavailable' && <p role="alert">Location unavailable — {(p.state).reason}.</p>}
      {p.state.kind === 'offline' && <p role="status">You appear to be offline. Your draft is kept; try again when connected.</p>}
      {p.state.kind === 'unavailable' && <p role="status">Nearby results are temporarily unavailable.</p>}
      {p.state.kind === 'empty' && <p role="status">Nothing nearby yet — check back later.</p>}
      {p.state.kind === 'failed' && <p role="alert">{(p.state).message}</p>}

      {p.mode === 'compose' && (
        <>
          <IntentComposer
            draft={c.draft}
            categories={CATEGORIES}
            error={c.actionError}
            busy={busy}
            onChange={(patch: Partial<ComposeIntentInput>) => { Object.assign(c.draft, patch); p.rerender(); }}
            onSubmit={() => void c.publish()}
          />
          {p.state.kind === 'published' && (
            <section aria-label="Published" className="ex-published">
              <p role="status">Published.</p>
              <IntentCard intent={p.state.intent} onMatches={() => void c.openMatches(p.state.kind === 'published' ? p.state.intent.id : '')} />
            </section>
          )}
        </>
      )}

      {p.mode === 'browse' && (
        <>
          <CategoryPicker categories={CATEGORIES} onChange={(cat) => void c.browse(cat ? { category: cat } : {})} />
          {p.state.kind === 'browsing' && p.state.page.results.map((i) => (
            <IntentCard key={i.id} intent={i} onReport={() => void c.report(i.id, 'inappropriate')} onBlock={() => void c.block(i.id)} onMatches={() => void c.openMatches(i.id)} />
          ))}
        </>
      )}

      {p.mode === 'mine' && p.state.kind === 'mine' && (
        <section aria-label="My posts">
          {p.state.page.results.map((i) => (
            <IntentCard
              key={i.id}
              intent={i}
              onMatches={() => void c.openMatches(i.id)}
              onPause={i.status === 'active' ? () => void c.transition(i.id, i.version.seq, 'paused').then(p.rerender) : undefined}
              onFulfilled={i.status === 'active' || i.status === 'paused' ? () => void c.transition(i.id, i.version.seq, 'fulfilled').then(p.rerender) : undefined}
              onWithdraw={() => void c.transition(i.id, i.version.seq, 'withdrawn').then(p.rerender)}
            />
          ))}
        </section>
      )}

      {p.state.kind === 'matches' && (
        <section aria-label="Matches">
          <h2>Matches</h2>
          {p.state.page.results.map((m) => (
            <MatchCard key={m.id} match={m} onRequestContact={() => void c.requestContact(m.id).then(p.rerender)} />
          ))}
        </section>
      )}
    </main>
  );
}
