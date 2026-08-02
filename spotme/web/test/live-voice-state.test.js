/**
 * Live-voice utterance/session state machine — legal moves only (ADR-011, §6.2).
 *
 * The pipeline's stages are states, and the reason to make them a machine is
 * that the illegal moves are the dangerous ones: synthesizing before translating,
 * playing a dropped utterance, advancing a completed one. Each of those corrupts
 * playback order downstream, so the machine refuses them at the seam. This test
 * pins the happy path, the branches (optional correction, barge-in, drop), and
 * that terminals are terminal.
 *
 * Deterministic clock so `history` timestamps are reproducible.
 */
import {
  UTTERANCE_STATES as U, SESSION_STATES as S,
  UTTERANCE_TRANSITIONS, canTransition, isTerminalUtterance,
  createUtteranceMachine, createSessionMachine, createLiveTranslationSession
} from '../src/lib/live-voice/session-state.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

let t = 0
const clock = () => t
const tick = (ms = 10) => { t += ms }

/* -------- happy path -------- */
check('the full happy path is legal: idle→…→completed', () => {
  t = 0
  const m = createUtteranceMachine({ clock })
  const path = [U.LISTENING, U.TRANSCRIBING, U.TRANSLATING, U.CORRECTING, U.SYNTHESIZING, U.PLAYING, U.COMPLETED]
  for (const s of path) { tick(); m.to(s) }
  return m.state === U.COMPLETED && m.history.length === path.length + 1
})

check('correction is skippable: translating→synthesizing is legal', () =>
  canTransition(UTTERANCE_TRANSITIONS, U.TRANSLATING, U.SYNTHESIZING))

/* -------- illegal moves -------- */
check('cannot skip ahead: listening→synthesizing is refused', () => {
  const m = createUtteranceMachine({ clock })
  m.to(U.LISTENING)
  return throws(() => m.to(U.SYNTHESIZING))
})
check('cannot go backwards: translating→listening is refused', () => {
  const m = createUtteranceMachine({ clock })
  m.to(U.LISTENING); m.to(U.TRANSCRIBING); m.to(U.TRANSLATING)
  return throws(() => m.to(U.LISTENING))
})
check('an illegal move does not mutate state', () => {
  const m = createUtteranceMachine({ clock })
  m.to(U.LISTENING)
  try { m.to(U.PLAYING) } catch { /* expected */ }
  return m.state === U.LISTENING
})
check('unknown target state is rejected', () => {
  const m = createUtteranceMachine({ clock })
  return throws(() => m.to('teleporting'))
})

/* -------- branches: barge-in and drop -------- */
check('barge-in from any active stage: synthesizing→interrupted→dropped', () => {
  const m = createUtteranceMachine({ clock })
  m.to(U.LISTENING); m.to(U.TRANSCRIBING); m.to(U.TRANSLATING); m.to(U.SYNTHESIZING)
  m.to(U.INTERRUPTED); m.to(U.DROPPED)
  return m.state === U.DROPPED
})
check('interrupted can restart the utterance: interrupted→listening', () =>
  canTransition(UTTERANCE_TRANSITIONS, U.INTERRUPTED, U.LISTENING))
check('any active stage can drop straight to dropped', () =>
  [U.LISTENING, U.TRANSCRIBING, U.TRANSLATING, U.CORRECTING, U.SYNTHESIZING, U.PLAYING]
    .every((s) => canTransition(UTTERANCE_TRANSITIONS, s, U.DROPPED)))

/* -------- terminals -------- */
check('completed and dropped are terminal — no outgoing edges', () =>
  isTerminalUtterance(U.COMPLETED) && isTerminalUtterance(U.DROPPED) &&
  UTTERANCE_TRANSITIONS[U.COMPLETED].length === 0 && UTTERANCE_TRANSITIONS[U.DROPPED].length === 0)
check('cannot advance out of a terminal state', () => {
  const m = createUtteranceMachine({ clock })
  m.to(U.LISTENING); m.to(U.DROPPED)
  return throws(() => m.to(U.LISTENING))
})
check('history records every state with a timestamp', () => {
  t = 0
  const m = createUtteranceMachine({ clock })
  tick(5); m.to(U.LISTENING); tick(7); m.to(U.TRANSCRIBING)
  const h = m.history
  return h.length === 3 && h[0].state === U.IDLE && h[2].state === U.TRANSCRIBING && typeof h[2].at === 'number'
})

/* -------- session machine + LiveTranslationSession -------- */
check('session machine can degrade and recover: active⇄degraded', () => {
  const m = createSessionMachine({ clock })
  m.to(S.ACTIVE); m.to(S.DEGRADED); m.to(S.ACTIVE)
  return m.state === S.ACTIVE
})
check('LiveTranslationSession requires a language pair', () =>
  throws(() => createLiveTranslationSession({ sessionId: 's' })))
check('LiveTranslationSession mints uniquely-ided utterance machines', () => {
  const sess = createLiveTranslationSession({ sessionId: 's1', sourceLang: 'en', targetLang: 'ta', clock })
  const a = sess.newUtterance(); const b = sess.newUtterance()
  return a.id !== b.id && sess.getUtterance(a.id) === a.machine && sess.utteranceIds.length === 2
})
check('a session may carry a null voice profile (captions-only is valid)', () => {
  const sess = createLiveTranslationSession({ sessionId: 's1', sourceLang: 'en', targetLang: 'ta', clock })
  return sess.voiceProfileId === null
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice state machine — legal moves')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
