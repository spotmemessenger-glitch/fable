/**
 * Spot Me — live-voice latency & performance instrumentation. WS3 design §16,
 * roadmap §8 ("median AND tail"), ADR-011b.
 *
 * The latency-budget type (latency-budget.js) accounts ONE utterance; this
 * module aggregates MANY — per stage and end-to-end — into the p50/p95/p99
 * shape the SLO table (§13.2) is written in. It consumes exactly the
 * `budget.report()` value the orchestrator already attaches to every
 * utterance result, so instrumentation is a fold over data that already
 * exists, not a second measuring stick.
 *
 * BOUNDED BY CONSTRUCTION. Samples ride a fixed-size ring per series: a
 * ten-hour call must not grow memory linearly (the long-session test asserts
 * this). The ring holds the most recent `capacity` samples; percentiles are
 * over that window — which is also the operationally honest choice, because
 * "p95 over the last N utterances" answers "how is the call NOW", not "how
 * was the call an hour ago".
 *
 * NOTHING CONTENT-SHAPED ENTERS. Series names are stage names; values are
 * milliseconds and counts. No text, no audio, no ids beyond the session label
 * the caller chooses — the §16 "never logged" rule enforced by shape.
 */

/** Fixed ring capacity per series (samples retained for percentiles). */
export const DEFAULT_RING_CAPACITY = 256

function makeRing (capacity) {
  const buf = new Array(capacity)
  let n = 0
  let head = 0
  return {
    push (v) { buf[head] = v; head = (head + 1) % capacity; if (n < capacity) n += 1 },
    values () { const out = []; for (let i = 0; i < n; i++) out.push(buf[(head - n + i + capacity) % capacity]); return out },
    get count () { return n }
  }
}

/** Percentile over a sorted copy (nearest-rank; deterministic). */
export function percentile (samples, p) {
  if (!samples.length) return null
  const s = [...samples].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

/**
 * Create an aggregator. `record(budgetReport)` folds one utterance in;
 * `snapshot()` reads p50/p95/p99 (+min/max/mean/count) per stage and for the
 * end-to-end total.
 */
export function createLatencyAggregator ({ capacity = DEFAULT_RING_CAPACITY } = {}) {
  const series = new Map()  // name -> ring
  let utterances = 0
  let overBudget = 0

  function ring (name) {
    let r = series.get(name)
    if (!r) { r = makeRing(capacity); series.set(name, r) }
    return r
  }

  return {
    /** Fold one utterance's `budget.report()` into the aggregate. */
    record (report) {
      if (!report || typeof report !== 'object') return
      utterances += 1
      if (report.withinBudget === false) overBudget += 1
      if (typeof report.measuredMs === 'number') ring('total').push(report.measuredMs)
      for (const s of report.perStage || []) {
        if (s && typeof s.ms === 'number') ring(s.stage).push(s.ms)
      }
    },

    /** Record an arbitrary named duration (session setup, fan-out cost…). */
    recordDuration (name, ms) {
      if (typeof name === 'string' && typeof ms === 'number' && Number.isFinite(ms)) ring(name).push(ms)
    },

    /** The aggregate view: per-series stats, in insertion order. */
    snapshot () {
      const stages = {}
      for (const [name, r] of series) {
        const v = r.values()
        if (!v.length) continue
        const sum = v.reduce((a, b) => a + b, 0)
        stages[name] = {
          count: v.length,
          min: Math.min(...v),
          max: Math.max(...v),
          mean: sum / v.length,
          p50: percentile(v, 50),
          p95: percentile(v, 95),
          p99: percentile(v, 99)
        }
      }
      return { utterances, overBudget, overBudgetRate: utterances ? overBudget / utterances : 0, stages }
    },

    /** Bounded-memory proof surface: how many samples are retained, total. */
    retainedSamples () {
      let total = 0
      for (const r of series.values()) total += r.count
      return total
    },

    reset () { series.clear(); utterances = 0; overBudget = 0 }
  }
}
