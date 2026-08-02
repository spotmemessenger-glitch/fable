/**
 * Spot Me — transport SELECTION: weighted scoring + hysteresis. ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired). Pure logic — no I/O, no clock of its
 * own; `now` is passed in so every decision is reproducible in a test.
 *
 * TWO PROBLEMS, KEPT SEPARATE.
 *
 * 1. SCORING — "which transport is best RIGHT NOW?" A weighted sum over
 *    normalised axes (latency, reliability, bandwidth, battery, cost, reach),
 *    gated by HARD CONSTRAINTS that disqualify a transport outright: you cannot
 *    pick an internet transport with no internet, an online-only transport when
 *    the need is explicitly offline, or a link whose frame is too small for the
 *    payload. A disqualified transport scores `null`, not a low number, so it can
 *    never win by weight.
 *
 * 2. HYSTERESIS — "should we ACTUALLY switch?" The best score flickering above
 *    and below a rival's by a hair must not thrash the connection. Three guards:
 *    a MARGIN the challenger must clear, a DWELL time the incumbent is protected
 *    for after a switch, and a STICKINESS bonus added to the incumbent's score.
 *    The one exception that overrides all three: if the incumbent is DISQUALIFIED
 *    (its link died / lost internet), we switch immediately — availability beats
 *    flap-avoidance.
 */

/** Clamp helper. */
const clamp01 = (x) => Math.max(0, Math.min(1, x))

/** Default axis weights. Normalised on use, so callers may pass any positives. */
export const DEFAULT_WEIGHTS = Object.freeze({
  latency: 0.30, reliability: 0.30, bandwidth: 0.15, battery: 0.10, cost: 0.10, reachability: 0.05
})

/** Default hysteresis. margin/stickiness are absolute on the 0..1 score scale. */
export const DEFAULT_HYSTERESIS = Object.freeze({ margin: 0.05, dwellMs: 8000, stickiness: 0.03 })

function normaliseWeights (w) {
  const merged = { ...DEFAULT_WEIGHTS, ...(w || {}) }
  const total = Object.values(merged).reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1
  const out = {}
  for (const k of Object.keys(merged)) out[k] = Math.max(0, merged[k]) / total
  return out
}

/**
 * Score one candidate against the current context.
 *
 * candidate = { name, capabilities, quality?, cost? }
 *   capabilities — a row from capabilities.js (nominal facts)
 *   quality      — a live QualitySample, or omitted when unknown
 *   cost         — a live CostSignal, or omitted when unknown
 *
 * context = { noInternet?, needOffline?, payloadBytes?, batterySaver? }
 *
 * Returns { name, score, disqualified, reason, parts }. `score` is null iff
 * disqualified.
 */
export function scoreCandidate (candidate, context = {}, weights = DEFAULT_WEIGHTS) {
  const { name, capabilities: caps, quality = null, cost = null } = candidate || {}
  if (!name || !caps) throw new Error('scoreCandidate: name and capabilities are required')
  const w = normaliseWeights(weights)

  // ---- hard constraints: disqualify rather than penalise ----
  const dq = (reason) => ({ name, score: null, disqualified: true, reason, parts: null })
  if (context.noInternet && caps.needsInternet) return dq('needs internet, none available')
  if (context.needOffline && !caps.offline) return dq('offline required, transport is online-only')
  if (context.payloadBytes != null && context.payloadBytes > caps.maxPayloadBytes) {
    return dq(`payload ${context.payloadBytes}B exceeds maxPayloadBytes ${caps.maxPayloadBytes}B`)
  }
  // A known-dead link cannot be selected; an UNKNOWN one (no sample) still can.
  if (quality && quality.connected === false) return dq('transport reports not connected')

  // ---- soft axes, each normalised to 0..1 (higher is better) ----
  const latMs = quality?.latencyMs != null ? quality.latencyMs : caps.latencyMs
  const latency = clamp01(1 - latMs / 500)
  const reliability = quality ? clamp01(1 - quality.lossPct) : 0.8   // neutral prior when unknown
  const bwKbps = quality?.throughputKbps != null ? quality.throughputKbps : caps.bandwidthKbps
  const bandwidth = clamp01(bwKbps / 20000)
  const batteryDrain = caps.batteryCostPerMin + (cost ? cost.battery * 0.5 : 0) + (context.batterySaver ? 0.2 : 0)
  const battery = clamp01(1 - batteryDrain)
  const money = cost ? cost.monetary + (cost.metered ? 0.3 : 0) : 0
  const costScore = clamp01(1 - money)
  // Reachability rewards matching the need: offline links win when offline is
  // asked for or the internet is gone; otherwise every qualifying link is equal.
  const reachability = (context.noInternet || context.needOffline) ? (caps.offline ? 1 : 0) : 1

  const parts = { latency, reliability, bandwidth, battery, cost: costScore, reachability }
  const score = clamp01(
    w.latency * latency + w.reliability * reliability + w.bandwidth * bandwidth +
    w.battery * battery + w.cost * costScore + w.reachability * reachability
  )
  return { name, score, disqualified: false, reason: null, parts }
}

/**
 * Score every candidate and return them sorted best-first. Disqualified
 * candidates (score null) sort to the end. Ties break by name for determinism.
 */
export function scoreAll (candidates, context = {}, weights = DEFAULT_WEIGHTS) {
  const scored = candidates.map((c) => scoreCandidate(c, context, weights))
  return scored.sort((a, b) => {
    if (a.score == null && b.score == null) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    if (a.score == null) return 1
    if (b.score == null) return -1
    if (b.score !== a.score) return b.score - a.score
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/**
 * A stateful selector that applies hysteresis over successive scorings.
 *
 * The selector holds only the current choice and when it was last changed; it
 * has no timers and reads no clock — callers pass `now` (ms). That is what makes
 * "does it flap?" a unit test rather than a soak test.
 */
export function createSelector (opts = {}) {
  const cfg = { ...DEFAULT_HYSTERESIS, ...opts }
  let current = null        // selected transport name
  let lastSwitchAt = 0      // ms of the last actual switch

  function decide (scored, now) {
    const viable = scored.filter((s) => s.score != null)
    const outcome = (selected, switched, reason) => {
      if (switched) { current = selected; lastSwitchAt = now }
      else if (selected == null) current = null
      return { selected, switched, reason, scored }
    }

    if (viable.length === 0) {
      const switched = current != null
      current = null
      return { selected: null, switched, reason: 'no viable transport', scored }
    }

    const best = viable[0]   // scoreAll already sorted best-first
    if (current == null) return outcome(best.name, true, 'initial selection')

    const incumbent = viable.find((s) => s.name === current)
    if (!incumbent) {
      // The link we were on is gone or disqualified — switch NOW, ignore dwell.
      return outcome(best.name, true, 'incumbent no longer viable')
    }
    if (now - lastSwitchAt < cfg.dwellMs) {
      return outcome(current, false, 'within dwell window')
    }
    // Dwell elapsed: a challenger must clear the incumbent's sticky score by the
    // margin. If the incumbent is still the best, this trivially keeps it.
    const incumbentEffective = incumbent.score + cfg.stickiness
    if (best.name !== current && best.score >= incumbentEffective + cfg.margin) {
      return outcome(best.name, true, `challenger beat incumbent by margin (${best.score.toFixed(3)} ≥ ${(incumbentEffective + cfg.margin).toFixed(3)})`)
    }
    return outcome(current, false, 'challenger did not clear margin')
  }

  return {
    /** Score `candidates` for `context` and apply hysteresis at time `now`. */
    choose (candidates, context = {}, now = 0, weights = DEFAULT_WEIGHTS) {
      return decide(scoreAll(candidates, context, weights), now)
    },
    /** Apply hysteresis to an ALREADY-scored list (for tests / custom scoring). */
    chooseScored (scored, now = 0) { return decide(scored, now) },
    state () { return { current, lastSwitchAt, cfg: { ...cfg } } },
    reset () { current = null; lastSwitchAt = 0 }
  }
}
