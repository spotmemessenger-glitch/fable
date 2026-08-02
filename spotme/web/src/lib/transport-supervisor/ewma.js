/**
 * Spot Me — EWMA estimation + TREND PREDICTION for transport quality. ADR-012b.
 *
 * The selector must not act on one bad sample — a single dropped ping is not a
 * dead link — and must not wait for an average that takes minutes to move.
 * Exponentially-weighted moving averages are the standard middle ground: cheap
 * (O(1) memory per axis), smooth (a spike is damped by 1−α), and responsive
 * (recent samples dominate). TCP's SRTT/RTTVAR is the ancestor; the same shape
 * is used here for latency, loss, jitter, and bandwidth.
 *
 * PREDICTION is deliberately modest: a least-squares slope over a small sliding
 * window of the SMOOTHED values, projected forward one horizon. It answers one
 * question — "is this link degrading fast enough that it will cross the
 * unusable line before the next few ticks?" — so the supervisor can begin a
 * make-before-break switch BEFORE the link dies, instead of after. It is a
 * trend detector, not a forecaster; anything cleverer would be tuning noise.
 *
 * Everything here is pure state-in/state-out with injected timestamps. No
 * clocks, no I/O.
 */

/**
 * One EWMA axis. `alpha` is the weight of the newest sample (0..1); higher =
 * jumpier. `value` is null until the first sample — "unknown" must stay
 * distinguishable from "zero", because a selector treats them differently
 * (unknown gets a neutral prior; zero is a measurement).
 */
export function createEwma ({ alpha = 0.3 } = {}) {
  if (!(alpha > 0 && alpha <= 1)) throw new Error('ewma: alpha must be in (0,1]')
  let value = null
  let samples = 0
  return {
    push (x) {
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('ewma: sample must be a finite number')
      value = value == null ? x : alpha * x + (1 - alpha) * value
      samples++
      return value
    },
    get value () { return value },
    get samples () { return samples },
    reset () { value = null; samples = 0 }
  }
}

/**
 * Least-squares slope over the last `window` (t, v) points. Returns
 * { slope, intercept, n } with slope in value-units per millisecond, or
 * slope 0 when fewer than two points exist — "no trend" is the honest reading
 * of one point, and it keeps callers branch-free.
 */
export function createTrend ({ window = 12 } = {}) {
  if (!(window >= 2)) throw new Error('trend: window must be >= 2')
  const points = []   // { t, v }
  return {
    push (t, v) {
      points.push({ t, v })
      if (points.length > window) points.shift()
    },
    fit () {
      const n = points.length
      if (n < 2) return { slope: 0, intercept: points[0]?.v ?? 0, n }
      let st = 0; let sv = 0
      for (const p of points) { st += p.t; sv += p.v }
      const mt = st / n; const mv = sv / n
      let num = 0; let den = 0
      for (const p of points) {
        num += (p.t - mt) * (p.v - mv)
        den += (p.t - mt) * (p.t - mt)
      }
      const slope = den === 0 ? 0 : num / den
      return { slope, intercept: mv - slope * mt, n }
    },
    /** Value the trend projects at time `t` (extrapolation). */
    projectAt (t) {
      const { slope, intercept, n } = this.fit()
      if (n < 2) return intercept
      return intercept + slope * t
    },
    get size () { return points.length },
    reset () { points.length = 0 }
  }
}

/**
 * The per-transport quality estimator the monitor feeds and the supervisor
 * reads: EWMAs of latency / loss / jitter / bandwidth, plus latency+loss
 * trends for degradation anticipation.
 *
 * Jitter is estimated TCP-style as an EWMA of |sample − smoothed latency| —
 * cheap and exactly the signal a "this link is getting choppy" prediction
 * needs. Loss samples are 0/1 outcomes (delivered / failed), so its EWMA IS
 * the smoothed loss rate.
 */
export function createQualityEstimator ({ alpha = 0.3, trendWindow = 12 } = {}) {
  const latency = createEwma({ alpha })
  const loss = createEwma({ alpha })
  const jitter = createEwma({ alpha })
  const bandwidth = createEwma({ alpha })
  const latencyTrend = createTrend({ window: trendWindow })
  const lossTrend = createTrend({ window: trendWindow })
  let lastAt = null

  return {
    /** Record one latency measurement (ms) taken at time `at` (ms). */
    pushLatency (ms, at) {
      const prev = latency.value
      const smoothed = latency.push(ms)
      if (prev != null) jitter.push(Math.abs(ms - prev))
      latencyTrend.push(at, smoothed)
      lastAt = at
      return smoothed
    },
    /** Record one delivery outcome at time `at`: true = delivered. */
    pushOutcome (delivered, at) {
      const smoothed = loss.push(delivered ? 0 : 1)
      lossTrend.push(at, smoothed)
      lastAt = at
      return smoothed
    },
    /** Record a throughput observation (kbps). */
    pushBandwidth (kbps, at) { lastAt = at; return bandwidth.push(kbps) },

    /** The smoothed snapshot, in the QualitySample vocabulary. Null = unknown. */
    snapshot () {
      return Object.freeze({
        latencyMs: latency.value,
        lossPct: loss.value == null ? 0 : Math.max(0, Math.min(1, loss.value)),
        lossKnown: loss.value != null,
        jitterMs: jitter.value ?? 0,
        throughputKbps: bandwidth.value,
        sampledAt: lastAt
      })
    },

    /**
     * Degradation anticipation: project latency and loss forward `horizonMs`
     * from `now` and report whether either crosses its threshold. The result
     * is machine-readable so the supervisor's event log can say WHY a
     * proactive switch happened, in the same spirit as the translation
     * router's reasons.
     */
    predict ({ now, horizonMs = 10_000, latencyCeilingMs = 1500, lossCeiling = 0.5 } = {}) {
      const latFit = latencyTrend.fit()
      const lossFit = lossTrend.fit()
      const latProjected = latFit.n >= 2 ? latencyTrend.projectAt(now + horizonMs) : (latency.value ?? 0)
      const lossProjected = lossFit.n >= 2 ? lossTrend.projectAt(now + horizonMs) : (loss.value ?? 0)
      const latencyDegrading = latFit.n >= 3 && latFit.slope > 0 && latProjected >= latencyCeilingMs
      const lossDegrading = lossFit.n >= 3 && lossFit.slope > 0 && lossProjected >= lossCeiling
      return Object.freeze({
        degrading: latencyDegrading || lossDegrading,
        reasons: [
          ...(latencyDegrading ? [`latency-trend:${latFit.slope.toExponential(2)}/ms->${Math.round(latProjected)}ms@+${horizonMs}ms`] : []),
          ...(lossDegrading ? [`loss-trend:${lossFit.slope.toExponential(2)}/ms->${lossProjected.toFixed(2)}@+${horizonMs}ms`] : [])
        ],
        latency: { slope: latFit.slope, projected: latProjected, samples: latFit.n },
        loss: { slope: lossFit.slope, projected: Math.max(0, Math.min(1, lossProjected)), samples: lossFit.n }
      })
    },

    reset () { latency.reset(); loss.reset(); jitter.reset(); bandwidth.reset(); latencyTrend.reset(); lossTrend.reset(); lastAt = null }
  }
}
