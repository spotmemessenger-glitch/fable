/**
 * Assistant pure components (Phase 6D). Prop-driven, no state, no ports.
 *
 * RENDERING LAW (X1/X3): answer text renders ONLY from CitedClaims; citation
 * labels come from the normalized EvidenceRecord (`attributionLabel`), never
 * from claim prose. Honest states (insufficient-evidence, domain-not-active,
 * unavailable) are first-class cards. Stale evidence renders WITH a
 * disclosure (X4 allows display, never current-state support — the backend
 * already refused those claims). A11y: every claim links to its sources via
 * aria-describedby; the citation chips carry full-text labels.
 */

import type {
  AssistantAnswer, CitedClaim, EvidenceRecord, ReviewFacet, ReviewIntelligence,
  RouteAdvice,
} from '@spotme/contracts';
import type { VoiceInputPort } from './ports';

/* ---------------- query bar ---------------- */

export function QueryBar(p: {
  value: string;
  voice: VoiceInputPort;
  busy: boolean;
  onChange(v: string): void;
  onSubmit(): void;
}) {
  return (
    <form className="as-querybar" role="search" aria-label="Ask about this area"
      onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      <label className="as-visually-hidden" htmlFor="as-query">Ask about this area</label>
      <input id="as-query" type="text" value={p.value} maxLength={512}
        placeholder="Ask about this area…" disabled={p.busy}
        onChange={(e) => p.onChange(e.target.value)} />
      {/* The VoicePort seam — an HONEST disabled state, not a hidden button. */}
      <button type="button" className="as-mic" aria-disabled="true" disabled
        title={p.voice.reason} aria-label={`Voice input (disabled): ${p.voice.reason}`}>
        mic
      </button>
      <button type="submit" className="as-touch" disabled={p.busy}>Ask</button>
    </form>
  );
}

/* ---------------- citations ---------------- */

function sourcesById(sources: readonly EvidenceRecord[]): Map<string, EvidenceRecord> {
  return new Map(sources.map((s) => [s.id as string, s]));
}

export function ClaimLine(p: { claim: CitedClaim; sources: readonly EvidenceRecord[]; idPrefix: string }) {
  const byId = sourcesById(p.sources);
  const descId = `${p.idPrefix}-${p.claim.id}-cites`;
  return (
    <li className="as-claim">
      <span aria-describedby={descId}>{p.claim.text}</span>
      <span id={descId} className="as-citations">
        {p.claim.citationIds.map((cid, i) => {
          const record = byId.get(cid as string);
          // X3: label from the normalized record — an unresolved citation
          // renders as an explicit failure, never silently.
          const label = record ? record.attributionLabel : 'unresolved citation';
          return (
            <button key={cid as string} type="button" className="as-cite"
              aria-label={`Citation ${i + 1}: ${label}`} title={label}>
              [{i + 1}]
            </button>
          );
        })}
      </span>
      <span className="as-confidence">
        confidence: {p.claim.confidence.level} ({p.claim.confidence.basis.sourceDiversity}{' '}
        {p.claim.confidence.basis.sourceDiversity === 1 ? 'source' : 'sources'})
      </span>
      {p.claim.citationIds.some((cid) => byId.get(cid as string)?.freshness === 'stale') && (
        <span className="as-stale" role="note">may be out of date</span>
      )}
    </li>
  );
}

function SourcesList(p: { sources: readonly EvidenceRecord[] }) {
  return (
    <section className="as-sources" aria-label="Sources">
      <h3>Sources</h3>
      <ul>
        {p.sources.map((s) => (
          <li key={s.id as string}>
            {s.attributionLabel}
            {s.freshness !== 'current' && <em> ({s.freshness})</em>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- answer card ---------------- */

export function AnswerCard(p: { answer: AssistantAnswer }) {
  const a = p.answer;
  switch (a.kind) {
    case 'results':
      return (
        <article className="as-answer" aria-label="Answer">
          <ul className="as-claims">
            {a.summary.claims.map((c) => (
              <ClaimLine key={c.id} claim={c} sources={a.summary.sources} idPrefix="ans" />
            ))}
          </ul>
          <SourcesList sources={a.summary.sources} />
        </article>
      );
    case 'insufficient-evidence':
      return (
        <article className="as-answer as-honest" role="status">
          Not enough evidence to answer{a.reason === 'all-evidence-stale'
            ? ' — the available information is out of date'
            : a.reason === 'conflicting-evidence-only'
              ? ' — the available sources conflict'
              : ''}.
        </article>
      );
    case 'domain-not-active':
      return (
        <article className="as-answer as-honest" role="status">
          That part of Spot Me is not active yet.
        </article>
      );
    case 'unavailable':
      return (
        <article className="as-answer as-honest" role="status">
          The assistant is unavailable{a.reason === 'provider-unconfigured' ? ' — no source is configured' : ''}.
        </article>
      );
  }
}

export function SensitiveNotice(p: { notice: string }) {
  return <aside className="as-sensitive" role="note" aria-label="Important notice">{p.notice}</aside>;
}

/* ---------------- review facets (X5) ---------------- */

function FacetRow(p: { facet: ReviewFacet; sources: readonly EvidenceRecord[] }) {
  const f = p.facet;
  return (
    <li className="as-facet">
      <span className="as-facet-field">{f.field}</span>
      {f.state === 'supported' && (
        <ul>{f.claims.map((c) => <ClaimLine key={c.id} claim={c} sources={p.sources} idPrefix="facet" />)}</ul>
      )}
      {f.state === 'mixed' && (
        <>
          <span className="as-facet-mixed" role="note">Conflicting reports — both shown</span>
          <ul>{f.claims.map((c) => <ClaimLine key={c.id} claim={c} sources={p.sources} idPrefix="facet" />)}</ul>
        </>
      )}
      {f.state === 'insufficient-evidence' && <span className="as-facet-empty">Not enough evidence</span>}
      {f.state === 'not-applicable' && <span className="as-facet-empty">Not applicable</span>}
    </li>
  );
}

export function ReviewFacetPanel(p: { review: ReviewIntelligence }) {
  return (
    <section className="as-review" aria-label="What reviews say">
      <h2>What reviews say</h2>
      {/* X5: no stars, no score — per-field facts or honest absence. */}
      <ul>
        {p.review.facets.map((f) => <FacetRow key={f.field} facet={f} sources={p.review.sources} />)}
      </ul>
      <SourcesList sources={p.review.sources} />
    </section>
  );
}

/* ---------------- route card (X6) ---------------- */

function metres(m: number | null): string {
  if (m === null) return 'distance not provided';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

function minutes(s: number | null): string {
  if (s === null) return 'time not provided';
  return `${Math.round(s / 60)} min`;
}

export function RouteCard(p: { route: RouteAdvice }) {
  const r = p.route;
  switch (r.kind) {
    case 'provider-route':
      return (
        <section className="as-route" aria-label="Route">
          <ul>
            {r.legs.map((leg, i) => (
              <li key={i}>
                {leg.mode}: {metres(leg.providerDistanceM)}, {minutes(leg.providerDurationS)}
                <span className="as-attribution"> via {leg.attribution}</span>
              </li>
            ))}
          </ul>
        </section>
      );
    case 'straight-line':
      return (
        <section className="as-route" aria-label="Distance estimate">
          {/* X6: the FIXED label, verbatim — and no time, ever. */}
          <p>{r.estimate.label}: {metres(r.estimate.distanceM)} — not a route</p>
        </section>
      );
    case 'unavailable':
      return (
        <section className="as-route as-honest" role="status">
          Directions are unavailable{r.reason === 'provider-unconfigured' ? ' — no provider is configured' : ''}.
        </section>
      );
  }
}
