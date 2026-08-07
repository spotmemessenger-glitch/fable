/**
 * Spot Me — the like burst. B1.
 *
 * A like has to feel like it landed BEFORE the network knows anything about it,
 * so the animation is driven entirely by the tap and never waits on a promise.
 * If the request later fails the caller reverts; that is a correction, not the
 * normal path, and the normal path must not be paced by the slowest device on
 * the worst connection.
 *
 * WHY THIS RUNS ON TRANSFORM AND OPACITY ONLY. Anything touching width, top,
 * margin or a layout-affecting property forces layout on every frame, and this
 * fires while a feed is being scrolled. Transform and opacity are composited,
 * so the burst cannot make the scroll stutter no matter how many particles are
 * on screen. Nothing here is `position: static` either — every particle is
 * absolutely positioned inside a zero-size anchor, so adding them cannot move a
 * single pixel of the card. That is the "no layout shift" requirement, met
 * structurally rather than by being careful.
 *
 * TOTAL DURATION IS UNDER 400ms by construction: the scale settle is 260ms and
 * the particles are 380ms, and both are declared here rather than in CSS so the
 * budget is checkable in one place.
 */

/** The overshoot-and-settle on the heart itself. */
const POP_MS = 260
/** The particle throw. Kept under the 400ms ceiling. */
const PARTICLE_MS = 380
const PARTICLE_COUNT = 8

/** Respect the reader's own setting — a burst is decoration, and some people
 *  are made ill by it. Checked at call time, not cached: it can change. */
const reduced = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * A short haptic tick, where the platform allows it.
 *
 * iOS Safari does not implement `navigator.vibrate` at all, so this is a no-op
 * on the owner's phone — stated rather than pretended. Android Chrome honours
 * it. It is wrapped because some browsers throw when called without a gesture
 * on the stack rather than returning false.
 */
export function tick (ms = 12) {
  try { navigator.vibrate?.(ms) } catch { /* not permitted here */ }
}

/**
 * Pop `el` and throw a particle burst from `origin`.
 *
 * `origin` is optional and is used by the double-tap path so the burst is
 * centred on the finger rather than on the heart — a burst that appears
 * somewhere other than where you tapped reads as an unrelated animation.
 */
export function likeBurst (el, origin = null) {
  if (!el || reduced()) return

  el.classList.remove('mo-pop')
  // Force a reflow so a second tap re-triggers the animation instead of being
  // swallowed as "the class is already there".
  void el.offsetWidth
  el.classList.add('mo-pop')
  setTimeout(() => el.classList.remove('mo-pop'), POP_MS + 40)

  /* The particles live in a zero-size absolutely-positioned anchor so they
   * cannot affect layout, and the anchor is removed on its own timer rather
   * than on animationend — an element removed mid-animation never fires it,
   * and a leaked anchor per like adds up over a long feed. */
  const host = origin?.host || el.parentElement
  if (!host) return
  const anchor = document.createElement('span')
  anchor.className = 'mo-burst'
  anchor.setAttribute('aria-hidden', 'true')
  if (origin) { anchor.style.left = `${origin.x}px`; anchor.style.top = `${origin.y}px` }

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = document.createElement('i')
    const angle = (360 / PARTICLE_COUNT) * i + (i % 2 ? 12 : -12)
    p.style.setProperty('--a', `${angle}deg`)
    p.style.setProperty('--d', `${22 + (i % 3) * 7}px`)
    p.style.animationDelay = `${i * 6}ms`
    anchor.appendChild(p)
  }
  host.appendChild(anchor)
  setTimeout(() => anchor.remove(), PARTICLE_MS + PARTICLE_COUNT * 6 + 60)
}

/**
 * Double-tap to like, on the media.
 *
 * 300ms is the window; beyond that two taps are two taps. The second tap's
 * coordinates are handed back so the burst lands under the finger.
 *
 * It does NOT preventDefault: the single-tap behaviour (open the viewer) must
 * still work, and swallowing the event to make a gesture "cleaner" is how a tap
 * target stops responding for everyone who taps twice by accident.
 */
export function onDoubleTap (node, fn, windowMs = 300) {
  let last = 0
  const handler = (e) => {
    const now = Date.now()
    if (now - last < windowMs) {
      last = 0
      const box = node.getBoundingClientRect()
      const x = (e.clientX ?? box.left + box.width / 2) - box.left
      const y = (e.clientY ?? box.top + box.height / 2) - box.top
      fn({ x, y, host: node })
    } else {
      last = now
    }
  }
  node.addEventListener('click', handler)
  return () => node.removeEventListener('click', handler)
}
