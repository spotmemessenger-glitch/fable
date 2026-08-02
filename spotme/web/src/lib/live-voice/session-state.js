/**
 * Spot Me — the live-voice session & utterance state machine. §6.2, ADR-011.
 *
 * A live translation is a stream of UTTERANCES, each marching through the
 * pipeline stages of §6.2. Modelling that march as an explicit machine — rather
 * than a pile of booleans — is what makes barge-in, fallback, and the latency
 * budget legible: every stage is a named state, every legal move is in one
 * table, and an illegal move throws at the seam instead of corrupting playback
 * order three stages later.
 *
 * UTTERANCE LIFECYCLE (the happy path is the spine; the branches are the point):
 *
 *   IDLE
 *    └─ LISTENING            capture + voice-activity detection (§6.2.1–2)
 *        └─ TRANSCRIBING     streaming STT, partial→final (§6.2.3–4)
 *            └─ TRANSLATING  streaming MT with context (§6.2.5)
 *                ├─ CORRECTING   optional LLM polish/context fix
 *                │    └─ SYNTHESIZING
 *                └─ SYNTHESIZING streaming TTS in the consented voice (§6.2.6)
 *                    └─ PLAYING   scheduled playback (§6.2.7)
 *                        └─ COMPLETED   (terminal, success)
 *
 *   From any active state:
 *     • INTERRUPTED  barge-in — the speaker started a new utterance. From here
 *                    the utterance is abandoned (→ DROPPED) or, when the machine
 *                    is reused, restarts (→ LISTENING).
 *     • DROPPED      (terminal, failure) — error, timeout, or over-budget with
 *                    fallback to captions/original audio (§6.2.8).
 *
 * CORRECTING is OPTIONAL: with no LLM corrector wired, TRANSLATING goes straight
 * to SYNTHESIZING. Both edges are legal so the orchestrator can skip the stage
 * without the machine treating the skip as a violation.
 */

/** Every state an utterance can occupy. */
export const UTTERANCE_STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  TRANSCRIBING: 'transcribing',
  TRANSLATING: 'translating',
  CORRECTING: 'correcting',
  SYNTHESIZING: 'synthesizing',
  PLAYING: 'playing',
  COMPLETED: 'completed',     // terminal — success
  INTERRUPTED: 'interrupted', // barge-in — abandon or restart
  DROPPED: 'dropped'          // terminal — failure/fallback
})

/** Session-level state, coarser than the per-utterance machine. */
export const SESSION_STATES = Object.freeze({
  IDLE: 'idle',
  ACTIVE: 'active',       // translating normally
  DEGRADED: 'degraded',   // AI unavailable — captions/original audio only (§6.2.8)
  ENDED: 'ended'          // terminal
})

const U = UTTERANCE_STATES
const S = SESSION_STATES

/** Terminal utterance states — no outgoing edges. */
export const TERMINAL_UTTERANCE_STATES = Object.freeze([U.COMPLETED, U.DROPPED])

/**
 * The legal moves, as an adjacency map. Every active state can be INTERRUPTED or
 * DROPPED, which encodes "barge-in and failure can happen at any stage" once
 * rather than scattering it. Terminal states map to an empty set.
 */
export const UTTERANCE_TRANSITIONS = Object.freeze({
  [U.IDLE]: Object.freeze([U.LISTENING, U.DROPPED]),
  [U.LISTENING]: Object.freeze([U.TRANSCRIBING, U.INTERRUPTED, U.DROPPED]),
  [U.TRANSCRIBING]: Object.freeze([U.TRANSLATING, U.INTERRUPTED, U.DROPPED]),
  [U.TRANSLATING]: Object.freeze([U.CORRECTING, U.SYNTHESIZING, U.INTERRUPTED, U.DROPPED]),
  [U.CORRECTING]: Object.freeze([U.SYNTHESIZING, U.INTERRUPTED, U.DROPPED]),
  [U.SYNTHESIZING]: Object.freeze([U.PLAYING, U.INTERRUPTED, U.DROPPED]),
  [U.PLAYING]: Object.freeze([U.COMPLETED, U.INTERRUPTED, U.DROPPED]),
  [U.COMPLETED]: Object.freeze([]),
  [U.INTERRUPTED]: Object.freeze([U.LISTENING, U.DROPPED]),
  [U.DROPPED]: Object.freeze([])
})

/** Session-level transitions. DEGRADED is reachable from ACTIVE and recoverable. */
export const SESSION_TRANSITIONS = Object.freeze({
  [S.IDLE]: Object.freeze([S.ACTIVE, S.ENDED]),
  [S.ACTIVE]: Object.freeze([S.DEGRADED, S.ENDED]),
  [S.DEGRADED]: Object.freeze([S.ACTIVE, S.ENDED]),
  [S.ENDED]: Object.freeze([])
})

/** True iff `to` is reachable from `from` in one step of `table`. */
export function canTransition (table, from, to) {
  const outs = table[from]
  return Array.isArray(outs) && outs.includes(to)
}

/** True iff `state` is a terminal utterance state. */
export function isTerminalUtterance (state) {
  return TERMINAL_UTTERANCE_STATES.includes(state)
}

/**
 * A tiny, validating state machine. `to(next)` throws on an illegal move — a
 * partially advanced utterance is worse than a refused one because it desynced
 * playback three stages downstream — and records history so a test (or a post-
 * mortem) can read the exact path taken and the time spent in each state.
 */
export function createMachine (table, initial, { label = 'machine', clock = defaultClock, onTransition = null } = {}) {
  if (!(initial in table)) throw new Error(`${label}: unknown initial state "${initial}"`)
  let state = initial
  const history = [{ state: initial, at: clock() }]

  return {
    get state () { return state },
    get history () { return history.slice() },

    /** Attempt a transition. Returns the new state; throws if illegal. */
    to (next, meta = null) {
      if (!(next in table)) throw new Error(`${label}: unknown target state "${next}"`)
      if (!canTransition(table, state, next)) {
        throw new Error(`${label}: illegal transition ${state} → ${next}`)
      }
      const from = state
      state = next
      history.push({ state: next, at: clock(), meta })
      if (onTransition) onTransition({ from, to: next, meta })
      return state
    },

    /** True iff `next` would be accepted right now. */
    can (next) { return canTransition(table, state, next) }
  }
}

/** A machine for one utterance, starting IDLE. */
export function createUtteranceMachine (opts = {}) {
  return createMachine(UTTERANCE_TRANSITIONS, UTTERANCE_STATES.IDLE, { label: 'utterance', ...opts })
}

/** A machine for a session, starting IDLE. */
export function createSessionMachine (opts = {}) {
  return createMachine(SESSION_TRANSITIONS, SESSION_STATES.IDLE, { label: 'session', ...opts })
}

/* Monotonic-ish default clock. `performance.now()` where present (monotonic,
 * immune to wall-clock jumps mid-call — which is what you want for latency), and
 * `Date.now()` on the bare test runner. Injected in tests for determinism. */
function defaultClock () {
  try { if (typeof performance !== 'undefined' && performance.now) return performance.now() } catch { /* none */ }
  return Date.now()
}

/**
 * The LiveTranslationSession value: the typed record the orchestrator threads
 * through the pipeline. It owns the session machine, the language pair, the
 * CONSENTED voice profile id (never invented — §6.3/§6.4, ADR-011), and the map
 * of live utterances. It holds NO key material and NO raw audio.
 */
export function createLiveTranslationSession ({ sessionId, sourceLang, targetLang, voiceProfileId = null, clock = defaultClock } = {}) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('session: sessionId required')
  if (!sourceLang || typeof sourceLang !== 'string') throw new Error('session: sourceLang required')
  if (!targetLang || typeof targetLang !== 'string') throw new Error('session: targetLang required')

  const machine = createSessionMachine({ clock })
  const utterances = new Map()   // utteranceId -> utterance machine
  let counter = 0

  return {
    sessionId,
    sourceLang,
    targetLang,
    voiceProfileId,               // may be null → TTS falls back to captions-only
    machine,
    get state () { return machine.state },

    /** Register and return a new utterance machine with a fresh id. */
    newUtterance (onTransition = null) {
      const id = `${sessionId}:u${++counter}`
      const m = createUtteranceMachine({ clock, onTransition })
      utterances.set(id, m)
      return { id, machine: m }
    },

    getUtterance (id) { return utterances.get(id) || null },
    get utteranceIds () { return [...utterances.keys()] }
  }
}
