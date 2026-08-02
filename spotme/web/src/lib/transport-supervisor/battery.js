/**
 * Spot Me — BATTERY AWARENESS for the adaptive layer. ADR-012b.
 *
 * The selector's battery axis and the mesh's duty cycling both need one fact:
 * how much battery is left, and whether the device is charging. The web
 * platform's answer is the Battery Status API (`navigator.getBattery`), which
 * exists on Chromium and is absent on Safari/Firefox — so this module is a
 * feature detection with an HONEST fallback, not a shim that invents numbers.
 *
 * THE CONSERVATIVE DEFAULT. Where the API is missing, the reader reports
 * `known: false` with a level of 0.5 and charging unknown. Callers must treat
 * unknown as "assume mid-battery, spend cautiously": the scoring context sets
 * batterySaver only on KNOWN low battery, and duty cycling uses the more
 * conservative of its known/unknown schedules. Guessing "full" would burn
 * radios on iPhones (where the API never exists); guessing "empty" would
 * disable offline paths for every Safari user. 0.5-and-unknown is the only
 * default that fails soft in both directions.
 *
 * `getBattery` is INJECTED (defaulting to the real navigator) so tests can
 * script levels and the module never touches the platform at import time.
 */

/** Thresholds, as data, so the docs and the code cannot drift apart. */
export const BATTERY_POLICY = Object.freeze({
  saverBelow: 0.20,      // known level below this ⇒ batterySaver context for scoring
  meshFloorLevel: 0.15,  // known level below this ⇒ mesh drops to receive-only duty
  refreshMs: 30_000      // how often a cached reading is considered fresh
})

/**
 * Create a battery reader.
 *
 * `read()` resolves to `{ level, charging, known, at }` — level 0..1. It
 * caches the platform BatteryManager after the first call (the object is
 * live; its properties update in place) and never rejects: platform absence
 * or a platform error both resolve to the conservative unknown.
 */
export function createBatteryReader ({ getBattery = null, clock = null } = {}) {
  const nowFn = clock ? clock.now : () => Date.now()
  const source = getBattery !== null
    ? getBattery
    : (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function'
        ? () => navigator.getBattery()
        : null)

  let manager = null      // live BatteryManager (or fake), once obtained
  let failed = false      // the source threw — do not hammer it every read

  const unknown = () => Object.freeze({ level: 0.5, charging: null, known: false, at: nowFn() })

  async function read () {
    if (!source || failed) return unknown()
    try {
      if (!manager) manager = await source()
      const level = Number(manager?.level)
      if (!Number.isFinite(level) || level < 0 || level > 1) return unknown()
      return Object.freeze({
        level,
        charging: typeof manager.charging === 'boolean' ? manager.charging : null,
        known: true,
        at: nowFn()
      })
    } catch {
      failed = true
      return unknown()
    }
  }

  return Object.freeze({
    read,
    /** Whether the platform offers a battery signal at all. */
    supported: source !== null,
    /** Map a reading to the scoring context: saver only on KNOWN low, discharging. */
    toContext (reading) {
      const saver = reading.known === true &&
        reading.level < BATTERY_POLICY.saverBelow &&
        reading.charging !== true
      return Object.freeze({ batterySaver: saver, batteryLevel: reading.level, batteryKnown: reading.known === true })
    }
  })
}
