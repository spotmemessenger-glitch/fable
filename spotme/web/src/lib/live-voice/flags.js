/**
 * Spot Me — Live Voice Translation feature flag. Roadmap V2 §6, ADR-011.
 *
 * THIS FLAG IS OFF AND STAYS OFF THIS CYCLE. The live-voice module is
 * scaffolding: typed interfaces, a state machine, a latency-budget type, wire
 * frames, an orchestrator skeleton, and deterministic stub adapters. None of it
 * is wired into a call, and no real STT/MT/TTS provider is contacted. The gate
 * exists so the wiring, when it lands, has exactly one switch to flip — not so
 * anything ships behind it now.
 *
 * WHY A HELPER AND NOT A BARE CONSTANT. The value has to read the same in three
 * places that disagree about how env vars arrive: Vite injects `import.meta.env`
 * at build time, a Node server reads `process.env`, and the test runner has
 * neither of the browser globals the rest of the app assumes. `import.meta.env`
 * is `undefined` under `node --test`, so the optional chaining below is load-
 * bearing, not defensive decoration — the same shape `api.js` relies on.
 *
 * DEFAULT IS false, AND ONLY AN EXPLICIT AFFIRMATIVE FLIPS IT. An unset, empty,
 * or unrecognised value is OFF. Nothing in this repository sets it true; a test
 * that needs the orchestrator constructs it directly with stub adapters rather
 * than reaching through this gate, precisely so "the flag is never enabled"
 * stays literally true.
 */

/** The one env var that governs the feature. Documented in ADR-011 §Rollback. */
export const LIVE_VOICE_FLAG = 'LIVE_VOICE_ENABLED'

/* Only these count as "on". Everything else — including undefined, '', 'false',
 * '0', 'no' — is off. Kept explicit so a truthy-string bug can't enable a
 * flagship feature by accident (`Boolean('false') === true`). */
const AFFIRMATIVE = Object.freeze(new Set(['true', '1', 'on', 'yes']))

/* An in-process override, null unless a caller sets it. This is the seam the
 * future wire-in and its tests use; it is NOT a way to enable the feature in
 * production, because production sets env, not this. Defaults to null so env
 * decides. */
let override = null

function readEnv (name) {
  // Vite/browser build.
  try {
    // eslint-disable-next-line no-undef
    const v = import.meta.env?.[name] ?? import.meta.env?.[`VITE_${name}`]
    if (v != null) return String(v)
  } catch { /* import.meta.env absent (Node) */ }
  // Node / server.
  try {
    if (typeof process !== 'undefined' && process.env && process.env[name] != null) {
      return String(process.env[name])
    }
  } catch { /* no process */ }
  return null
}

/**
 * Is Live Voice Translation enabled on this device/build? Defaults to false.
 *
 * The override wins only when explicitly set, so tests can assert both branches
 * without mutating the environment; with no override it is env, and with no env
 * it is false.
 */
export function isLiveVoiceEnabled () {
  if (override !== null) return override === true
  const raw = readEnv(LIVE_VOICE_FLAG)
  return raw != null && AFFIRMATIVE.has(raw.trim().toLowerCase())
}

/**
 * Force the flag on/off in-process, or pass null to fall back to env. Exposed
 * for the future wire-in and its tests ONLY. Returns the resolved boolean so a
 * test reads back exactly what it set.
 */
export function setLiveVoiceOverride (value) {
  override = value === null ? null : value === true
  return isLiveVoiceEnabled()
}
