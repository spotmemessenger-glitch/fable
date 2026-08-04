/**
 * Checkpoint 6 — SearchPort / Typesense adapter. Deterministic doubles for the
 * reliability contract (states, timeout, breaker, ceiling, exact-pin,
 * allow-list); a LOUD-SKIP live block (TEST_TYPESENSE_URL) proves typo/prefix
 * behavior against a real engine rather than claiming it from mocks.
 */

import { normalizeHandle, normalizeSearchText } from '../src/discovery/search/normalize';
import {
  TypesenseSearchAdapter,
  TYPESENSE_SCHEMA,
  TYPESENSE_DEFAULTS,
} from '../src/discovery/search/typesense-search.adapter';

type FetchArgs = { url: string; init?: { method?: string; body?: string } };

const okJson = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });

const adapterWith = (
  fetchImpl: (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  cfg: Partial<ConstructorParameters<typeof TypesenseSearchAdapter>[0]> = {},
  clock?: () => number,
) =>
  new TypesenseSearchAdapter(
    { ...TYPESENSE_DEFAULTS, url: 'http://ts.test', apiKey: 'test-key', ...cfg },
    fetchImpl as never,
    clock ?? (() => 0),
  );

describe('normalization — language-safe, spoof-resistant', () => {
  it('NFKC-folds width/compatibility forms and strips zero-width characters', () => {
    expect(normalizeSearchText('Ｐｒｉｙａ')).toBe('priya');            // fullwidth
    expect(normalizeSearchText('pri​ya')).toBe('priya');            // zero-width space
    expect(normalizeSearchText('  Mixed   Case ⁠Text ')).toBe('mixed case text');
  });
  it('handles collapse to a single spaceless casefolded token', () => {
    expect(normalizeHandle('Priya K')).toBe('priyak');
    expect(normalizeHandle('ＰＲＩＹＡ_ｋ')).toBe('priya_k');
  });
});

describe('typesense adapter — reliability contract (deterministic doubles)', () => {
  it('UNCONFIGURED: returns the typed unavailable state, never throws, never fabricates', async () => {
    const a = new TypesenseSearchAdapter({ ...TYPESENSE_DEFAULTS }, (async () => {
      throw new Error('must not be called');
    }) as never);
    expect(await a.search('priya')).toEqual({ state: 'provider-unavailable', reason: 'unconfigured' });
    expect(await a.indexDoc({ id: 'u1', handle: 'x', normalizedHandle: 'x', displayName: 'X', kind: 'username' })).toEqual({ ok: false });
    expect(await a.health()).toBe('unavailable');
  });

  it('TIMEOUT: an aborted request becomes provider-unavailable/timeout', async () => {
    const a = adapterWith(
      (_url, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
          });
        }),
      { timeoutMs: 20 },
    );
    expect(await a.search('priya')).toEqual({ state: 'provider-unavailable', reason: 'timeout' });
  });

  it('CIRCUIT BREAKER: opens after N consecutive failures, answers instantly, half-opens after cooldown', async () => {
    let calls = 0;
    let now = 0;
    const failing = async () => { calls += 1; throw new Error('boom'); };
    const a = adapterWith(failing as never, { breakerThreshold: 3, breakerCooldownMs: 1000 }, () => now);

    await a.search('a'); await a.search('b'); await a.search('c');
    expect(calls).toBe(3);
    // Open: no network call, instant typed answer.
    expect(await a.search('d')).toEqual({ state: 'provider-unavailable', reason: 'circuit-open' });
    expect(calls).toBe(3);
    // After cooldown: half-open lets one probe through.
    now = 1001;
    await a.search('e');
    expect(calls).toBe(4);
  });

  it('RESULT CEILING: caller limits above the ceiling are clamped', async () => {
    const seen: FetchArgs[] = [];
    const a = adapterWith(async (url) => { seen.push({ url }); return okJson({ hits: [] }); }, { resultCeiling: 5 });
    await a.search('cafe', { limit: 500 });
    expect(seen[0].url).toContain('per_page=5');
  });

  it('D10: an exact normalized-handle match is pinned ahead of fuzzy hits', async () => {
    const a = adapterWith(async () =>
      okJson({
        hits: [
          { document: { id: 'u2', kind: 'username', handle: 'priya_kk', normalizedHandle: 'priya_kk', displayName: 'Priya KK' }, text_match: 9e11 },
          { document: { id: 'u1', kind: 'username', handle: 'Priya_K', normalizedHandle: 'priya_k', displayName: 'Priya' }, text_match: 5e11 },
        ],
      }));
    const res = await a.search('Priya_K');
    expect(res.state).toBe('ok');
    if (res.state === 'ok') {
      expect(res.hits[0].id).toBe('u1');
      expect(res.hits[0].exactHandleMatch).toBe(true);
    }
  });

  it('INDEX ALLOW-LIST: coordinates and private fields can never ride into a document', async () => {
    const bodies: string[] = [];
    const a = adapterWith(async (_url, init) => { if (init?.body) bodies.push(init.body); return okJson({}); });
    const poisoned = {
      id: 'u1', kind: 'username', handle: 'h', normalizedHandle: 'h', displayName: 'H',
      lat: 12.9716, lon: 77.5946, coords: { lat: 1 }, phone: '+911234567890', email: 'x@y.z', privateNote: 'secret',
    } as never;
    await a.indexDoc(poisoned);
    expect(bodies).toHaveLength(1);
    for (const banned of ['lat', 'lon', 'coords', 'phone', 'email', 'privateNote', '12.9716']) {
      expect(bodies[0]).not.toContain(banned);
    }
  });

  it('INDEX VALUE SCREEN: a coordinate string inside an allow-listed field is dropped (F8)', async () => {
    const bodies: string[] = [];
    const a = adapterWith(async (_url, init) => { if (init?.body) bodies.push(init.body); return okJson({}); });
    // A projection-builder bug leaks a coordinate into localityLabels / aliases —
    // schema-legal KEYS, but the VALUE is a location.
    await a.indexDoc({
      id: 'u2', kind: 'place', name: 'Cafe', localityLabels: ['12.9716,77.5946', 'Indiranagar'],
      aliases: ['77.59460'],
    } as never);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('12.9716');
    expect(bodies[0]).not.toContain('77.59460');
    expect(bodies[0]).toContain('Indiranagar'); // the honest label survives
  });

  it('4xx IS a failure, not silent no-results (F10)', async () => {
    let calls = 0;
    const a = adapterWith(async () => { calls += 1; return { ok: false, status: 401, json: async () => ({ hits: [] }) }; });
    const out = await a.search('priya', { kind: 'username' });
    expect(out.state).toBe('provider-unavailable'); // never 'no-results'
    expect(calls).toBe(1);
  });

  it('the committed schema itself contains no coordinate field', () => {
    const names = TYPESENSE_SCHEMA.fields.map((f) => f.name).join(',');
    for (const banned of ['lat', 'lon', 'geo', 'coord', 'location']) {
      expect(names.toLowerCase()).not.toContain(banned);
    }
  });

  it('empty/whitespace queries are no-results without any network call', async () => {
    const a = adapterWith(async () => { throw new Error('must not be called'); });
    expect(await a.search('   ')).toEqual({ state: 'no-results' });
  });
});

describe('typesense adapter — LIVE (loud-skip without TEST_TYPESENSE_URL)', () => {
  const url = process.env.TEST_TYPESENSE_URL;
  const key = process.env.TEST_TYPESENSE_KEY ?? 'spotme-dev-only-typesense';
  if (!url) {
    // eslint-disable-next-line no-console
    console.warn('[discovery-search] no TEST_TYPESENSE_URL — live typo/prefix tests skipped');
  }

  (url ? it : it.skip)('typo tolerance and prefix search work against the real engine', async () => {
    const a = new TypesenseSearchAdapter({ ...TYPESENSE_DEFAULTS, url, apiKey: key });
    // Fresh collection for this run.
    await fetch(`${url}/collections/discovery_public`, { method: 'DELETE', headers: { 'X-TYPESENSE-API-KEY': key } }).catch(() => undefined);
    const schema = JSON.parse(JSON.stringify(TYPESENSE_SCHEMA));
    const created = await fetch(`${url}/collections`, {
      method: 'POST', headers: { 'X-TYPESENSE-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(schema),
    });
    expect(created.ok).toBe(true);

    await a.indexDoc({ id: 'u1', kind: 'username', handle: 'priya_k', normalizedHandle: 'priya_k', displayName: 'Priya Kumar' });
    await a.indexDoc({ id: 'p1', kind: 'place', name: 'Cubbon Coffee House', category: 'cafe', localityLabels: ['Cubbon'] });

    const typo = await a.search('pryia');           // transposition typo
    expect(typo.state).toBe('ok');
    const prefix = await a.search('cub', { kind: 'place' });
    expect(prefix.state).toBe('ok');
    if (prefix.state === 'ok') expect(prefix.hits[0].id).toBe('p1');
  }, 30000);
});
