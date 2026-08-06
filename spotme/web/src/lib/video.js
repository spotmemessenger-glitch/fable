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

/* Muted until the reader asks otherwise, then the choice STICKS for the rest
 * of the session and follows them from a card into the reels viewer. Sound
 * that resets on every scroll is the behaviour people describe as "it keeps
 * muting itself"; sound that persists is the one they read as working. */
let soundOn = false
const listeners = new Set()

export const isSoundOn = () => soundOn

/** Subscribe to sound changes. Returns an unsubscribe. */
export function onSoundChange (fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Flip the shared sound state. MUST be called from a user gesture the first
 * time it turns sound on — every browser refuses audible playback otherwise,
 * and refuses it silently, which is why an unmute button that "does nothing"
 * is the usual symptom of calling this from a timer or an observer.
 */
export function setSoundOn (on, current) {
  soundOn = !!on
  if (current) current.muted = !soundOn
  for (const fn of listeners) fn(soundOn)
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
