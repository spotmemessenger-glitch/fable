# Priority 1 — IndexedDB and media-path baseline

**Baseline commit:** `acb630d` — which is `b0423b2` plus this harness and
nothing else. The added files live under `test/bench/` and are not imported by
any measured code path, so these figures describe `b0423b2`'s behaviour.

**Reproduce:**

```bash
cd spotme/web
npm install --no-save playwright
node test/bench/idb-bench.mjs --json out.json
```

Raw results, including every individual sample, are committed as
`12-PRIORITY-1-BASELINE.json`.

---

## Environment

| | |
|---|---|
| Browser | headless Chromium 141 (`/opt/pw-browsers/chromium-1194`) |
| CPU | Intel Xeon @ 2.80 GHz × 4 |
| Memory | 15.7 GB |
| Platform | Linux 6.18.5 x86_64, container |
| Node | v22.22.2 |
| Real device | **No** |

**Why a real browser rather than `fake-indexeddb`.** Node has no IndexedDB, and
the usual shim is a JavaScript reimplementation. Benchmarking it would produce
numbers that look like measurements while describing a shim's `Map` operations
instead of a browser's transaction, serialization and disk behaviour — which is
the whole thing under test. These drive the real `src/lib/blobstore.js` in real
Chromium, the same engine the Android Capacitor WebView runs.

## Results

| Operation | Payload | n | Median (ms) | p95 | p99 | Max |
|---|---|---|---|---|---|---|
| `idb.put cold open (1 KB)` | 1 KB | 15 | 6.1 | 8.1 | 8.1 | 8.1 |
| `idb.put warm` | 1 KB | 100 | 0.8 | 1.6 | 3.1 | 3.5 |
| `idb.get warm` | 1 KB | 100 | 0.9 | 1.3 | 2 | 3 |
| `idb.del warm` | 1 KB | 100 | 0.5 | 0.8 | 1.2 | 1.2 |
| `idb.put warm` | 64 KB | 100 | 1.1 | 1.4 | 1.5 | 1.6 |
| `idb.get warm` | 64 KB | 100 | 1 | 1.2 | 1.7 | 1.8 |
| `idb.del warm` | 64 KB | 100 | 0.6 | 0.8 | 0.9 | 0.9 |
| `idb.put warm` | 1 MB | 50 | 1.5 | 2.1 | 3.1 | 3.1 |
| `idb.get warm` | 1 MB | 50 | 3.1 | 4.6 | 4.8 | 4.8 |
| `idb.del warm` | 1 MB | 50 | 0.7 | 0.9 | 0.9 | 0.9 |
| `idb.put warm` | 8 MB | 20 | 4.9 | 6.9 | 9.7 | 9.7 |
| `idb.get warm` | 8 MB | 20 | **19** | 22.1 | 34.4 | 34.4 |
| `idb.del warm` | 8 MB | 20 | 1 | 3.9 | 4.4 | 4.4 |
| `idb.delRoom` | 50 × 16 KB | 5 | 16.5 | 20.2 | 20.2 | 20.2 |
| `idb.delRoom` | 500 × 16 KB | 5 | **166.7** | 169.4 | 169.4 | 169.4 |
| `store.add + flush + list` | 100 media envelopes | 20 | 0.3 | 1 | 1.1 | 1.1 |
| `AES-GCM seal` | 128 KB slice | 50 | 0.4 | 0.5 | 2.2 | 2.2 |
| `AES-GCM open` | 128 KB slice | 50 | 0.4 | 0.5 | 0.5 | 0.5 |

## How reliable these are — measured, not assumed

**A baseline nobody has characterised the noise of cannot detect a regression.**
Three repeat runs on an unchanged tree:

| Class | Run-to-run spread | Usable as a regression gate? |
|---|---|---|
| Operations ≥ 1 ms (1 MB, 8 MB write, `delRoom`, AES-GCM) | **6–16%** | **Yes**, for regressions above ~20% |
| Sub-millisecond (1 KB, 64 KB, `store.add`) | 14–50% | **No** — this is timer quantisation, not variance. 0.2 vs 0.3 ms reads as "50%" |
| `idb.get` at 8 MB | **63%** | **No.** Genuinely noisy; needs more samples or GC control |

**So: this baseline supports regression detection at roughly a 20% threshold,
for operations that take longer than a millisecond, and nothing finer.** Any
future claim of "no performance degradation" must be qualified by that.

### Two harness bugs found while establishing this

Recorded because both produced believable wrong numbers.

1. **8 MB reads reported at 0.7 ms.** Not a fast read — not a read at all.
   IndexedDB returns a `Blob` lazily, so timing `get()` alone measured the
   transaction and none of the bytes. The app always materialises the content
   (`store.js` `blobToDataURL`), so the harness now does too. The honest figure
   is **~27× higher**.
2. **AES-GCM varied 175% between runs.** Entirely JIT and subtle-crypto
   initialisation — 1.1 ms on early iterations, 0.4 ms in steady state. Both
   loops now discard warm-up iterations; the spread is now 0%.

## What stands out

- **`delRoom` is linear and it is the slow path**: 166 ms for 500 objects, from
  16.5 ms for 50. It runs on "clear chat", so a large conversation blocks for
  roughly a third of a second on a machine faster than any phone.
- **8 MB reads cost ~19 ms**, against ~5 ms to write. Reads materialise bytes;
  writes hand the browser a `Blob` and return. The lazy-read trap above is the
  same effect seen from the other side.
- **AES-GCM is not the bottleneck.** 0.4 ms per 128 KB slice — roughly 1/50th of
  an 8 MB IndexedDB read. Encryption is not what makes media slow.
- **Cold open costs ~6 ms**, paid once per page per database.

## What this does NOT measure

Stated so the table is not read as more than it is.

- **No network.** The phase C upload/download to a bucket is not exercised —
  only the client-side crypto preceding it. The S3 integration test covers the
  wire half, and does not exist yet.
- **No physical device.** A headless x86_64 container with 15.7 GB of RAM is not
  a phone. Phone storage is slower and thermally throttled. **Treat every number
  here as a floor.**
- **No comparison, and therefore no claim.** This establishes a baseline at one
  commit. Nothing here asserts an improvement or the absence of a regression,
  because there is nothing yet to compare against.
- **Not the Q3 measurements.** `004c` Q3 requires IndexedDB growth at each
  skipped-key bound, hostile skip patterns, and behaviour past 7 days offline.
  None of that is here; it needs a ratchet implementation to measure.
