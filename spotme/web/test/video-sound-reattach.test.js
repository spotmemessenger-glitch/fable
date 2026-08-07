/**
 * THE "SOUND ONLY WORKS AFTER I MUTE IT AND REPLAY" BUG, PINNED.
 *
 * Symptom: a video in the feed rolls silently. Pressing unmute does nothing.
 * Muting it again and letting it replay produces sound.
 *
 * Cause: the element starts MUTED (it has to — audible autoplay is refused),
 * and clearing `.muted` on an element that is ALREADY ROLLING does not reliably
 * route audio. iOS Safari re-attaches the output only when a `play()` is issued
 * with user activation on the stack. The old code guarded the play() behind
 * `if (current.paused)` — and a rolling video is never paused, so the one call
 * that would have re-attached the audio was the one call that never happened.
 * Mute-and-replay worked because the replay WAS a fresh play() inside a gesture.
 *
 * So the fence is behavioural: unmute a video that is NOT paused and require a
 * play() anyway. A test that only asserted `v.muted === false` would have
 * passed against the broken code — that flag was always being cleared.
 *
 *   node test/video-sound-reattach.test.js
 */

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

/* localStorage is read at module scope for the persisted choice. */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v))
}
globalThis.document = { addEventListener () {} }

const V = await import(new URL('../src/lib/video.js', import.meta.url).href)

/** A <video> stand-in that records play() calls and its paused state. */
const fakeVideo = ({ paused = false } = {}) => ({
  muted: true,
  paused,
  plays: 0,
  play () { this.plays++; this.paused = false; return Promise.resolve() }
})

/* --- the exact failing shape: rolling, muted, reader presses unmute ------ */
{
  const v = fakeVideo({ paused: false })
  V.setSoundOn(true, v)
  check('unmuting a ROLLING video clears .muted', v.muted === false)
  check('…and issues a play() anyway — this is what re-attaches the audio', v.plays === 1)
  check('the shared state reports sound on', V.isSoundOn() === true)
}

/* --- muting must NOT call play(): it would fight a deliberate pause ------ */
{
  const v = fakeVideo({ paused: true })
  V.setSoundOn(false, v)
  check('muting sets .muted', v.muted === true)
  check('…and never resumes a paused video', v.plays === 0 && v.paused === true)
}

/* --- an explicit 'off' outranks the first-tap default, on this open ------ */
{
  const v = fakeVideo({ paused: false })
  V.setSoundOn(true, v)
  check('an explicit choice persists to storage', store.get('spotme.sound') === 'on')
}

/* --- a rejected play() must not throw out of the control ----------------- */
{
  const v = fakeVideo({ paused: false })
  v.play = function () { this.plays++; return Promise.reject(new Error('NotAllowedError')) }
  let threw = false
  try { V.setSoundOn(true, v) } catch { threw = true }
  await new Promise((r) => setTimeout(r, 0))
  check('a policy refusal is swallowed — the control never throws', !threw && v.plays === 1)
}

/* --- no element in hand is not an error --------------------------------- */
{
  let threw = false
  try { V.setSoundOn(true, null) } catch { threw = true }
  check('setSoundOn with no current video is a no-op, not a crash', !threw)
}

console.log(`\n========================================\n  ${pass}/${pass + fail} passed\n========================================\n`)
if (fail > 0) process.exit(1)
