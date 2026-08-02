/**
 * Spot Me — the live-voice latency budget. ADR-011, Roadmap V2 §6.5.
 *
 * The flagship promise is a <2.5 s MVP end-to-end (CLAUDE.md owner amendment;
 * §6.5 lists the component targets). A promise with no accounting is a wish, so
 * this file is the accounting TYPE: a total budget, a per-stage allocation that
 * sums to it, and an object that records how long each stage actually took and
 * answers "are we still inside the budget?" at every step.
 *
 * WHY PER-STAGE AND NOT JUST A TOTAL. A single end-to-end number tells you that
 * you blew the budget but not where, and the pipeline has one slow provider
 * away from failure at every stage. The stage allocation is also what lets the
 * orchestrator fail FAST and fall back to captions (§6.2.8) the moment a stage
 * blows its slice — instead of waiting out the whole 2.5 s to discover the
 * synthesized answer will arrive late anyway.
 *
 * THE NUMBERS ARE INITIAL ENGINEERING OBJECTIVES, not measurements (§6.5 says so
 * explicitly). They will move once real providers are benchmarked; the benchmark
 * plan (docs/priority-2/03-live-voice-benchmark-plan.md) is how. What this type
 * fixes is the SHAPE of the accounting, not the final constants.
 */

/** MVP end-to-end budget: first translated audio within this of speech end. */
export const TOTAL_BUDGET_MS = 2500

/**
 * Default per-stage allocation (ms). Sums to TOTAL_BUDGET_MS. Ordered along the
 * pipeline. `llm_correct` is optional; when the corrector is not wired its slice
 * is slack the earlier/later stages may borrow — `report()` accounts for that.
 */
export const STAGE_BUDGETS_MS = Object.freeze({
  capture: 200,            // VAD close + segment handoff (§6.2.1–2)
  stt_partial: 600,        // first partial caption (§6.2.3) — first-token metric
  stt_final: 500,          // final transcript + language confirm (§6.2.3–4)
  mt: 350,                 // streaming translation (§6.2.5)
  llm_correct: 250,        // OPTIONAL context/correction pass
  tts_first_audio: 500,    // first synthesized chunk (§6.2.6) — first-audio metric
  playback_schedule: 100   // buffer + schedule (§6.2.7)
})

/** Stage order, frozen, so a report reads in pipeline order every time. */
export const STAGE_ORDER = Object.freeze(Object.keys(STAGE_BUDGETS_MS))

const KNOWN_STAGES = new Set(STAGE_ORDER)

function defaultClock () {
  try { if (typeof performance !== 'undefined' && performance.now) return performance.now() } catch { /* none */ }
  return Date.now()
}

/**
 * Create a latency-budget accumulator for one utterance.
 *
 * `clock` is injectable so tests are deterministic — a fake clock advanced by
 * fixed amounts makes the whole budget arithmetic exactly reproducible, which is
 * the only way to unit-test a latency type without flakiness.
 *
 * Usage: `begin()` at speech-end, then `mark(stage)` as each stage completes.
 * `mark` records the delta since the previous mark (or since `begin`), so stages
 * are measured back-to-back the way the pipeline actually runs them.
 */
export function createLatencyBudget ({ totalMs = TOTAL_BUDGET_MS, stageBudgets = STAGE_BUDGETS_MS, clock = defaultClock } = {}) {
  const budgets = { ...stageBudgets }
  const durations = {}        // stage -> measured ms
  let t0 = null
  let last = null

  function assertStage (stage) {
    if (!KNOWN_STAGES.has(stage) && !(stage in budgets)) {
      throw new Error(`latency: unknown stage "${stage}"`)
    }
  }

  return {
    /** Start the clock (call at end-of-speech). Returns the start timestamp. */
    begin () {
      t0 = clock()
      last = t0
      return t0
    },

    /**
     * Record completion of `stage`. Measures from the previous mark. Returns the
     * stage's measured duration. Throws if called before `begin()` — an unstarted
     * budget silently recording nonsense is worse than a loud failure.
     */
    mark (stage) {
      assertStage(stage)
      if (t0 == null) throw new Error('latency: mark() before begin()')
      const now = clock()
      const dur = now - last
      durations[stage] = (durations[stage] || 0) + dur
      last = now
      return dur
    },

    /** Total elapsed since `begin()`. Null before begin. */
    elapsed () { return t0 == null ? null : last - t0 },

    /** Budget remaining against the total. Negative once over. */
    remaining () { return t0 == null ? totalMs : totalMs - (last - t0) },

    /** True once total elapsed exceeds the total budget. */
    overBudget () { return t0 != null && (last - t0) > totalMs },

    /** True iff a recorded stage exceeded its own slice. */
    stageOver (stage) {
      assertStage(stage)
      return durations[stage] != null && durations[stage] > (budgets[stage] ?? Infinity)
    },

    /** Which recorded stages blew their slice (in pipeline order). */
    breachedStages () {
      return STAGE_ORDER.filter((s) => durations[s] != null && durations[s] > (budgets[s] ?? Infinity))
    },

    /**
     * The typed accounting report — the value the orchestrator attaches to an
     * utterance result and a benchmark harness aggregates.
     */
    report () {
      const total = t0 == null ? 0 : last - t0
      const perStage = STAGE_ORDER
        .filter((s) => s in durations)
        .map((s) => ({ stage: s, ms: durations[s], budgetMs: budgets[s] ?? null, over: this.stageOver(s) }))
      return {
        totalMs,
        measuredMs: total,
        withinBudget: total <= totalMs,
        overBy: Math.max(0, total - totalMs),
        perStage,
        breached: this.breachedStages()
      }
    }
  }
}
