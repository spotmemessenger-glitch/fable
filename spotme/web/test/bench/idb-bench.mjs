/**
 * IndexedDB and media-path benchmarks — the Priority 1 baseline.
 *
 *   node test/bench/idb-bench.mjs                  # human summary
 *   node test/bench/idb-bench.mjs --json out.json  # raw results too
 *
 * WHY A REAL BROWSER AND NOT `fake-indexeddb`. Node has no IndexedDB, and the
 * usual shim is a JavaScript reimplementation. Benchmarking it would produce
 * numbers that LOOK like measurements and describe the shim's `Map` operations
 * rather than a browser's transaction, serialization and disk behaviour — which
 * is the entire thing under test. Every number below comes from real Chromium
 * driving the real `src/lib/blobstore.js`, which is also what the Android
 * Capacitor WebView runs.
 *
 * WHAT IS MEASURED
 *   put / get / del            across four payload sizes
 *   cold vs warm open          first transaction after a fresh page, versus
 *                              one on an already-open connection
 *   delRoom                    the prefix-range cursor sweep
 *   media metadata             store.js's envelope round-trip via localStorage
 *   seal / open                the client half of the phase C storage path
 *
 * WHAT IS NOT MEASURED, and must not be read into these numbers:
 *   - No network. The phase C upload/download to a bucket is not exercised;
 *     only the client-side crypto that precedes it. See the S3 integration
 *     test for the wire half.
 *   - No real device. This is a headless x86_64 container, not a phone. Phone
 *     storage is slower and thermally throttled; treat these as a FLOOR.
 *   - No comparison. This establishes a baseline at one commit. Nothing here
 *     claims an improvement or the absence of a regression, because there is
 *     nothing yet to compare against.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import os from 'node:os'

const ROOT = new URL('../../', import.meta.url).pathname
const CHROME = process.env.SPOTME_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' }

/** Serve the web tree so the page can `import` the real modules by URL. */
function serve () {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
        if (rel === '/' || rel === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          return res.end('<!doctype html><meta charset="utf-8"><title>bench</title>')
        }
        const body = await readFile(join(ROOT, rel))
        res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404).end('not found')
      }
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/* ------------------------------------------------------------- statistics --- */

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

function summarise (name, samples, meta = {}) {
  const s = [...samples].sort((a, b) => a - b)
  return {
    name,
    ...meta,
    n: s.length,
    min_ms: +s[0].toFixed(3),
    median_ms: +pct(s, 50).toFixed(3),
    p95_ms: +pct(s, 95).toFixed(3),
    p99_ms: +pct(s, 99).toFixed(3),
    max_ms: +s[s.length - 1].toFixed(3),
    raw_ms: s.map((x) => +x.toFixed(3))
  }
}

/* ------------------------------------------------------------------- run --- */

const SIZES = [
  { label: '1 KB', bytes: 1024, iterations: 100 },
  { label: '64 KB', bytes: 64 * 1024, iterations: 100 },
  { label: '1 MB', bytes: 1024 * 1024, iterations: 50 },
  { label: '8 MB', bytes: 8 * 1024 * 1024, iterations: 20 }
]

async function main () {
  const { server, port } = await serve()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })

  const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim()
  const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim().length > 0

  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  const chromeVersion = await page.evaluate(() => navigator.userAgent)

  const results = []

  /* --- cold open: the FIRST transaction on a fresh page pays for opening the
     database. Measured separately because it is the number a user feels when a
     conversation is opened, and averaging it into `put` would hide it. */
  const cold = []
  for (let i = 0; i < 15; i++) {
    const p = await browser.newPage()
    await p.goto(`http://127.0.0.1:${port}/`)
    const ms = await p.evaluate(async (origin) => {
      const blobs = await import(`${origin}/src/lib/blobstore.js`)
      const bytes = new Uint8Array(1024)
      const t0 = performance.now()
      await blobs.put(blobs.mediaKey('cold', `m${Math.random()}`), bytes, 'application/octet-stream')
      return performance.now() - t0
    }, `http://127.0.0.1:${port}`)
    cold.push(ms)
    await p.close()
  }
  results.push(summarise('idb.put cold open (1 KB)', cold, { payload: '1 KB', note: 'fresh page each iteration — includes indexedDB.open' }))

  /* --- warm put / get / del across sizes --- */
  for (const size of SIZES) {
    const r = await page.evaluate(async ({ origin, bytes, iterations }) => {
      const blobs = await import(`${origin}/src/lib/blobstore.js`)
      const payload = new Uint8Array(bytes)
      crypto.getRandomValues(payload.subarray(0, Math.min(bytes, 65536)))
      const put = [], get = [], del = []
      // Warm the connection so these measure the operation, not the open.
      await blobs.put(blobs.mediaKey('warm', 'seed'), new Uint8Array(8), 'application/octet-stream')
      for (let i = 0; i < iterations; i++) {
        const key = blobs.mediaKey('warm', `m${i}`)
        let t = performance.now()
        await blobs.put(key, payload, 'image/jpeg')
        put.push(performance.now() - t)
        t = performance.now()
        const got = await blobs.get(key)
        // MATERIALISE. IndexedDB hands back a Blob lazily, so timing `get`
        // alone reported 8 MB in 0.7 ms — the transaction, not the bytes. The
        // app always reads the content (store.js blobToDataURL), so the honest
        // measurement includes doing so.
        const materialised = got && typeof got.arrayBuffer === 'function'
          ? await got.arrayBuffer()
          : got?.bytes
        get.push(performance.now() - t)
        if (!materialised || materialised.byteLength !== bytes) {
          throw new Error(`read back ${materialised?.byteLength} of ${bytes} — benchmark is measuring a no-op`)
        }
        t = performance.now()
        await blobs.del(key)
        del.push(performance.now() - t)
      }
      return { put, get, del }
    }, { origin: `http://127.0.0.1:${port}`, bytes: size.bytes, iterations: size.iterations })

    results.push(summarise(`idb.put warm`, r.put, { payload: size.label }))
    results.push(summarise(`idb.get warm`, r.get, { payload: size.label }))
    results.push(summarise(`idb.del warm`, r.del, { payload: size.label }))
  }

  /* --- delRoom: the prefix-range cursor sweep, at two room sizes --- */
  for (const count of [50, 500]) {
    const samples = await page.evaluate(async ({ origin, count }) => {
      const blobs = await import(`${origin}/src/lib/blobstore.js`)
      const payload = new Uint8Array(16 * 1024)
      const out = []
      for (let round = 0; round < 5; round++) {
        const room = `sweep${round}_${count}`
        for (let i = 0; i < count; i++) {
          await blobs.put(blobs.mediaKey(room, `m${i}`), payload, 'image/jpeg')
        }
        const t = performance.now()
        await blobs.delRoom(room)
        out.push(performance.now() - t)
      }
      return out
    }, { origin: `http://127.0.0.1:${port}`, count })
    results.push(summarise('idb.delRoom', samples, { payload: `${count} objects x 16 KB` }))
  }

  /* --- media metadata: store.js's envelope round-trip (localStorage) --- */
  const metaSamples = await page.evaluate(async ({ origin }) => {
    const { createStore } = await import(`${origin}/src/store.js`)
    const out = []
    for (let round = 0; round < 20; round++) {
      const store = createStore(`bench-room-${round}`)
      const t = performance.now()
      for (let i = 0; i < 100; i++) {
        store.add({ id: `m${i}`, from: 'peer', ts: Date.now() + i, kind: 'image', mime: 'image/jpeg', text: '', data: null, mediaRef: true })
      }
      store.flush()
      const back = store.list()
      out.push(performance.now() - t)
      if (back.length !== 100) throw new Error(`expected 100 messages, got ${back.length}`)
    }
    return out
  }, { origin: `http://127.0.0.1:${port}` })
  results.push(summarise('store.add + flush + list', metaSamples, { payload: '100 media envelopes' }))

  /* --- phase C client half: AES-GCM seal/open at slice size --- */
  const cryptoSamples = await page.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const slice = new Uint8Array(128 * 1024)          // rooms.js SLICE_BYTES
    crypto.getRandomValues(slice.subarray(0, 65536))
    const seal = [], open = []
    for (let i = 0; i < 50; i++) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      let t = performance.now()
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, slice)
      seal.push(performance.now() - t)
      t = performance.now()
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
      open.push(performance.now() - t)
    }
    return { seal, open }
  })
  results.push(summarise('AES-GCM seal (client half of storage path)', cryptoSamples.seal, { payload: '128 KB slice' }))
  results.push(summarise('AES-GCM open (client half of storage path)', cryptoSamples.open, { payload: '128 KB slice' }))

  await browser.close()
  server.close()

  const report = {
    baseline_commit: commit,
    working_tree_dirty: dirty,
    generated_by: 'test/bench/idb-bench.mjs',
    environment: {
      chrome: chromeVersion,
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      cpu_model: os.cpus()[0]?.model,
      total_mem_gb: +(os.totalmem() / 1024 ** 3).toFixed(1),
      headless: true,
      real_device: false
    },
    not_measured: [
      'network transfer to or from an object store',
      'any physical device',
      'any comparison — this is a baseline, not a regression check'
    ],
    results
  }

  const jsonIdx = process.argv.indexOf('--json')
  if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(report, null, 2) + '\n')
  }

  console.log(`\nbaseline ${commit.slice(0, 7)}${dirty ? ' (DIRTY TREE — not a citable baseline)' : ''}`)
  console.log(`${report.environment.cpu_model} x${report.environment.cpus} · ${report.environment.total_mem_gb} GB · headless Chromium\n`)
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('operation', 44), pad('payload', 22), pad('n', 5), pad('median', 10), pad('p95', 10), 'p99')
  console.log('-'.repeat(110))
  for (const r of results) {
    console.log(pad(r.name, 44), pad(r.payload || '', 22), pad(r.n, 5), pad(r.median_ms + ' ms', 10), pad(r.p95_ms + ' ms', 10), r.p99_ms + ' ms')
  }
  console.log()
}

main().catch((e) => { console.error(e); process.exit(1) })
