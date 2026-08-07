/**
 * Signing-key store benchmarks — Roadmap V2 §8 requires environment, raw
 * results, median AND tail, so all four are printed. Run on Node against the
 * same in-memory fake the suite uses, so the numbers isolate THIS module's
 * cost (crypto + store logic) from any real browser's IndexedDB, which must be
 * measured separately on hardware and will be slower.
 *
 *   node test/bench/signing-store.bench.mjs
 */
import { cpus, totalmem } from 'node:os'

function clone (v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(clone)
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return v
  const out = {}
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = clone(val)
  return out
}
function makeIDB (backing = new Map()) {
  return {
    open (name, version) {
      const req = {}
      queueMicrotask(() => {
        if (!backing.has(name)) backing.set(name, { version: 0, stores: new Map() })
        const entry = backing.get(name)
        req.result = {
          objectStoreNames: { contains: (s) => entry.stores.has(s) },
          createObjectStore (s) { entry.stores.set(s, { data: new Map() }); return {} },
          transaction (storeName) {
            const rec = entry.stores.get(storeName)
            const t = {}
            let pending = 0
            const request = (work) => {
              const r = {}
              pending++
              queueMicrotask(() => {
                r.result = work(); r.onsuccess?.(); pending--
                queueMicrotask(() => { if (pending === 0) t.oncomplete?.() })
              })
              return r
            }
            t.objectStore = () => ({
              get: (k) => request(() => { const v = rec.data.get(k); return v === undefined ? undefined : clone(v) }),
              put: (v, k) => request(() => { rec.data.set(k, clone(v)); return k }),
            })
            queueMicrotask(() => { if (pending === 0) t.oncomplete?.() })
            return t
          },
        }
        if (version > entry.version) { entry.version = version; req.onupgradeneeded?.() }
        req.onsuccess?.()
      })
      return req
    },
  }
}

const { loadSigningIdentity, forgetSigningIdentity, rotateSigningIdentity } =
  await import('../../src/lib/crypto/signing-key-store.js')

const stats = (samples) => {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return { n: s.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] }
}
const fmt = (x) => `${x.toFixed(2)}ms`
const row = (name, st) =>
  console.log(`${name.padEnd(34)} n=${String(st.n).padStart(4)}  median=${fmt(st.median)}  p95=${fmt(st.p95)}  p99=${fmt(st.p99)}  max=${fmt(st.max)}`)

console.log('signing-key store benchmark')
console.log(`env: node ${process.version} · ${cpus()[0]?.model || 'cpu?'} ×${cpus().length} · ${(totalmem() / 2 ** 30).toFixed(1)}GiB · in-memory IDB fake`)
console.log('')

// COLD: fresh device — generate + write-verify. The expensive path.
{
  const samples = []
  for (let i = 0; i < 60; i++) {
    globalThis.indexedDB = makeIDB(new Map())
    forgetSigningIdentity()
    const t0 = performance.now()
    await loadSigningIdentity()
    samples.push(performance.now() - t0)
  }
  row('cold load (generate + verify)', stats(samples))
}

// WARM MISSED CACHE: restart — read an existing record back.
{
  const backing = new Map()
  globalThis.indexedDB = makeIDB(backing)
  forgetSigningIdentity()
  await loadSigningIdentity()
  const samples = []
  for (let i = 0; i < 200; i++) {
    globalThis.indexedDB = makeIDB(backing)
    forgetSigningIdentity()
    const t0 = performance.now()
    await loadSigningIdentity()
    samples.push(performance.now() - t0)
  }
  row('restart load (read-back)', stats(samples))
}

// HOT: cached — the price every later caller pays.
{
  const samples = []
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now()
    await loadSigningIdentity()
    samples.push(performance.now() - t0)
  }
  row('cached load', stats(samples))
}

// ROTATE: generate + write-verify over an existing record.
{
  const samples = []
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now()
    const out = await rotateSigningIdentity()
    if (!out.ok) throw new Error('rotation failed mid-benchmark: ' + out.error?.code)
    samples.push(performance.now() - t0)
  }
  row('rotate (generate + verify)', stats(samples))
}

console.log('\nnote: real-browser IndexedDB adds disk + structured-clone cost on top of')
console.log('these numbers; the hardware pass in the Phase 6 evidence measures that.')
