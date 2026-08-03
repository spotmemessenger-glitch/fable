/**
 * Search benchmark — Meilisearch vs Typesense on a synthetic Spot Me corpus.
 *
 * REPORTS NUMBERS ONLY. It wires nothing into the app and expresses no
 * preference — the owner picks the engine from the table this prints. Run it
 * against the dev compose stack (spotme/docker-compose.dev.yml) or any reachable
 * Meilisearch + Typesense.
 *
 *   MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=… \
 *   TS_HOST=127.0.0.1 TS_PORT=8108 TS_KEY=… \
 *   [CORPUS_SIZE=20000] [MEILI_PID=… TS_PID=…] node bench.mjs
 *
 * Measures: index time, query p50/p95 latency, typo-tolerance hit rate, and a
 * memory figure (process RSS when a PID is provided, else the engine's own
 * reported figure). Identical seeded corpus for both engines.
 */
import { MeiliSearch } from 'meilisearch';
import Typesense from 'typesense';
import { readFileSync } from 'node:fs';
import { buildCorpus, QUERIES } from './corpus.mjs';

const CORPUS_SIZE = Number(process.env.CORPUS_SIZE ?? 20000);
const QUERY_REPS = Number(process.env.QUERY_REPS ?? 30);

const now = () => performance.now();
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const rssMB = (pid) => {
  if (!pid) return null;
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
};

async function benchMeili(docs) {
  const client = new MeiliSearch({ host: process.env.MEILI_URL ?? 'http://127.0.0.1:7700', apiKey: process.env.MEILI_KEY });
  try { await client.deleteIndex('bench'); await new Promise((r) => setTimeout(r, 500)); } catch { /* fresh */ }

  const idxTask = await client.createIndex('bench', { primaryKey: 'id' });
  await client.waitForTask(idxTask.taskUid);
  const index = client.index('bench');
  await client.waitForTask((await index.updateSearchableAttributes(['title', 'text', 'category', 'tags'])).taskUid);

  const t0 = now();
  const batchSize = 5000;
  const tasks = [];
  for (let i = 0; i < docs.length; i += batchSize) {
    tasks.push((await index.addDocuments(docs.slice(i, i + batchSize))).taskUid);
  }
  for (const t of tasks) await client.waitForTask(t, { timeOutMs: 120000 });
  const indexMs = now() - t0;

  const latencies = [];
  let typoHits = 0;
  for (let rep = 0; rep < QUERY_REPS; rep++) {
    for (const q of [...QUERIES.exact, ...QUERIES.partial]) {
      const s = now(); await index.search(q, { limit: 20 }); latencies.push(now() - s);
    }
  }
  for (const { q, expect } of QUERIES.typo) {
    const res = await index.search(q, { limit: 20 });
    if (res.hits.some((h) => `${h.title} ${h.text}`.toLowerCase().includes(expect))) typoHits++;
  }
  const stats = await client.index('bench').getStats().catch(() => null);
  return {
    engine: 'Meilisearch',
    indexMs, docs: docs.length,
    p50: pct(latencies, 50), p95: pct(latencies, 95),
    typoHitRate: typoHits / QUERIES.typo.length,
    memMB: rssMB(process.env.MEILI_PID),
    reported: stats ? `numberOfDocuments=${stats.numberOfDocuments}` : null,
  };
}

async function benchTypesense(docs) {
  const client = new Typesense.Client({
    nodes: [{ host: process.env.TS_HOST ?? '127.0.0.1', port: Number(process.env.TS_PORT ?? 8108), protocol: 'http' }],
    apiKey: process.env.TS_KEY ?? 'xyz',
    connectionTimeoutSeconds: 120,
  });
  try { await client.collections('bench').delete(); } catch { /* fresh */ }
  await client.collections().create({
    name: 'bench',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'text', type: 'string' },
      { name: 'category', type: 'string', facet: true },
      { name: 'tags', type: 'string[]' },
      { name: 'kind', type: 'string', facet: true },
      { name: 'geoCell', type: 'string' },
    ],
  });

  const t0 = now();
  await client.collections('bench').documents().import(docs, { action: 'create', batch_size: 5000 });
  const indexMs = now() - t0;

  const search = (q) => client.collections('bench').documents().search({ q, query_by: 'title,text,category,tags', per_page: 20 });
  const latencies = [];
  let typoHits = 0;
  for (let rep = 0; rep < QUERY_REPS; rep++) {
    for (const q of [...QUERIES.exact, ...QUERIES.partial]) {
      const s = now(); await search(q); latencies.push(now() - s);
    }
  }
  for (const { q, expect } of QUERIES.typo) {
    const res = await search(q);
    if ((res.hits ?? []).some((h) => `${h.document.title} ${h.document.text}`.toLowerCase().includes(expect))) typoHits++;
  }
  let memMB = rssMB(process.env.TS_PID);
  let reported = null;
  try {
    const metrics = await client.metrics.retrieve();
    reported = `memory_active=${Math.round(Number(metrics['typesense_memory_active_bytes'] ?? 0) / 1048576)}MB`;
    if (memMB == null && metrics['typesense_memory_resident_bytes']) memMB = Math.round(Number(metrics['typesense_memory_resident_bytes']) / 1048576);
  } catch { /* metrics optional */ }
  return {
    engine: 'Typesense', indexMs, docs: docs.length,
    p50: pct(latencies, 50), p95: pct(latencies, 95),
    typoHitRate: typoHits / QUERIES.typo.length, memMB, reported,
  };
}

function table(rows) {
  const f = (n) => (n == null ? 'n/a' : typeof n === 'number' ? n.toFixed(2) : String(n));
  const cols = [
    ['Engine', (r) => r.engine],
    ['Docs', (r) => String(r.docs)],
    ['Index (ms)', (r) => f(r.indexMs)],
    ['Index (docs/s)', (r) => f((r.docs / r.indexMs) * 1000)],
    ['Query p50 (ms)', (r) => f(r.p50)],
    ['Query p95 (ms)', (r) => f(r.p95)],
    ['Typo hit rate', (r) => `${Math.round(r.typoHitRate * 100)}%`],
    ['Mem RSS (MB)', (r) => f(r.memMB)],
  ];
  const header = cols.map((c) => c[0]).join(' | ');
  const sep = cols.map((c) => '-'.repeat(c[0].length)).join('-|-');
  console.log('\n' + header);
  console.log(sep);
  for (const r of rows) console.log(cols.map((c) => c[1](r)).join(' | '));
  console.log('');
}

async function main() {
  console.log(`[search-bench] building corpus: ${CORPUS_SIZE} docs, ${QUERY_REPS} reps/query`);
  const docs = buildCorpus(CORPUS_SIZE);
  const rows = [];
  try { rows.push(await benchMeili(docs)); } catch (e) { console.error('Meilisearch bench failed:', e.message); }
  try { rows.push(await benchTypesense(docs)); } catch (e) { console.error('Typesense bench failed:', e.message); }
  table(rows);
  console.log('[search-bench] numbers only — engine choice is the owner\'s.');
  return rows;
}

main().then((rows) => {
  process.stdout.write('RESULT_JSON=' + JSON.stringify(rows) + '\n');
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
