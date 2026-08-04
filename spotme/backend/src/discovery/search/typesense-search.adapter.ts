/**
 * Typesense adapter behind SearchPort (checkpoint 6) — DARK.
 *
 * Plain-fetch client (no new dependency) for exactly the operations the port
 * needs. DISABLED cleanly without configuration: when TYPESENSE_URL /
 * TYPESENSE_API_KEY (env) are absent every call returns the typed
 * 'provider-unavailable' state — the deterministic fallback; results are never
 * fabricated (P4). The URL/key are never logged.
 *
 * Reliability contract (mission checkpoint 6):
 *  - bounded result count (RESULT_CEILING regardless of caller);
 *  - per-query timeout (AbortController);
 *  - circuit breaker: OPEN after `breakerThreshold` consecutive failures,
 *    half-open after `breakerCooldownMs`; open circuit answers instantly with
 *    'provider-unavailable' instead of hammering a dead engine;
 *  - exact-username priority: an exact normalized-handle match is pinned
 *    ahead of fuzzy hits (D10);
 *  - typo tolerance + prefix search are engine defaults, verified by the
 *    loud-skip live spec (TEST_TYPESENSE_URL) — never claimed from mocks.
 */

import { Injectable } from '@nestjs/common';
import { normalizeSearchText } from './normalize';
import {
  SearchHit,
  SearchIndexDoc,
  SearchPort,
  SearchQueryOptions,
  SearchResult,
} from './search.port';

export const TYPESENSE_COLLECTION = 'discovery_public';

/** A decimal-degree / coordinate-pair shape that must never enter the index,
 *  even inside an allow-listed string field (F8 — value screening, not just
 *  key screening). Legitimate handles/labels never carry this shape. */
const COORDINATE_SHAPE = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/;

/** Drop a coordinate-shaped string value; recurse arrays; pass everything else
 *  through unchanged. A projection-builder bug can no longer index a location. */
function coordinateSafe(v: unknown): unknown {
  if (typeof v === 'string') return COORDINATE_SHAPE.test(v) ? '' : v;
  if (Array.isArray(v)) return v.map(coordinateSafe).filter((x) => x !== '');
  return v;
}

/** The complete index schema — privacy-safe projections ONLY (C-INDEX-MIN). */
export const TYPESENSE_SCHEMA = {
  name: TYPESENSE_COLLECTION,
  fields: [
    { name: 'kind', type: 'string', facet: true },
    { name: 'handle', type: 'string', optional: true },
    { name: 'normalizedHandle', type: 'string', optional: true },
    { name: 'displayName', type: 'string', optional: true },
    { name: 'aliases', type: 'string[]', optional: true },
    { name: 'name', type: 'string', optional: true },
    { name: 'category', type: 'string', optional: true, facet: true },
    { name: 'localityLabels', type: 'string[]', optional: true },
    { name: 'intentLabels', type: 'string[]', optional: true },
    // NO coordinate field exists in this schema — by design (T-EXACT).
  ],
} as const;

export interface TypesenseAdapterConfig {
  url?: string;
  apiKey?: string;
  timeoutMs: number;
  resultCeiling: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

export const TYPESENSE_DEFAULTS: Omit<TypesenseAdapterConfig, 'url' | 'apiKey'> = {
  timeoutMs: 2_000,
  resultCeiling: 20,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
};

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

@Injectable()
export class TypesenseSearchAdapter implements SearchPort {
  readonly name = 'typesense';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly cfg: TypesenseAdapterConfig = {
      ...TYPESENSE_DEFAULTS,
      ...(process.env.TYPESENSE_URL ? { url: process.env.TYPESENSE_URL } : {}),
      ...(process.env.TYPESENSE_API_KEY ? { apiKey: process.env.TYPESENSE_API_KEY } : {}),
    },
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private get configured(): boolean {
    return Boolean(this.cfg.url && this.cfg.apiKey);
  }

  private breakerOpen(): boolean {
    if (this.failures < this.cfg.breakerThreshold) return false;
    if (this.clock() - this.openedAt >= this.cfg.breakerCooldownMs) {
      // Half-open: allow one probe through.
      this.failures = this.cfg.breakerThreshold - 1;
      return false;
    }
    return true;
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures === this.cfg.breakerThreshold) this.openedAt = this.clock();
  }

  private async request(path: string, init?: Parameters<FetchLike>[1]): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.url}${path}`, {
        ...init,
        headers: { 'X-TYPESENSE-API-KEY': this.cfg.apiKey as string, 'Content-Type': 'application/json', ...init?.headers },
        signal: ctrl.signal,
      });
      // ANY non-2xx is a failure (F10): a 401/403/404 must surface as typed
      // provider-unavailability, not parse to zero hits and masquerade as
      // no-results while silently resetting the breaker (P4 honesty).
      if (!res.ok) throw new Error(`typesense ${res.status}`);
      this.failures = 0;
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, opts: SearchQueryOptions = {}): Promise<SearchResult> {
    if (!this.configured) return { state: 'provider-unavailable', reason: 'unconfigured' };
    if (this.breakerOpen()) return { state: 'provider-unavailable', reason: 'circuit-open' };

    const q = normalizeSearchText(query);
    if (!q) return { state: 'no-results' };
    const limit = Math.min(opts.limit ?? this.cfg.resultCeiling, this.cfg.resultCeiling);

    try {
      const params = new URLSearchParams({
        q,
        query_by: 'normalizedHandle,handle,displayName,aliases,name,category,localityLabels',
        per_page: String(limit),
        num_typos: '2',
        prefix: 'true',
        ...(opts.kind ? { filter_by: `kind:=${opts.kind}` } : {}),
      });
      const body = (await this.request(
        `/collections/${TYPESENSE_COLLECTION}/documents/search?${params}`,
      )) as { hits?: { document: Record<string, unknown>; text_match?: number }[] };

      const hits: SearchHit[] = (body.hits ?? []).slice(0, limit).map((h) => {
        const d = h.document;
        return {
          id: String(d.id),
          kind: (d.kind as 'username' | 'place') ?? 'username',
          exactHandleMatch: typeof d.normalizedHandle === 'string' && d.normalizedHandle === q,
          fields: {
            handle: d.handle as string | undefined,
            displayName: d.displayName as string | undefined,
            name: d.name as string | undefined,
            category: d.category as string | undefined,
            localityLabels: d.localityLabels as string[] | undefined,
          },
          score: typeof h.text_match === 'number' ? Math.min(1, h.text_match / 1e11) : undefined,
        };
      });

      // D10: exact normalized-handle matches are pinned first, deterministically.
      hits.sort((a, b) =>
        Number(Boolean(b.exactHandleMatch)) - Number(Boolean(a.exactHandleMatch)) || a.id.localeCompare(b.id));

      return hits.length ? { state: 'ok', hits } : { state: 'no-results' };
    } catch (e) {
      this.recordFailure();
      const reason = (e as Error).name === 'AbortError' ? 'timeout' : 'error';
      return { state: 'provider-unavailable', reason };
    }
  }

  async indexDoc(doc: SearchIndexDoc): Promise<{ ok: boolean }> {
    if (!this.configured || this.breakerOpen()) return { ok: false };
    // Allow-list projection: ONLY schema fields are sent, whatever the caller
    // attached (a coordinate or private field can never ride along).
    const allowed = new Set<string>(TYPESENSE_SCHEMA.fields.map((f) => f.name));
    const clean: Record<string, unknown> = { id: doc.id };
    for (const [k, v] of Object.entries(doc)) if (allowed.has(k)) clean[k] = coordinateSafe(v);
    try {
      await this.request(`/collections/${TYPESENSE_COLLECTION}/documents?action=upsert`, {
        method: 'POST',
        body: JSON.stringify(clean),
      });
      return { ok: true };
    } catch {
      this.recordFailure();
      return { ok: false };
    }
  }

  async removeDoc(id: string): Promise<{ ok: boolean }> {
    if (!this.configured || this.breakerOpen()) return { ok: false };
    try {
      await this.request(`/collections/${TYPESENSE_COLLECTION}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { ok: true };
    } catch {
      this.recordFailure();
      return { ok: false };
    }
  }

  async health(): Promise<'ok' | 'unavailable'> {
    if (!this.configured) return 'unavailable';
    try {
      await this.request('/health');
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }
}
