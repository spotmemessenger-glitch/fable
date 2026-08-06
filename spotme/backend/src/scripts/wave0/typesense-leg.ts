/**
 * Wave 0 — Typesense leg. IN-NETWORK ONLY (TYPESENSE_URL is a scheme-less
 * private `host:port`).
 *
 * Dependency-free (uses fetch against the Typesense REST API) so it runs inside
 * the deployed backend image. It proves connectivity + version and functionally
 * round-trips a small `wave0_` collection (create → index → query → drop),
 * recording real indexing throughput and warm query p50/p95.
 *
 * SCOPE NOTE: the AUTHORITATIVE mandatory re-benchmark (20,000-doc corpus vs the
 * recorded Typesense 27.1 baseline — 33,603 docs/s, warm p50/p95 3.60/5.05 ms)
 * is run by the committed `@spotme/search-bench` package (`node bench.mjs`),
 * which is NOT in this backend image. DEPLOYMENT.md documents the exact
 * in-network command. This leg does not simulate or estimate those numbers; it
 * establishes connectivity + a functional smoke and leaves the CONFIRMS /
 * RESERVATIONS / CHALLENGES verdict to the full bench run.
 */

import { LegResult, percentiles, round2, timed } from './guard';

const COLLECTION = 'wave0_smoke';
const SMOKE_DOCS = Number(process.env.WAVE0_TS_DOCS || '500');
const WARM_QUERIES = Number(process.env.WAVE0_TS_QUERIES || '50');

function baseUrl(): string {
  const raw = (process.env.TYPESENSE_URL || '').trim();
  if (!raw) throw new Error('TYPESENSE_URL unset');
  if (/^https?:\/\//.test(raw)) return raw.replace(/\/$/, '');
  return `http://${raw.replace(/\/$/, '')}`; // scheme-less internal host:port
}

async function ts(path: string, init: RequestInit = {}): Promise<Response> {
  const key = process.env.TYPESENSE_API_KEY || '';
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'x-typesense-api-key': key, 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

export async function runTypesenseLeg(): Promise<LegResult> {
  const notes: string[] = [];
  const detail: Record<string, unknown> = { collection: COLLECTION, smokeDocs: SMOKE_DOCS, warmQueries: WARM_QUERIES };

  try {
    // --- health + version ---
    const health = await timed(async () => (await ts('/health')).json());
    detail.healthMs = round2(health.ms);
    detail.healthy = Boolean((health.value as { ok?: boolean } | undefined)?.ok);
    const dbg = await timed(async () => (await ts('/debug')).json());
    detail.version = (dbg.value as { version?: string } | undefined)?.version ?? null;
    if (!detail.healthy) {
      notes.push(`Typesense health not ok: ${health.error ?? 'no ok flag'}`);
      return { leg: 'typesense', status: 'FAIL', detail, notes };
    }

    // --- (re)create wave0_ collection ---
    await ts(`/collections/${COLLECTION}`, { method: 'DELETE' }).catch(() => undefined);
    const create = await ts('/collections', {
      method: 'POST',
      body: JSON.stringify({
        name: COLLECTION,
        fields: [
          { name: 'title', type: 'string' },
          { name: 'body', type: 'string' },
          { name: 'n', type: 'int32' },
        ],
      }),
    });
    if (!create.ok) {
      notes.push(`collection create failed: HTTP ${create.status}`);
      return { leg: 'typesense', status: 'FAIL', detail, notes };
    }

    // --- index a small wave0 corpus (JSONL import) ---
    const docs = Array.from({ length: SMOKE_DOCS }, (_v, i) =>
      JSON.stringify({ id: `wave0-${i}`, title: `wave0 doc ${i}`, body: `nearby place ${i % 37} coffee park venue`, n: i }),
    ).join('\n');
    const index = await timed(async () => {
      const res = await ts(`/collections/${COLLECTION}/documents/import?action=create`, { method: 'POST', body: docs });
      if (!res.ok) throw new Error(`import HTTP ${res.status}`);
      return res.text();
    });
    detail.indexMs = round2(index.ms);
    detail.indexDocsPerSec = index.ms > 0 ? round2((SMOKE_DOCS / index.ms) * 1000) : null;
    if (index.error) {
      notes.push(`indexing failed: ${index.error}`);
      return { leg: 'typesense', status: 'FAIL', detail, notes };
    }

    // --- warm query set, p50/p95 ---
    const terms = ['coffee', 'park', 'venue', 'nearby', 'place'];
    let errors = 0;
    const samples: number[] = [];
    for (let i = 0; i < WARM_QUERIES; i++) {
      const q = terms[i % terms.length];
      const one = await timed(async () => {
        const res = await ts(`/collections/${COLLECTION}/documents/search?q=${q}&query_by=title,body`);
        if (!res.ok) throw new Error(`search HTTP ${res.status}`);
        return res.json();
      });
      if (one.error) errors++;
      else samples.push(one.ms);
    }
    detail.query = { ...percentiles(samples), errors };

    detail.baseline = { engine: 'Typesense 27.1', corpus: 20000, indexDocsPerSec: 33603, warmP50: 3.6, warmP95: 5.05 };
    // ADDENDA #2: this in-image smoke (500 docs, fetch-based, different corpus/seed/
    // schema/query-set/methodology) is NOT the committed @spotme/search-bench 20k
    // harness — which is not in the backend image. So the comparison is INCOMPARABLE;
    // the smoke numbers are connectivity/functional evidence only, never a verdict.
    detail.comparability = 'INCOMPARABLE';
    detail.versionGap = `cluster ${detail.version ?? 'v30.x'} vs baseline 27.1 — major-version gap; note in any verdict`;
    detail.benchmarkConclusion =
      'INCOMPARABLE — the authoritative 20k re-benchmark (CONFIRMS/RESERVATIONS/CHALLENGES vs 27.1) must be run via the committed @spotme/search-bench in-network (owner action, see DEPLOYMENT.md §5). Not approximated here.';
    notes.push(`Typesense ${detail.version ?? '?'} reachable; ${SMOKE_DOCS}-doc functional smoke + ${samples.length} warm queries (connectivity evidence ONLY).`);
    notes.push('Benchmark comparison = INCOMPARABLE: in-image smoke != committed 20k harness; version gap v30.x vs 27.1.');

    return { leg: 'typesense', status: 'PASS', detail, notes };
  } catch (e) {
    notes.push(`typesense leg error: ${(e as Error).message}`);
    return { leg: 'typesense', status: 'FAIL', detail, notes };
  } finally {
    await ts(`/collections/${COLLECTION}`, { method: 'DELETE' }).catch(() => undefined);
  }
}
