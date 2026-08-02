/**
 * Spot Me camera — performance instrumentation. A snapshot object, NEVER a
 * wire: this module has no transport, no endpoint, no persistence — the
 * zero-egress guarantee applies to telemetry first, because "just metrics"
 * is how camera modules usually start leaking.
 *
 * What it holds: named duration series (bounded rings, so an hour of
 * preview cannot grow memory) with count/min/max/mean and p50/p90/p99
 * computed AT SNAPSHOT TIME from the retained window, plus plain
 * counters. Everything flows in through `record` calls the engine makes
 * around the moments that matter: session open → first frame, capture
 * latency, per-stage pipeline cost, dropped frames.
 */

const RING_SIZE = 512

/** Nearest-rank percentile on a sorted copy — small n, exactness over
 *  interpolation cleverness. Exported for the bench harness. */
export function percentile (samples, p) {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

export function createMetrics (clock = null) {
  const series = new Map()                 // name → {ring: Float64Array, next, filled, count, sum, min, max, lastTags}
  const counters = new Map()

  return {
    record (name, ms, tags = null) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return
      let s = series.get(name)
      if (!s) {
        s = { ring: new Float64Array(RING_SIZE), next: 0, filled: 0, count: 0, sum: 0, min: Infinity, max: -Infinity, lastTags: null }
        series.set(name, s)
      }
      s.ring[s.next] = ms
      s.next = (s.next + 1) % RING_SIZE
      s.filled = Math.min(RING_SIZE, s.filled + 1)
      s.count++
      s.sum += ms
      if (ms < s.min) s.min = ms
      if (ms > s.max) s.max = ms
      if (tags) s.lastTags = tags
    },

    count (name, delta = 1) {
      counters.set(name, (counters.get(name) || 0) + delta)
    },

    snapshot () {
      const out = { at: clock ? clock.now() : null, series: {}, counters: Object.fromEntries(counters) }
      for (const [name, s] of series) {
        const window = Array.from(s.ring.subarray(0, s.filled))
        out.series[name] = {
          count: s.count,
          mean: s.count ? s.sum / s.count : null,
          min: s.count ? s.min : null,
          max: s.count ? s.max : null,
          p50: percentile(window, 50),
          p90: percentile(window, 90),
          p99: percentile(window, 99),
          window: s.filled,
          lastTags: s.lastTags,
        }
      }
      return out
    },

    reset () { series.clear(); counters.clear() },
  }
}
