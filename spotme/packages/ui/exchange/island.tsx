/**
 * The composed Exchange surface the island host mounts — LIVE.
 *
 * The app passes an ExchangeLivePort built over the real /api/v1/exchange
 * endpoints (apps/web/src/lib/exchange-api.js); this island owns navigation
 * and screen state and NEVER fetches directly. Screen navigation is local
 * state -- Exchange deliberately does not touch the app's hash router, so the
 * island cannot change routing behaviour for anyone with the flag off.
 *
 * HONESTY RULES (slice-1 reconciliation report, unchanged by the live wiring):
 *  - detail for a browsed intent renders the row the browse page returned —
 *    there is no public single-intent endpoint, so nothing is re-fetched or
 *    invented;
 *  - "request contact" has NO server route yet; the button says so plainly
 *    (contactUnavailable) instead of faking a pending state;
 *  - ownerName is NOT rendered: the API returns an owner reference only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowseScreen, DetailScreen, CreateScreen, MyIntentsScreen } from './screens';
import type { Draft, MineTab } from './screens';
import type { ExchangeIntentView } from './ports';

const CATEGORIES = ['help/moving', 'services/plumbing', 'lessons', 'goods'] as const;
const MAX_KM = 25;

/**
 * What the island needs from the app. Narrower than ExchangeApiPort on
 * purpose: only routes that exist on the server are represented, so the
 * surface cannot promise what the backend does not do.
 */
export interface ExchangeLivePort {
  browse(opts: { kind?: 'need' | 'offer' | 'service'; category?: string }): Promise<{ results: ExchangeIntentView[]; state: string }>;
  listMine(): Promise<{ results: ExchangeIntentView[]; state: string }>;
  /** Create draft + activate — the two server calls that make a post visible. */
  publish(draft: Draft): Promise<ExchangeIntentView>;
  transition(id: string, version: number, to: 'active' | 'paused' | 'withdrawn' | 'fulfilled'): Promise<ExchangeIntentView>;
}

type View = { name: 'browse' } | { name: 'detail'; intent: ExchangeIntentView } | { name: 'create' } | { name: 'mine' };

export function ExchangeIsland({ port }: { port: ExchangeLivePort }) {
  const [view, setView] = useState<View>({ name: 'browse' });
  const [tab, setTab] = useState<'need' | 'offer'>('need');
  const [servicesOnly, setServicesOnly] = useState(false);
  const [category, setCategory] = useState<string | undefined>();
  const [mineTab, setMineTab] = useState<MineTab>('active');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [browseState, setBrowseState] = useState<'ok' | 'partial' | 'empty' | 'unavailable' | 'failed'>('empty');
  const [results, setResults] = useState<ExchangeIntentView[]>([]);
  const [mine, setMine] = useState<ExchangeIntentView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const [draft, setDraft] = useState<Draft>({
    kind: 'need', category: CATEGORIES[0], title: '', text: '',
    scheduleLabel: '', radiusKm: 3, discoverable: true,
  });

  const loadBrowse = useCallback(async (t: 'need' | 'offer', servOnly: boolean, cat?: string) => {
    try {
      const page = await port.browse({ kind: servOnly ? 'service' : t, category: cat });
      if (!alive.current) return;
      setResults(page.results);
      setBrowseState(page.state === 'unavailable' ? 'unavailable' : page.results.length ? 'ok' : 'empty');
    } catch {
      if (!alive.current) return;
      setResults([]);
      setBrowseState('failed');
    }
  }, [port]);

  const loadMine = useCallback(async () => {
    try {
      const page = await port.listMine();
      if (alive.current) setMine(page.results);
    } catch {
      if (alive.current) setMine([]);
    }
  }, [port]);

  useEffect(() => { void loadBrowse(tab, servicesOnly, category); }, [loadBrowse, tab, servicesOnly, category]);
  useEffect(() => { if (view.name === 'mine') void loadMine(); }, [view.name, loadMine]);

  const act = async (id: string, version: number, to: 'active' | 'paused' | 'withdrawn' | 'fulfilled') => {
    setError(null);
    try {
      await port.transition(id, version, to);
      await loadMine();
      await loadBrowse(tab, servicesOnly, category);
    } catch (e) {
      if (alive.current) setError((e as Error)?.message || 'That action failed. Please try again.');
    }
  };

  if (view.name === 'detail') {
    const intent = view.intent;
    return (
      <DetailScreen
        intent={intent}
        /* No contact route exists on the server yet; say so, fake nothing. */
        contact={{ state: 'none', canRequestContact: false, requiresExplicitConsent: true }}
        contactUnavailable
        onRequestContact={() => {}}
        onSave={() => {}} onShare={() => {}} onReport={() => {}}
        onWithdraw={() => { void act(intent.id, intent.version.seq, 'withdrawn'); setView({ name: 'browse' }); }}
        onMarkFulfilled={() => { void act(intent.id, intent.version.seq, 'fulfilled'); setView({ name: 'browse' }); }}
        onBack={() => setView({ name: 'browse' })}
      />
    );
  }

  if (view.name === 'create') {
    return (
      <>
        {error && <p className="x-note" role="alert">{error}</p>}
        <CreateScreen
          step={step} draft={draft} categories={CATEGORIES} maxKm={MAX_KM}
          onDraft={(patch) => setDraft({ ...draft, ...patch })}
          onStep={setStep}
          onSubmit={() => {
            if (busy) return;
            setBusy(true); setError(null);
            port.publish(draft).then(() => {
              if (!alive.current) return;
              setBusy(false); setStep(1);
              setDraft({ kind: 'need', category: CATEGORIES[0], title: '', text: '', scheduleLabel: '', radiusKm: 3, discoverable: true });
              setView({ name: 'mine' });
            }).catch((e: Error) => {
              if (!alive.current) return;
              setBusy(false);
              setError(e?.message || 'Could not post. Please try again.');
            });
          }}
        />
      </>
    );
  }

  if (view.name === 'mine') {
    const filtered = mine.filter((i) => i.status === mineTab);
    return (
      <>
        {error && <p className="x-note" role="alert">{error}</p>}
        <nav className="x-islandnav">
          <button type="button" onClick={() => setView({ name: 'browse' })}>Browse</button>
          <button type="button" onClick={() => { setStep(1); setView({ name: 'create' }); }}>New intent</button>
        </nav>
        <MyIntentsScreen
          tab={mineTab} results={filtered}
          onTab={setMineTab}
          onPause={(id) => { const it = mine.find((i) => i.id === id); if (it) void act(id, it.version.seq, 'paused'); }}
          onResume={(id) => { const it = mine.find((i) => i.id === id); if (it) void act(id, it.version.seq, 'active'); }}
          onEdit={() => setError('Editing is only possible while an intent is still a draft.')}
          onWithdraw={(id) => { const it = mine.find((i) => i.id === id); if (it) void act(id, it.version.seq, 'withdrawn'); }}
          onMarkFulfilled={(id) => { const it = mine.find((i) => i.id === id); if (it) void act(id, it.version.seq, 'fulfilled'); }}
        />
      </>
    );
  }

  return (
    <>
      <nav className="x-islandnav">
        <button type="button" onClick={() => setView({ name: 'mine' })}>My intents</button>
        <button type="button" onClick={() => { setStep(1); setView({ name: 'create' }); }}>New intent</button>
      </nav>
      <BrowseScreen
        tab={tab} servicesOnly={servicesOnly} category={category}
        categories={CATEGORIES} results={results}
        state={browseState}
        onTab={setTab} onServicesOnly={setServicesOnly} onCategory={setCategory}
        onOpen={(id) => {
          const it = results.find((i) => i.id === id);
          if (it) setView({ name: 'detail', intent: it });
        }}
      />
    </>
  );
}
