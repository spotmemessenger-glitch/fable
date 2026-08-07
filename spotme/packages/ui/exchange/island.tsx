/**
 * The composed Exchange surface the island host mounts.
 *
 * Fixture-backed for now: no endpoint is wired, and the reconciliation report
 * records why (browse takes no radius parameter, and contact is consent-gated
 * server-side). Screen navigation is local state -- Exchange deliberately
 * does not touch the app's hash router, so the island cannot change routing
 * behaviour for anyone with the flag off.
 */
import { useState } from 'react';
import { BrowseScreen, DetailScreen, CreateScreen, MyIntentsScreen } from './screens';
import type { Draft, MineTab } from './screens';
import type { ExchangeIntentView, ExchangeMatchView } from './ports';

const CATEGORIES = ['help/moving', 'services/plumbing', 'lessons', 'goods'] as const;

const SEED: ExchangeIntentView[] = [
  {
    id: 'x1', kind: 'need', status: 'active', category: 'help/moving',
    title: 'Someone to help move a bookshelf',
    text: 'Second floor, no lift. Mostly awkward rather than heavy.',
    tags: ['Lifting', 'Weekend'], budgetBand: 'low',
    approxLocation: { lat: 12.971, lon: 77.594, cell: 'g12.97:77.59' },
    radius: { km: 3, maxKm: 25 },
    availability: { state: 'recurring', scheduleLabel: 'Sat & Sun, mornings' },
    visibility: 'discoverable', createdAtIso: '2026-08-07T09:00:00.000Z',
    expiresAtIso: null, ownerName: 'Meena K.', version: { seq: 1 },
  },
  {
    id: 'x2', kind: 'service', status: 'active', category: 'services/plumbing',
    title: 'Bicycle repair, mobile',
    text: 'I come to you. Punctures, brakes, gears.',
    tags: ['Repair'], approxLocation: { lat: 12.972, lon: 77.596, cell: 'g12.97:77.59' },
    radius: { km: 4, maxKm: 25 },
    availability: { state: 'unknown' },
    visibility: 'discoverable', createdAtIso: '2026-08-06T09:00:00.000Z',
    expiresAtIso: null, ownerName: 'Ravi S.', version: { seq: 1 },
  },
];

const NO_CONTACT: ExchangeMatchView['contact'] = {
  state: 'none', canRequestContact: true, requiresExplicitConsent: true,
};

type View = { name: 'browse' } | { name: 'detail'; id: string } | { name: 'create' } | { name: 'mine' };

export function ExchangeIsland() {
  const [view, setView] = useState<View>({ name: 'browse' });
  const [tab, setTab] = useState<'need' | 'offer'>('need');
  const [servicesOnly, setServicesOnly] = useState(false);
  const [category, setCategory] = useState<string | undefined>();
  const [mineTab, setMineTab] = useState<MineTab>('active');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [contact, setContact] = useState(NO_CONTACT);
  const [draft, setDraft] = useState<Draft>({
    kind: 'need', category: CATEGORIES[0], title: '', text: '',
    scheduleLabel: '', radiusKm: 3, discoverable: true,
  });

  const results = SEED.filter((i) =>
    (servicesOnly ? i.kind === 'service' : i.kind === tab || i.kind === 'service')
    && (!category || i.category === category));

  if (view.name === 'detail') {
    const intent = SEED.find((i) => i.id === view.id)!;
    return (
      <DetailScreen
        intent={intent} contact={contact}
        onRequestContact={() => setContact({ ...contact, state: 'requested' })}
        onSave={() => {}} onShare={() => {}} onReport={() => {}}
        onWithdraw={() => setView({ name: 'browse' })}
        onMarkFulfilled={() => setView({ name: 'browse' })}
        onBack={() => setView({ name: 'browse' })}
      />
    );
  }

  if (view.name === 'create') {
    return (
      <CreateScreen
        step={step} draft={draft} categories={CATEGORIES} maxKm={25}
        onDraft={(patch) => setDraft({ ...draft, ...patch })}
        onStep={setStep}
        onSubmit={() => { setStep(1); setView({ name: 'mine' }); }}
      />
    );
  }

  if (view.name === 'mine') {
    return (
      <MyIntentsScreen
        tab={mineTab} results={mineTab === 'active' ? SEED : []}
        onTab={setMineTab} onPause={() => {}} onResume={() => {}} onEdit={() => {}}
        onWithdraw={() => {}} onMarkFulfilled={() => {}}
      />
    );
  }

  return (
    <BrowseScreen
      tab={tab} servicesOnly={servicesOnly} category={category}
      categories={CATEGORIES} results={results}
      state={results.length ? 'ok' : 'empty'}
      onTab={setTab} onServicesOnly={setServicesOnly} onCategory={setCategory}
      onOpen={(id) => setView({ name: 'detail', id })}
    />
  );
}
