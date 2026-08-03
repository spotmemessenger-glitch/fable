import type { ExchangeItemPublic } from '@spotme/contracts';

/**
 * The single inert screen. It renders a read-only Exchange listing built from
 * the SHARED @spotme/contracts type — proving the React surface consumes the
 * same domain contracts the rest of the platform will. Deliberately inert: no
 * state, no handlers, no network, no routing. This is a beachhead, not a
 * feature.
 */

const SAMPLE: ExchangeItemPublic = {
  id: 'sample-1',
  type: 'need',
  status: 'active',
  category: 'services/plumbing',
  title: 'Leaking kitchen tap',
  text: 'Leaking kitchen tap, need it fixed tonight.',
  tags: ['services', 'plumbing'],
  budgetBand: 'low',
  timeframe: { from: '2026-08-03T18:00:00Z', to: '2026-08-03T23:00:00Z' },
  location: {
    precision: 'approximate',
    // Already coarsened on-device — the type carries no precise-fix field.
    approx: { lat: 12.97, lon: 77.59, coarsened: true },
  },
  createdAt: '2026-08-03T17:45:00Z',
  expiresAt: '2026-08-04T17:45:00Z',
};

export function App() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 480,
        margin: '2rem auto',
        padding: '1rem',
      }}
    >
      <p style={{ color: '#888', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
        web-next · inert beachhead · not deployed
      </p>
      <article style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <strong>{SAMPLE.title}</strong>
          <span style={{ fontSize: 12, color: '#0a7' }}>{SAMPLE.type.toUpperCase()}</span>
        </div>
        <p style={{ margin: '8px 0' }}>{SAMPLE.text}</p>
        <p style={{ fontSize: 13, color: '#555' }}>
          {SAMPLE.category} · budget {SAMPLE.budgetBand} · ~
          {SAMPLE.location.approx.lat.toFixed(2)}, {SAMPLE.location.approx.lon.toFixed(2)} (
          {SAMPLE.location.precision})
        </p>
        <ul style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, fontSize: 12 }}>
          {SAMPLE.tags.map((t) => (
            <li key={t} style={{ background: '#eee', borderRadius: 6, padding: '2px 8px' }}>
              {t}
            </li>
          ))}
        </ul>
      </article>
    </main>
  );
}
