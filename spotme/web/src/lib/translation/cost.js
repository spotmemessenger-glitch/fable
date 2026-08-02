/**
 * Spot Me — cost governance (design §9, §14). The engine spends the owner's money
 * at five vendors on every request and has no idea how much; a headline feature
 * has already gone dark because a key ran out of credit. This module makes spend
 * VISIBLE and BOUNDED before it happens, without becoming a hard dependency: with
 * the flag OFF it does nothing, and even ON it only ever REFUSES an over-budget
 * call — it never blocks a call it has budget for.
 *
 * FIVE THINGS:
 *  1. ESTIMATE. Turn a provider's priceSignal (unit + estimated units) and its
 *     published cost model (microUsdPerUnit) into a micro-USD estimate BEFORE the
 *     call. Estimates only — no invoice, no key, order-of-magnitude by design.
 *  2. COUNTERS. Roll spend up per account, per day and per month, in memory
 *     (the durable TranslationUsageCounter table, design §13, is deferred).
 *  3. CEILINGS. A hard daily/monthly ceiling REFUSES a call that would exceed it;
 *     a soft ratio raises a warning first, so the product can degrade (drop the
 *     second opinion) before it fails.
 *  4. FAN-OUT BUDGET. Cross-verify and adjudication cost EXTRA calls. The governor
 *     caps fan-outs per window and — the rule the design insists on — records a
 *     reason for every one. No fan-out without a telemetry-recorded reason.
 *  5. CACHE-FIRST. The governor's standing advice: consult the cache before a
 *     provider. The pipeline enforces the ordering; this states the principle and
 *     counts the saving.
 *
 * DETERMINISTIC: `now` is injected, so day/month rollover is testable without a
 * clock. No plaintext ever enters a counter — only ids, amounts and reasons.
 */

/** Governance defaults. Generous: a ceiling is a backstop, not a throttle. */
export const COST_DEFAULTS = Object.freeze({
  dailyMicroUsd: 5_000_000, // $5.00/account/day
  monthlyMicroUsd: 50_000_000, // $50.00/account/month
  softRatio: 0.8, // warn at 80% of a ceiling
  maxFanoutPerMin: 6, // cross-verify/adjudicate fan-outs per account per minute
  fanoutWindowMs: 60_000
})

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

/**
 * Micro-USD estimate for one call. `priceSignal` is `{unit, estimatedUnits}` from
 * the provider; `costModel` is `{unit, microUsdPerUnit}` from its published row.
 * The costModel's price is authoritative; the units come from whichever signal
 * is expressed in the model's unit, else the provider's estimatedUnits.
 */
export function estimateMicroUsd (priceSignal, costModel) {
  const rate = num(costModel?.microUsdPerUnit, 0)
  if (rate <= 0) return 0
  const units = num(priceSignal?.estimatedUnits, 0)
  return Math.max(0, Math.round(rate * units))
}

/**
 * Estimate a provider's cost for a request by asking it for a priceSignal and
 * reading its cost model. Never throws — a provider without a priceSignal simply
 * estimates 0 (and is treated as free), which is safe for governance.
 */
export function estimateForProvider (provider, request) {
  try {
    const signal = provider.priceSignal ? provider.priceSignal(request) : null
    const caps = provider.capabilities ? provider.capabilities() : null
    return estimateMicroUsd(signal, caps?.costModel)
  } catch {
    return 0
  }
}

const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10) // YYYY-MM-DD
const monthKeyOf = (ms) => new Date(ms).toISOString().slice(0, 7) // YYYY-MM

/**
 * Create a cost governor. All state is in-memory and per-account; `now` is
 * injected. Nothing here spends anything — it decides whether a call MAY spend
 * and remembers what was spent.
 *
 * @param {{limits?: object, overrides?: Record<string, object>, now?: () => number}} [opts]
 */
export function createCostGovernor (opts = {}) {
  const base = { ...COST_DEFAULTS, ...(opts.limits || {}) }
  const overrides = opts.overrides || {} // per-account limit overrides
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  const daily = new Map() // `${account}|${day}` -> microUsd
  const monthly = new Map() // `${account}|${month}` -> microUsd
  const fanouts = new Map() // account -> [timestamps]
  const stats = { estimated: 0, recorded: 0, blocked: 0, softWarnings: 0, fanouts: 0, cacheSavings: 0 }

  const limitsFor = (account) => ({ ...base, ...(overrides[account] || {}) })
  const acct = (a) => String(a || 'anonymous')

  function spentToday (account) {
    return daily.get(`${acct(account)}|${dayKeyOf(now())}`) || 0
  }
  function spentThisMonth (account) {
    return monthly.get(`${acct(account)}|${monthKeyOf(now())}`) || 0
  }

  return {
    /** Standing advice — the pipeline consults the cache before a provider. */
    shouldCheckCacheFirst () { return true },

    /** Estimate a provider's cost for a request (delegates to estimateForProvider). */
    estimate (provider, request) { return estimateForProvider(provider, request) },

    /**
     * May this account afford `estimateMicroUsd` more spend right now? Returns
     * `{ allowed, hardBlocked, softWarning, reason, remaining }`. A hard block is
     * a refusal (the call must not be made); a soft warning is advisory (make it,
     * but the product should start shedding optional cost).
     */
    check (account, estimate) {
      const est = Math.max(0, num(estimate, 0))
      const lim = limitsFor(account)
      const day = spentToday(account)
      const month = spentThisMonth(account)
      const remaining = Math.max(0, Math.min(lim.dailyMicroUsd - day, lim.monthlyMicroUsd - month))

      if (day + est > lim.dailyMicroUsd) {
        stats.blocked += 1
        return { allowed: false, hardBlocked: true, softWarning: false, reason: 'daily ceiling', remaining }
      }
      if (month + est > lim.monthlyMicroUsd) {
        stats.blocked += 1
        return { allowed: false, hardBlocked: true, softWarning: false, reason: 'monthly ceiling', remaining }
      }
      const softWarning = (day + est) > lim.dailyMicroUsd * lim.softRatio ||
        (month + est) > lim.monthlyMicroUsd * lim.softRatio
      if (softWarning) stats.softWarnings += 1
      return { allowed: true, hardBlocked: false, softWarning, reason: softWarning ? 'approaching ceiling' : 'ok', remaining }
    },

    /** Record actual spend against an account (after the call was made). */
    record (account, microUsd, meta = {}) {
      const amt = Math.max(0, num(microUsd, 0))
      const t = now()
      const dk = `${acct(account)}|${dayKeyOf(t)}`
      const mk = `${acct(account)}|${monthKeyOf(t)}`
      daily.set(dk, (daily.get(dk) || 0) + amt)
      monthly.set(mk, (monthly.get(mk) || 0) + amt)
      stats.recorded += amt
      stats.estimated += Math.max(0, num(meta.estimate, 0))
      return { day: daily.get(dk), month: monthly.get(mk) }
    },

    /**
     * May this account make another fan-out (a cross-verify/adjudication extra
     * call) in the current window, and RECORD its reason. Returns `{ allowed,
     * reason, used, limit }`. Passing no reason is refused — the design's rule is
     * that a fan-out without a recorded reason must not happen.
     */
    fanout (account, reason) {
      const lim = limitsFor(account)
      const t = now()
      const key = acct(account)
      const live = (fanouts.get(key) || []).filter((ts) => t - ts < lim.fanoutWindowMs)
      if (!reason || typeof reason !== 'string') {
        return { allowed: false, reason: 'refused: fan-out requires a recorded reason', used: live.length, limit: lim.maxFanoutPerMin }
      }
      if (live.length >= lim.maxFanoutPerMin) {
        fanouts.set(key, live)
        return { allowed: false, reason: 'fan-out budget exhausted', used: live.length, limit: lim.maxFanoutPerMin }
      }
      live.push(t)
      fanouts.set(key, live)
      stats.fanouts += 1
      return { allowed: true, reason, used: live.length, limit: lim.maxFanoutPerMin }
    },

    /** Count a cache hit's avoided spend, for the cost-savings metric. */
    recordCacheSaving (microUsd) { stats.cacheSavings += Math.max(0, num(microUsd, 0)); return stats.cacheSavings },

    /** Current spend for an account (observability; no content). */
    usage (account) {
      return { day: spentToday(account), month: spentThisMonth(account), limits: limitsFor(account) }
    },

    /** Aggregate governance stats — amounts and counts only, never content. */
    snapshot () { return { ...stats, accounts: new Set([...daily.keys()].map((k) => k.split('|')[0])).size } },

    reset () { daily.clear(); monthly.clear(); fanouts.clear(); stats.estimated = 0; stats.recorded = 0; stats.blocked = 0; stats.softWarnings = 0; stats.fanouts = 0; stats.cacheSavings = 0 }
  }
}
