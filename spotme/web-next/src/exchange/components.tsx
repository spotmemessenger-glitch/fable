/**
 * Exchange UI components (Phase 3D) — pure, prop-driven, accessible. No fetch,
 * no state beyond local form control; the controller owns application state.
 * A11y at the Phase 2 bar: semantic HTML, labels, 44px targets, visible focus,
 * keyboard operability.
 */

import { useState } from 'react';
import type { ComposeIntentInput, ExchangeIntentView, ExchangeMatchView } from './ports';

const KINDS: Array<ComposeIntentInput['kind']> = ['need', 'offer', 'service'];

/* --------------------------------------------------------------- composer */

export function IntentComposer(props: {
  draft: Partial<ComposeIntentInput>;
  categories: readonly string[];
  onChange(patch: Partial<ComposeIntentInput>): void;
  onSubmit(): void;
  error: string | null;
  busy: boolean;
}) {
  const d = props.draft;
  return (
    <form
      className="ex-composer"
      aria-label="Post a need or offer"
      onSubmit={(e) => { e.preventDefault(); props.onSubmit(); }}
    >
      <fieldset>
        <legend>What are you posting?</legend>
        <div role="radiogroup" aria-label="Kind" className="ex-kinds">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="ex-touch"
              aria-pressed={d.kind === k}
              onClick={() => props.onChange({ kind: k })}
            >
              {k}
            </button>
          ))}
        </div>
      </fieldset>

      <label>Category
        <select aria-label="Category" value={d.category ?? ''} onChange={(e) => props.onChange({ category: e.target.value })}>
          <option value="">choose…</option>
          {props.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>

      <label>Title
        <input aria-label="Title" value={d.title ?? ''} maxLength={140} onChange={(e) => props.onChange({ title: e.target.value })} />
      </label>

      <label>Description
        <textarea aria-label="Description" value={d.text ?? ''} maxLength={2000} onChange={(e) => props.onChange({ text: e.target.value })} />
      </label>

      <label>Approximate price (optional)
        <input aria-label="Informational price" value={d.informationalPrice ?? ''} onChange={(e) => props.onChange({ informationalPrice: e.target.value })} />
      </label>
      <p className="ex-note" id="ex-price-note">
        Informational only — SpotMe does not process payments. Arrange anything off-platform at your own discretion.
      </p>

      <label>Visible radius (km)
        <input aria-label="Radius km" type="number" min={1} max={25} value={d.radiusKm ?? 5} onChange={(e) => props.onChange({ radiusKm: Number(e.target.value) })} />
      </label>

      <label className="ex-check">
        <input
          type="checkbox"
          aria-label="Show on the map"
          checked={d.visibility === 'discoverable'}
          onChange={(e) => props.onChange({ visibility: e.target.checked ? 'discoverable' : 'hidden' })}
        />
        Show this on the nearby map (approximate area only — never your exact location)
      </label>
      {/* A3: no age or gender control exists here or anywhere. */}

      {props.error && <p className="ex-error" role="alert">{props.error}</p>}
      <button type="submit" className="ex-touch ex-primary" disabled={props.busy} aria-disabled={props.busy}>
        {props.busy ? 'Publishing…' : 'Publish'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------ intent card */

export function IntentCard(props: {
  intent: ExchangeIntentView;
  onPause?(): void;
  onWithdraw?(): void;
  onFulfilled?(): void;
  onMatches?(): void;
  onReport?(): void;
  onBlock?(): void;
}) {
  const i = props.intent;
  return (
    <article className="ex-card" aria-label={`${i.kind}: ${i.title}`}>
      <header>
        <strong>{i.title}</strong>
        <span className="ex-kind">{i.kind}</span>
        <span className="ex-status">{i.status}</span>
      </header>
      <p className="ex-cat">{i.category}</p>
      <p>{i.text}</p>
      {i.informationalPrice && (
        <p className="ex-price">
          {i.informationalPrice.label} <span className="ex-note">· informational only, no payment</span>
        </p>
      )}
      <p className="ex-area">Approximate area only</p>
      <footer>
        {props.onMatches && <button className="ex-touch" onClick={props.onMatches}>See matches</button>}
        {props.onPause && <button className="ex-touch" onClick={props.onPause}>Pause</button>}
        {props.onFulfilled && <button className="ex-touch" onClick={props.onFulfilled}>Mark fulfilled</button>}
        {props.onWithdraw && <button className="ex-touch" onClick={props.onWithdraw}>Withdraw</button>}
        {props.onReport && <button className="ex-touch" onClick={props.onReport}>Report</button>}
        {props.onBlock && <button className="ex-touch" onClick={props.onBlock}>Block</button>}
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------- match card */

export function MatchCard(props: { match: ExchangeMatchView; onRequestContact(): void }) {
  const m = props.match;
  const c = m.contact;
  return (
    <article className="ex-card" aria-label={`Match: ${m.intentTitle}`}>
      <header><strong>{m.intentTitle}</strong><span className="ex-band">{m.distanceBand}</span></header>
      <details className="ex-why">
        <summary>Why this match</summary>
        <ul>
          {m.explanation.components.map((cp) => (
            <li key={cp.signal}>{cp.signal}: {cp.value.toFixed(2)} × {cp.weight.toFixed(2)} = {cp.weighted.toFixed(3)}</li>
          ))}
          <li><strong>total {m.explanation.total.toFixed(3)}</strong></li>
        </ul>
      </details>
      {/* CONSENT GATE: chat is available ONLY after the counterpart accepts. */}
      {c.state === 'accepted' ? (
        <button className="ex-touch ex-primary">Open chat</button>
      ) : c.state === 'requested' ? (
        <p className="ex-note" role="status">Contact requested — you can chat once they accept.</p>
      ) : c.state === 'declined' ? (
        <p className="ex-note">Contact was declined.</p>
      ) : (
        <button className="ex-touch" disabled={!c.canRequestContact} onClick={props.onRequestContact}>
          Request contact
        </button>
      )}
    </article>
  );
}

/* --------------------------------------------------------------- controls */

export function ModeTabs(props: { mode: 'compose' | 'browse' | 'mine'; onMode(m: 'compose' | 'browse' | 'mine'): void }) {
  const tabs: Array<'compose' | 'browse' | 'mine'> = ['compose', 'browse', 'mine'];
  return (
    <div role="tablist" aria-label="Exchange" className="ex-tabs">
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={props.mode === t} className="ex-touch" onClick={() => props.onMode(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}

export function CategoryPicker(props: { categories: readonly string[]; value?: string; onChange(v: string | undefined): void }) {
  const [v, setV] = useState(props.value ?? '');
  return (
    <label>Filter category
      <select aria-label="Filter category" value={v} onChange={(e) => { setV(e.target.value); props.onChange(e.target.value || undefined); }}>
        <option value="">any</option>
        {props.categories.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
  );
}
