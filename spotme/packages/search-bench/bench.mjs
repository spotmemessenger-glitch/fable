/**
 * Search benchmark — Meilisearch vs Typesense on a synthetic Spot Me corpus.
 *
 * REPORTS NUMBERS ONLY. It wires nothing into the app and expresses no
 * preference — the owner picks the engine from what this prints. Run it against
 * the dev compose stack's `search-benchmark` profile or any reachable pair of
 * engines.
 *
 *   MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=… \
 *   TS_HOST=127.0.0.1 TS_PORT=8108 TS_KEY=… \
 *   [CORPUS_SIZE=20000] [RUNS=3] [WARMUP_PASSES=2] [WARM_PASSES=10] \
 *   [MEILI_PID=… TS_PID=… MEILI_DATA_DIR=… TS_DATA_DIR=…] node bench.mjs
 *
 * METHODOLOGY (the manifest records all of it, so a run is reproducible):
 * - The corpus is seeded and deterministic (corpus.mjs) — identical for both
 *   engines and across runs.
 * - Each RUN is a full cycle: drop index → re-index (timed) → one COLD pass
 *   over the query set (timed; the first queries the fresh index ever sees)
 *   → WARMUP_PASSES unmeasured passes → WARM_PASSES measured passes.
 * - Latency percentiles are computed per category: cold latencies pooled
 *   across runs; warm latencies pooled across runs. Index time is reported as
 *   median across runs. Typo hit-rate is checked on the final run (the corpus
 *   and queries are deterministic, so it cannot differ between runs).
 * - Memory: process RSS from /proc/<pid>/status when a PID is provided
 *   (VmRSS, MB), read AFTER the final run; engine self-reported figures are
 *   captured alongside. Index size: engine-reported where the API offers it
 *   (Meilisearch /stats databaseSize) plus `du -sb` of the data dir when
 *   *_DATA_DIR is provided.
 * - Measurement is end-to-end client round-trip (performance.now around the
 *   HTTP call from Node) — what an application would actually experience.
 *
 * Nothing generated here (indexes, data dirs, result files) is committed.
 */
import { MeiliSearch } from 'meilisearch';
import Typesense from 'typesense';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { buildCorpus, QUERIES, CORPUS_SEED } from './corpus.mjs';

const CORPUS_SIZE = Number(process.env.CORPUS_SIZE ?? 20000);
const RUNS = Number(process.env.RUNS ?? 3);
const WARMUP_PASSES = Number(process.env.WARMUP_PASSES ?? 2);
const WARM_PASSES = Number(process.env.WARM_PASSES ?? 10);

const now = () => performance.now();
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (arr) => pct(arr, 50);

const rssMB = (pid) => {
  if (!pid) return null;
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
};

const duMB = (dir) => {
  if (!dir) return null;
  try {
    return Math.round(Number(execFileSync('du', ['-sb', dir]).toString().split('\t')[0]) / 1048576 * 10) / 10;
  } catch {
    return null;
  }
};

/** One engine's full multi-run cycle. `hooks` abstracts the engine specifics. */
async function benchEngine(hooks, docs) {
  const indexTimes = [];
  const cold = [];
  const warm = [];
  let typoHits = 0;
  const allQueries = [...QUERIES.exact, ...QUERIES.partial];

  for (let run = 0; run < RUNS; run++) {
    await hooks.dropIndex();
    const t0 = now();
    await hooks.createAndIndex(docs);
    indexTimes.push(now() - t0);

    // COLD: the first pass the fresh index ever serves.
    for (const q of allQueries) {
      const s = now(); await hooks.search(q); cold.push(now() - s);
    }
    // WARM-UP: unmeasured.
    for (let p = 0; p < WARMUP_PASSES; p++) {
      for (const q of allQueries) await hooks.search(q);
    }
    // WARM: measured.
    for (let p = 0; p < WARM_PASSES; p++) {
      for (const q of allQueries) {
        const s = now(); await hooks.search(q); warm.push(now() - s);
      }
    }
    // Typo tolerance (deterministic; checked on the final run).
    if (run === RUNS - 1) {
      for (const { q, expect } of QUERIES.typo) {
        const hits = await hooks.searchHits(q);
        if (hits.some((h) => h.toLowerCase().includes(expect))) typoHits++;
      }
    }
  }

  return {
    engine: hooks.name,
    version: await hooks.version(),
    docs: docs.length,
    indexMsMedian: median(indexTimes),
    indexTimesMs: indexTimes.map((t) => Math.round(t)),
    coldP50: pct(cold, 50), coldP95: pct(cold, 95),
    warmP50: pct(warm, 50), warmP95: pct(warm, 95),
    coldSamples: cold.length, warmSamples: warm.length,
    typoHitRate: typoHits / QUERIES.typo.length,
    memRssMB: rssMB(hooks.pid),
    engineReported: await hooks.reported(),
    indexDiskMB: duMB(hooks.dataDir),
  };
}

function meiliHooks() {
  const client = new MeiliSearch({ host: process.env.MEILI_URL ?? 'http://127.0.0.1:7700', apiKey: process.env.MEILI_KEY });
  const search = (q) => client.index('bench').search(q, { limit: 20 });
  return {
    name: 'Meilisearch',
    pid: process.env.MEILI_PID,
    dataDir: process.env.MEILI_DATA_DIR,
    version: async () => (await client.getVersion()).pkgVersion,
    dropIndex: async () => {
      try { const t = await client.deleteIndex('bench'); await client.waitForTask(t.taskUid); } catch { /* fresh */ }
    },
    createAndIndex: async (docs) => {
      const t = await client.createIndex('bench', { primaryKey: 'id' });
      await client.waitForTask(t.taskUid);
      const index = client.index('bench');
      await client.waitForTask((await index.updateSearchableAttributes(['title', 'text', 'category', 'tags'])).taskUid);
      const tasks = [];
      for (let i = 0; i < docs.length; i += 5000) {
        tasks.push((await index.addDocuments(docs.slice(i, i + 5000))).taskUid);
      }
      for (const tu of tasks) await client.waitForTask(tu, { timeOutMs: 120000 });
    },
    search,
    searchHits: async (q) => (await search(q)).hits.map((h) => `${h.title} ${h.text}`),
    reported: async () => {
      try {
        const stats = await client.getStats();
        return { databaseSizeMB: Math.round((stats.databaseSize ?? 0) / 1048576 * 10) / 10 };
      } catch { return null; }
    },
  };
}

function typesenseHooks() {
  const client = new Typesense.Client({
    nodes: [{ host: process.env.TS_HOST ?? '127.0.0.1', port: Number(process.env.TS_PORT ?? 8108), protocol: 'http' }],
    apiKey: process.env.TS_KEY ?? 'xyz',
    connectionTimeoutSeconds: 120,
  });
  const search = (q) => client.collections('bench').documents().search({ q, query_by: 'title,text,category,tags', per_page: 20 });
  return {
    name: 'Typesense',
    pid: process.env.TS_PID,
    dataDir: process.env.TS_DATA_DIR,
    version: async () => {
      try { return (await client.debug.retrieve()).version; } catch { return 'unknown'; }
    },
    dropIndex: async () => {
      try { await client.collections('bench').delete(); } catch { /* fresh */ }
    },
    createAndIndex: async (docs) => {
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
      await client.collections('bench').documents().import(docs, { action: 'create', batch_size: 5000 });
    },
    search,
    searchHits: async (q) => ((await search(q)).hits ?? []).map((h) => `${h.document.title} ${h.document.text}`),
    reported: async () => {
      try {
        const m = await client.metrics.retrieve();
        return {
          memoryActiveMB: Math.round(Number(m['typesense_memory_active_bytes'] ?? 0) / 1048576),
          memoryResidentMB: Math.round(Number(m['typesense_memory_resident_bytes'] ?? 0) / 1048576),
        };
      } catch { return null; }
    },
  };
}

function manifest() {
  return {
    recordedAt: new Date().toISOString(),
    methodology: {
      runs: RUNS,
      perRun: 'drop index → re-index (timed) → 1 COLD pass (timed) → ' +
        `${WARMUP_PASSES} warm-up passes (unmeasured) → ${WARM_PASSES} WARM passes (timed)`,
      latency: 'end-to-end client round-trip, performance.now() around each HTTP call from Node',
      percentiles: 'cold pooled across runs; warm pooled across runs; index time = median of runs',
      memory: 'VmRSS from /proc/<pid>/status after the final run (MB); engine self-reports alongside',
      indexSize: 'engine-reported where available + du -sb of the data dir when *_DATA_DIR set',
    },
    corpus: {
      seed: CORPUS_SEED,
      size: CORPUS_SIZE,
      composition: '~34% usernames, ~33% places, ~33% Exchange need/offer listings (deterministic, corpus.mjs)',
    },
    querySet: {
      exact: QUERIES.exact.length,
      partial: QUERIES.partial.length,
      typo: QUERIES.typo.length,
      note: 'committed verbatim in corpus.mjs',
    },
    environment: {
      node: process.version,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      totalMemGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
      platform: `${os.platform()} ${os.release()}`,
    },
    engineConfig: {
      meilisearch: 'defaults + searchableAttributes [title,text,category,tags]; batch 5000; dev master key',
      typesense: 'defaults; schema title/text/category(facet)/tags[]/kind(facet)/geoCell; query_by title,text,category,tags; batch 5000',
    },
  };
}

function table(rows) {
  const f = (n) => (n == null ? 'n/a' : typeof n === 'number' ? n.toFixed(2) : String(n));
  const cols = [
    ['Engine', (r) => `${r.engine} ${r.version}`],
    ['Docs', (r) => String(r.docs)],
    ['Index med (ms)', (r) => f(r.indexMsMedian)],
    ['Index (docs/s)', (r) => f((r.docs / r.indexMsMedian) * 1000)],
    ['Cold p50/p95 (ms)', (r) => `${f(r.coldP50)} / ${f(r.coldP95)}`],
    ['Warm p50/p95 (ms)', (r) => `${f(r.warmP50)} / ${f(r.warmP95)}`],
    ['Typo hits', (r) => `${Math.round(r.typoHitRate * 100)}%`],
    ['RSS (MB)', (r) => f(r.memRssMB)],
    ['Index disk (MB)', (r) => f(r.indexDiskMB)],
  ];
  console.log('\n' + cols.map((c) => c[0]).join(' | '));
  console.log(cols.map((c) => '-'.repeat(c[0].length)).join('-|-'));
  for (const r of rows) console.log(cols.map((c) => c[1](r)).join(' | '));
  console.log('');
}

async function main() {
  const m = manifest();
  console.log('[search-bench] manifest:');
  console.log(JSON.stringify(m, null, 2));
  console.log(`\n[search-bench] building corpus: ${CORPUS_SIZE} docs (seed ${CORPUS_SEED})`);
  const docs = buildCorpus(CORPUS_SIZE, CORPUS_SEED);

  const rows = [];
  try { rows.push(await benchEngine(meiliHooks(), docs)); } catch (e) { console.error('Meilisearch bench failed:', e.message); }
  try { rows.push(await benchEngine(typesenseHooks(), docs)); } catch (e) { console.error('Typesense bench failed:', e.message); }

  table(rows);
  console.log('[search-bench] per-run index times (ms):');
  for (const r of rows) console.log(`  ${r.engine}: [${r.indexTimesMs.join(', ')}] · cold samples ${r.coldSamples} · warm samples ${r.warmSamples}`);
  for (const r of rows) console.log(`  ${r.engine} engine-reported: ${JSON.stringify(r.engineReported)}`);
  console.log('\n[search-bench] numbers only — engine choice is the owner\'s.');
  return { manifest: m, results: rows };
}

main().then((out) => {
  process.stdout.write('RESULT_JSON=' + JSON.stringify(out) + '\n');
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
