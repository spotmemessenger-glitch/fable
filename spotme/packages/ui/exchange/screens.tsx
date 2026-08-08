/**
 * Exchange — the four screens (slice 1).
 *
 * Pure and prop-driven: nothing here fetches, stores, or reads a clock. The
 * controller owns state; these render it and raise callbacks.
 *
 * WHAT IS NOT HERE, and why each absence is deliberate (slice-1
 * reconciliation report, §1):
 *
 *   - NO audience estimate. `ExchangeIntentPublic` has no such field, and a
 *     count of people who never chose to be counted is the category ADR-028
 *     bans. Rendering "~40 people" would mean inventing it.
 *   - NO contact count. Same: no field, and it reports how many people looked
 *     at you and decided something.
 *   - NO thumbnails. Exchange has no media pipeline -- no `media`, `mediaIds`,
 *     `thumbnail`, `posterUrl`. The browse card is text-first BY DESIGN rather
 *     than a grey placeholder on every row.
 *   - NO "visible for 30 days". `expiresAtIso` is real but the default is 24
 *     HOURS; 30 days is the opt-in ceiling. Expiry renders from the actual
 *     value or not at all.
 *   - NO distance filter. `GET /browse` takes kind, category, cursor -- that
 *     is all. A control that filtered nothing, or that filtered one keyset
 *     page client-side, would lie about completeness.
 *
 * The primary action is REQUEST CONTACT, not "Message": `contact` carries
 * `requiresExplicitConsent: true` and chat opens only after the owner accepts.
 * A "Message" button promises a conversation the server refuses.
 */

import './screens.css';
import { useId, useState } from 'react';
import type { ExchangeIntentView, ExchangeMatchView } from './ports';

/* ------------------------------------------------------------------ atoms */

const KIND_LABEL: Record<ExchangeIntentView['kind'], string> = {
  need: 'NEED', offer: 'OFFER', service: 'SERVICE',
};

/** Distance is ALWAYS approximate — never an exact figure, never a pin. */
export function approxDistance(km: number): string {
  if (km < 1) return `about ${Math.max(100, Math.round((km * 1000) / 100) * 100)} m`;
  return `about ${km < 10 ? km.toFixed(1).replace(/\.0$/, '') : Math.round(km)} km`;
}

/** Budget is a BAND. Never a number, never a currency symbol. */
const BAND_LABEL = { low: 'Low', medium: 'Medium', high: 'High' } as const;

export function BudgetBand({ band }: { band?: ExchangeIntentView['budgetBand'] }) {
  if (!band) return <span className="x-band x-band-none">Not specified</span>;
  const steps = { low: 1, medium: 2, high: 3 }[band];
  return (
    <span className="x-band" aria-label={`Budget band: ${BAND_LABEL[band]}`}>
      {BAND_LABEL[band]}
      <span className="x-band-bars" aria-hidden="true">
        {[1, 2, 3].map((i) => <i key={i} className={i <= steps ? 'on' : ''} />)}
      </span>
    </span>
  );
}

/** An APPROXIMATE AREA. A circle over a coarse cell — never a pin. */
export function ApproxArea({ intent, label }: { intent: ExchangeIntentView; label?: string }) {
  const titleId = useId();
  return (
    <figure className="x-area">
      <svg viewBox="0 0 320 140" role="img" aria-labelledby={titleId} className="x-area-map">
        <title id={titleId}>
          Approximate area, {approxDistance(intent.radius.km)} across. No exact location is shown.
        </title>
        <rect x="0" y="0" width="320" height="140" className="x-area-ground" />
        <rect x="0" y="62" width="320" height="14" className="x-area-road" />
        <rect x="150" y="0" width="12" height="140" className="x-area-road" />
        <circle cx="160" cy="70" r="46" className="x-area-circle" />
      </svg>
      <figcaption className="x-area-cap">
        {label ?? `${approxDistance(intent.radius.km)} across`} · area shown is approximate
      </figcaption>
    </figure>
  );
}

/** Every icon control carries a name; every target is >= 44px (see CSS). */
function IconButton(
  { label, glyph, onClick }: { label: string; glyph: string; onClick(): void },
) {
  return (
    <button type="button" className="x-iconbtn" onClick={onClick} aria-label={label}>
      <span aria-hidden="true">{glyph}</span>
      <span className="x-iconbtn-text">{label}</span>
    </button>
  );
}

/** Withdraw and Mark fulfilled live here rather than being dropped. */
export function OverflowMenu({ items }: { items: Array<{ label: string; onSelect(): void; tone?: 'danger' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="x-overflow">
      <button
        type="button" className="x-iconbtn x-overflow-trigger"
        aria-label="More actions" aria-expanded={open} aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <ul className="x-overflow-menu" role="menu">
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                type="button" role="menuitem"
                className={it.tone === 'danger' ? 'x-danger' : undefined}
                onClick={() => { setOpen(false); it.onSelect(); }}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- browse */

export function BrowseScreen(props: {
  tab: 'need' | 'offer';
  servicesOnly: boolean;
  category?: string;
  categories: readonly string[];
  results: ExchangeIntentView[];
  state: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';
  onTab(t: 'need' | 'offer'): void;
  onServicesOnly(v: boolean): void;
  onCategory(c: string | undefined): void;
  onOpen(id: string): void;
}) {
  return (
    <section className="x-screen" aria-label="Exchange">
      <header className="x-head"><h1>Exchange</h1></header>

      <div className="x-tabs" role="tablist" aria-label="Needs or offers">
        {(['need', 'offer'] as const).map((t) => (
          <button
            key={t} type="button" role="tab" id={`x-tab-${t}`}
            aria-selected={props.tab === t} aria-controls="x-browse-list"
            className={props.tab === t ? 'on' : undefined}
            onClick={() => props.onTab(t)}
          >
            {t === 'need' ? 'Needs' : 'Offers'}
          </button>
        ))}
      </div>

      {/* Category and Services map to real query params (category, kind).
          A distance filter is NOT offered: browse has no radius parameter,
          so the control could only mislead. */}
      <div className="x-filters">
        <label className="x-filter">
          <span className="x-vh">Category</span>
          <select
            value={props.category ?? ''}
            onChange={(e) => props.onCategory(e.target.value || undefined)}
          >
            <option value="">Any category</option>
            {props.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button
          type="button"
          className={`x-filter x-chip${props.servicesOnly ? ' on' : ''}`}
          aria-pressed={props.servicesOnly}
          onClick={() => props.onServicesOnly(!props.servicesOnly)}
        >
          Services only
        </button>
      </div>

      <ul id="x-browse-list" className="x-list" role="tabpanel" aria-labelledby={`x-tab-${props.tab}`}>
        {props.state === 'empty' && <li className="x-note">Nothing here yet.</li>}
        {props.state === 'unavailable' && <li className="x-note">Exchange is unavailable right now.</li>}
        {props.state === 'failed' && <li className="x-note">Could not load. Pull to retry.</li>}
        {props.results.map((it) => (
          <li key={it.id}>
            {/* Text-first: there is no media on an intent to show. */}
            <button type="button" className="x-card" onClick={() => props.onOpen(it.id)}>
              <span className={`x-kind x-kind-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
              <span className="x-card-meta">{approxDistance(it.radius.km)}</span>
              <span className="x-card-title">{it.title}</span>
              <span className="x-card-text">{it.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ----------------------------------------------------------------- detail */

export function DetailScreen(props: {
  intent: ExchangeIntentView;
  contact: ExchangeMatchView['contact'];
  /** TRUE while the server has no contact-request route: the button says so
   *  plainly instead of faking a pending state. */
  contactUnavailable?: boolean;
  onRequestContact(): void;
  onSave(): void;
  onShare(): void;
  onReport(): void;
  onWithdraw(): void;
  onMarkFulfilled(): void;
  onBack(): void;
}) {
  const i = props.intent;
  const availability =
    i.availability.state === 'recurring' ? i.availability.scheduleLabel
      : i.availability.state === 'window' ? `${i.availability.fromIso.slice(0, 10)} → ${i.availability.toIso.slice(0, 10)}`
        : 'Not specified';

  return (
    <section className="x-screen" aria-label={i.title}>
      <header className="x-head x-head-row">
        <button type="button" className="x-iconbtn" aria-label="Back" onClick={props.onBack}>
          <span aria-hidden="true">‹</span>
        </button>
        <h1 className="x-vh">{i.title}</h1>
        <OverflowMenu
          items={[
            { label: 'Mark fulfilled', onSelect: props.onMarkFulfilled },
            { label: 'Withdraw', onSelect: props.onWithdraw, tone: 'danger' },
          ]}
        />
      </header>

      <span className={`x-kind x-kind-${i.kind}`}>{KIND_LABEL[i.kind]}</span>
      <h2 className="x-title">{i.title}</h2>
      {i.ownerName && <p className="x-owner">{i.ownerName}</p>}
      <p className="x-body">{i.text}</p>

      {i.tags.length > 0 && (
        <ul className="x-tags" aria-label="Tags">
          {i.tags.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}

      <dl className="x-facts">
        <div><dt>Budget band</dt><dd><BudgetBand band={i.budgetBand} /></dd></div>
        <div><dt>Availability</dt><dd>{availability}</dd></div>
        {/* Expiry from the REAL field. Absent when the server says null. */}
        {i.expiresAtIso && (
          <div><dt>Visible until</dt><dd>{i.expiresAtIso.slice(0, 10)}</dd></div>
        )}
      </dl>

      {i.informationalPrice && (
        <p className="x-price">
          {i.informationalPrice.label}
          <span className="x-price-note">Informational only — no payment happens in Spot Me.</span>
        </p>
      )}

      <h3 className="x-sub">Approximate area</h3>
      <ApproxArea intent={i} />

      {/* REQUEST CONTACT, not "Message": consent is explicit and server-side.
          While no contact route exists, the button says exactly that. */}
      <div className="x-cta">
        <button
          type="button" className="x-primary"
          disabled={props.contactUnavailable || !props.contact.canRequestContact || props.contact.state !== 'none'}
          onClick={props.onRequestContact}
        >
          {props.contactUnavailable ? 'Contact isn’t available yet'
            : props.contact.state === 'requested' ? 'Contact requested'
              : props.contact.state === 'accepted' ? 'Open chat'
                : props.contact.state === 'declined' ? 'Request declined'
                  : 'Request contact'}
        </button>
        <p className="x-consent">
          {props.contactUnavailable
            ? 'Contact requests haven’t been built yet. You can’t reach this person through Spot Me for now.'
            : 'They choose whether to share contact. Chat opens only if they accept.'}
        </p>
      </div>

      <div className="x-actions">
        <IconButton label="Save" glyph="🔖" onClick={props.onSave} />
        <IconButton label="Share" glyph="↗" onClick={props.onShare} />
        <IconButton label="Report" glyph="⚑" onClick={props.onReport} />
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- create */

export type Draft = {
  kind: 'need' | 'offer' | 'service';
  category: string;
  title: string;
  text: string;
  budgetBand?: 'low' | 'medium' | 'high';
  scheduleLabel: string;
  radiusKm: number;
  discoverable: boolean;
};

export function CreateScreen(props: {
  step: 1 | 2 | 3;
  draft: Draft;
  categories: readonly string[];
  maxKm: number;
  onDraft(patch: Partial<Draft>): void;
  onStep(s: 1 | 2 | 3): void;
  onSubmit(): void;
}) {
  const { draft: d } = props;
  return (
    <section className="x-screen" aria-label="New intent">
      <header className="x-head x-head-row">
        <button type="button" className="x-iconbtn" aria-label="Back"
          onClick={() => props.onStep((props.step > 1 ? props.step - 1 : 1) as 1 | 2 | 3)}>
          <span aria-hidden="true">‹</span>
        </button>
        <h1>New intent</h1>
        <span className="x-step">Step {props.step} of 3</span>
      </header>

      <ol className="x-progress" aria-label={`Step ${props.step} of 3`}>
        {[1, 2, 3].map((n) => <li key={n} className={n <= props.step ? 'on' : undefined} />)}
      </ol>

      {props.step === 1 && (
        <>
          <fieldset className="x-field">
            <legend>What is this?</legend>
            {(['need', 'offer', 'service'] as const).map((k) => (
              <label key={k} className="x-radio">
                <input type="radio" name="x-kind" checked={d.kind === k} onChange={() => props.onDraft({ kind: k })} />
                <span>{KIND_LABEL[k]}</span>
              </label>
            ))}
          </fieldset>
          <label className="x-field">
            <span>Category</span>
            <select value={d.category} onChange={(e) => props.onDraft({ category: e.target.value })}>
              {props.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </>
      )}

      {props.step === 2 && (
        <>
          <label className="x-field">
            <span>Title</span>
            {/* No lang hint on purpose: the #132 font stack resolves Latin and
                every listed Indic script by unicode-range, so a Tamil title
                and an English one both render without a per-field override. */}
            <input value={d.title} onChange={(e) => props.onDraft({ title: e.target.value })} maxLength={120} />
          </label>
          <label className="x-field">
            <span>Details</span>
            <textarea rows={5} value={d.text} onChange={(e) => props.onDraft({ text: e.target.value })} maxLength={2000} />
          </label>
        </>
      )}

      {props.step === 3 && (
        <>
          <fieldset className="x-field">
            <legend>Budget band</legend>
            <div className="x-bands">
              {([undefined, 'low', 'medium', 'high'] as const).map((b) => (
                <button
                  key={b ?? 'none'} type="button"
                  className={`x-chip${d.budgetBand === b ? ' on' : ''}`}
                  aria-pressed={d.budgetBand === b}
                  onClick={() => props.onDraft({ budgetBand: b })}
                >
                  {b ? BAND_LABEL[b] : 'None'}
                </button>
              ))}
            </div>
            <p className="x-hint">A band, never a number. Talk specifics in chat if you need to.</p>
          </fieldset>

          <label className="x-field">
            <span>Availability</span>
            <input value={d.scheduleLabel} onChange={(e) => props.onDraft({ scheduleLabel: e.target.value })} />
          </label>

          <label className="x-field">
            <span>Reach</span>
            <input
              type="range" min={1} max={props.maxKm} value={d.radiusKm}
              onChange={(e) => props.onDraft({ radiusKm: Number(e.target.value) })}
              aria-valuetext={approxDistance(d.radiusKm)}
            />
            {/* One caption, not two. The mock's right-hand "Seen by ~40
                people" has no server field behind it. */}
            <span className="x-hint">{approxDistance(d.radiusKm)}</span>
          </label>

          <label className="x-toggle">
            <span>
              <strong>Discoverable</strong>
              <small>Hidden means only people you message can see it</small>
            </span>
            <input
              type="checkbox" role="switch" checked={d.discoverable}
              onChange={(e) => props.onDraft({ discoverable: e.target.checked })}
            />
          </label>
        </>
      )}

      <div className="x-cta">
        {props.step < 3
          ? <button type="button" className="x-primary" onClick={() => props.onStep((props.step + 1) as 2 | 3)}>Continue</button>
          : <button type="button" className="x-primary" onClick={props.onSubmit}>Post intent</button>}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- my intents */

const MINE_TABS = ['active', 'paused', 'matched', 'fulfilled'] as const;
export type MineTab = (typeof MINE_TABS)[number];

export function MyIntentsScreen(props: {
  tab: MineTab;
  results: ExchangeIntentView[];
  onTab(t: MineTab): void;
  onPause(id: string): void;
  onResume(id: string): void;
  onEdit(id: string): void;
  onWithdraw(id: string): void;
  onMarkFulfilled(id: string): void;
}) {
  return (
    <section className="x-screen" aria-label="My intents">
      <header className="x-head"><h1>My intents</h1></header>

      <div className="x-segment" role="tablist" aria-label="Intent status">
        {MINE_TABS.map((t) => (
          <button
            key={t} type="button" role="tab" aria-selected={props.tab === t}
            className={props.tab === t ? 'on' : undefined} onClick={() => props.onTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <ul className="x-list">
        {props.results.length === 0 && <li className="x-note">Nothing {props.tab}.</li>}
        {props.results.map((it) => (
          <li key={it.id} className="x-card x-card-static">
            <div className="x-card-row">
              <span className={`x-kind x-kind-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
              <OverflowMenu
                items={[
                  { label: 'Mark fulfilled', onSelect: () => props.onMarkFulfilled(it.id) },
                  { label: 'Withdraw', onSelect: () => props.onWithdraw(it.id), tone: 'danger' },
                ]}
              />
            </div>
            <span className="x-card-title">{it.title}</span>
            {/* Reach only. The mock's "4 people messaged" has no field. */}
            <span className="x-card-meta">Reach {approxDistance(it.radius.km)}</span>
            <div className="x-card-actions">
              {it.status === 'paused'
                ? <button type="button" onClick={() => props.onResume(it.id)}>Resume</button>
                : <button type="button" onClick={() => props.onPause(it.id)}>Pause</button>}
              <button type="button" onClick={() => props.onEdit(it.id)}>Edit</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
