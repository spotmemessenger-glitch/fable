/**
 * Spot Me — shared inline-video machinery for the feed and the reels viewer.
 *
 * This exists because the two surfaces MUST agree. A feed card and a reel are
 * the same clip in two frames, so if they disagree about muting, about which
 * element owns the speaker, or about whether a tap goes fullscreen, the reader
 * sees the seams. One implementation, imported twice.
 *
 * THE iOS RULE THAT DRIVES THE SHAPE OF THIS FILE: a <video> that is not
 * inline-eligible at the moment play() is called is handed to the native
 * fullscreen player, which takes over the screen and cannot be styled or
 * dismissed back into our UI. Inline eligibility needs BOTH the attribute and
 * the DOM property, and it needs them before the first play() — not after.
 */

/* ------------------------------------------------------------------ sound */

/* SOUND ON BY DEFAULT, AS FAR AS THE PLATFORM ALLOWS.
 *
 * Video is meant to arrive with its sound. What stops that is not a preference
 * but a browser rule: audible playback is refused until the page has been
 * touched, on every mobile browser and most desktop ones. So the honest shape
 * is not "start unmuted" (which silently fails and leaves a muted video and a
 * confused reader) but:
 *
 *   1. start MUTED, so the first frames actually roll rather than being
 *      refused outright;
 *   2. the reader's FIRST TAP ANYWHERE in the app is the gesture that unlocks
 *      audio — it does not have to be aimed at a video, or at anything;
 *   3. from that moment sound defaults ON for the session, in the feed and in
 *      the reels viewer alike;
 *   4. and an EXPLICIT choice — actually pressing mute or unmute — outranks
 *      the default and PERSISTS across app opens.
 *
 * The distinction in (4) is the whole reason `explicit` exists. Someone who
 * mutes a video is telling us something; the unlock must never talk over it,
 * on this open or the next one. Someone who has never touched the control gets
 * sound, because that is what the product wants to do by default.
 */
const SOUND_KEY = 'spotme.sound'

const readChoice = () => {
  try {
    const v = localStorage.getItem(SOUND_KEY)
    return v === 'on' || v === 'off' ? v : null
  } catch { return null }            // private mode / storage disabled
}
const writeChoice = (v) => { try { localStorage.setItem(SOUND_KEY, v) } catch { /* not fatal */ } }

/** An explicit stored choice, or null if they have never pressed the control. */
let explicit = readChoice()
/* Audible playback needs a gesture, so the SESSION always begins muted — even
 * when the stored choice is 'on'. The first tap promotes it. */
let soundOn = false
let unlocked = false
const listeners = new Set()

export const isSoundOn = () => soundOn
/** Has a real user gesture happened yet? Exposed for tests and diagnostics. */
export const isAudioUnlocked = () => unlocked

/** Subscribe to sound changes. Returns an unsubscribe. */
export function onSoundChange (fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const emit = () => { for (const fn of listeners) fn(soundOn) }

/**
 * Flip the shared sound state. This is the EXPLICIT path — pressing the
 * control — so it records the choice durably and the first-tap default will
 * never override it again.
 *
 * MUST be called from a user gesture the first time it turns sound on: every
 * browser refuses audible playback otherwise, and refuses it SILENTLY, which
 * is why an unmute button that "does nothing" is the usual symptom of calling
 * this from a timer or an observer.
 */
export function setSoundOn (on, current) {
  soundOn = !!on
  explicit = soundOn ? 'on' : 'off'
  unlocked = true                    // the press itself is the gesture
  writeChoice(explicit)
  if (current) unmuteNow(current)
  emit()
}

/**
 * Make an element audible FROM INSIDE A GESTURE.
 *
 * Clearing `.muted` on an element that is already rolling does not reliably
 * route audio: it was started muted, the output is detached, and iOS Safari
 * only re-attaches it when a play() is issued with user activation on the
 * stack. Setting the flag alone leaves a video that plays in silence — which
 * is exactly the bug where sound "only works after you mute it and replay".
 * Muting and replaying worked because the replay WAS a gesture.
 *
 * So: unmute, then call play() unconditionally — not only when paused. Calling
 * play() on an already-playing element is a no-op for playback and is
 * precisely what re-attaches the audio track.
 */
function unmuteNow (v) {
  if (!v) return
  v.muted = !soundOn
  if (!soundOn) return
  try {
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => { /* policy refused */ })
  } catch { /* refused */ }
}

/**
 * The first-tap unlock. Idempotent, and deliberately NOT tied to the video
 * controls — the gesture that buys audible playback can be any tap in the app.
 *
 * Respects an explicit 'off': someone who muted stays muted.
 */
export function unlockAudio () {
  if (unlocked) return
  unlocked = true
  if (explicit === 'off') return     // they said no; the default does not argue
  soundOn = true
  // Same rule as the control: unmute AND play, inside this gesture. The
  // element is almost always already rolling muted at this point, which is the
  // exact case where clearing `.muted` alone produces no sound.
  if (current) unmuteNow(current)
  emit()
}

/**
 * Listen for the first gesture anywhere in the app. Called once from the shell
 * so a tap on ANY screen — a chat, a tab, a button — unlocks audio before the
 * reader ever reaches a video.
 *
 * `pointerdown` alone is not enough: iOS Safari grants activation on
 * touchend/click, and some in-app WebViews never emit pointer events at all.
 * All three are registered and the first one wins.
 */
export function installAudioUnlock (target = document) {
  const go = () => unlockAudio()
  for (const evt of ['pointerdown', 'touchend', 'click', 'keydown']) {
    target.addEventListener(evt, go, { once: true, capture: true, passive: true })
  }
}

/* --------------------------------------------------------------- elements */

/**
 * A <video> that will play INLINE on every browser we ship to.
 *
 * Both spellings of playsinline are set: `playsinline` is the standard and
 * what modern iOS reads, `webkit-playsinline` is the older WebKit spelling
 * that iOS 9-era WebViews (still reachable through in-app browsers and some
 * Android WebViews) require. Setting one is the common bug; the other is the
 * one that was missing here.
 *
 * The DOM properties are set as well as the attributes on purpose. For an
 * element built by script and not yet in the document, WebKit has historically
 * consulted the property rather than the parsed attribute when deciding
 * inline eligibility, so attribute-only setup still went fullscreen.
 */
export function videoEl (className, { loop = true, preload = 'metadata' } = {}) {
  const v = document.createElement('video')
  v.className = className
  v.setAttribute('playsinline', '')
  v.setAttribute('webkit-playsinline', '')
  v.setAttribute('muted', '')
  v.setAttribute('preload', preload)
  if (loop) v.setAttribute('loop', '')
  // Keep the OS out of it: no PiP button, no AirPlay/Cast route picker. Both
  // hand playback to a surface that leaves our viewer behind.
  v.setAttribute('disablepictureinpicture', '')
  v.setAttribute('disableremoteplayback', '')
  v.muted = true
  v.playsInline = true
  v.loop = loop
  v.preload = preload
  v.disableRemotePlayback = true
  return v
}

/* -------------------------------------------------------------- playback */

/* Exactly one element owns playback. Two videos playing at once is the bug
 * where scrolling the feed leaves a trail of audio behind you. */
let current = null

export const currentVideo = () => current

/**
 * Play `v`, pausing whatever held playback before it.
 *
 * Autoplay policy is handled by DEGRADING rather than failing: an audible
 * play() is refused unless this page has enough user activation, so a refusal
 * falls back to muted playback instead of leaving a frozen poster. The reader
 * still sees motion, and the unmute control still works on their next tap.
 */
export async function playExclusive (v) {
  if (!v) return false
  if (current && current !== v) pause(current)
  current = v
  v.muted = !soundOn
  try {
    await v.play()
    return true
  } catch {
    // Audible playback refused — retry muted, which is always permitted.
    if (!v.muted) {
      v.muted = true
      try {
        await v.play()
        return true
      } catch { /* fall through: the caller offers a tap-to-play */ }
    }
    return false
  }
}

export function pause (v) {
  if (!v) return
  try { v.pause() } catch { /* a detached element can throw; not interesting */ }
  if (current === v) current = null
}

/** Pause whatever is playing, wherever it lives. */
export function pauseAll () { if (current) pause(current) }

/* -------------------------------------------------------------- viewport */

/**
 * The ONE in-view observer both surfaces are built from.
 *
 * The feed and the reels track have different geometry — a card is one of
 * several on screen, a reel fills it — but the question is identical: "is this
 * the element the reader is looking at?" So the threshold is a parameter and
 * the observer is not written twice. `ratio` defaults to 0.6 because a card
 * more than half on screen is the one being read; lower values fight at the
 * boundary and flap between two cards.
 */
export function watchInView (onEnter, onExit, ratio = 0.6) {
  return new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= ratio) onEnter(e.target)
      else onExit(e.target)
    }
  }, { threshold: [0, ratio, 1] })
}
