/**
 * Spot Me — pull down to refresh.
 *
 * Shipping several times an hour means phones sit on a stale bundle until
 * someone remembers the browser's refresh gesture. This puts it in the app,
 * and makes it a HARD refresh: caches and any service worker are cleared
 * first, so the next load genuinely fetches new code rather than revalidating
 * its way back to the same files.
 *
 * The Home screen already reveals Archived at a short pull, so this arms much
 * later (110px vs 48px) — a short tug still reveals Archived, a long one
 * refreshes, and the indicator says which is about to happen.
 */
const ARM_PX = 110              // pull distance that triggers a refresh
const MAX_PX = 150              // indicator stops travelling here
const IGNORE_PX = 10            // below this it is a tap, not a drag

/** The scrollable element under the finger, if any. */
function scrollerAt (node) {
  let el = node
  while (el && el !== document.body) {
    const style = el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY
    if (style === 'auto' || style === 'scroll') return el
    el = el.parentElement
  }
  return null
}

/**
 * How long the cache clean-out gets before we reload anyway.
 *
 * It used to get forever, and that is how "Refreshing…" stuck on screen: the
 * revalidating fetch below can hang indefinitely on a mobile link, and a hang
 * is not an error, so nothing threw, nothing caught, and the reload behind it
 * simply never ran. Clearing caches is an optimisation; reloading is the
 * promise made to whoever pulled. Never let the optimisation outrank it.
 */
const CLEANUP_MS = 2500

/** Longer than the cleanup plus a slow reload — a last resort, not a race. */
const RELOAD_WATCHDOG_MS = 8000

/** Drop caches and service workers so the reload cannot serve old code. */
async function clearStaleCode () {
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
  }
  const regs = await navigator.serviceWorker?.getRegistrations?.()
  if (regs?.length) await Promise.all(regs.map((r) => r.unregister()))
  // Re-fetch the entry document bypassing the HTTP cache, so the reload picks
  // up new asset hashes instead of revalidating its way back to the old ones.
  const stop = new AbortController()
  const bail = setTimeout(() => stop.abort(), CLEANUP_MS)
  try {
    await fetch(location.pathname, { cache: 'reload', signal: stop.signal })
  } finally {
    clearTimeout(bail)
  }
}

async function hardReload () {
  try {
    await Promise.race([
      clearStaleCode(),
      new Promise((resolve) => setTimeout(resolve, CLEANUP_MS))
    ])
  } catch { /* a plain reload is still better than nothing */ }
  location.reload()
}

export function attachPullRefresh (host) {
  const spinner = document.createElement('div')
  spinner.className = 'pullref'
  spinner.innerHTML = '<span class="pullref-ic"></span><span class="pullref-tx"></span>'
  host.appendChild(spinner)

  let startY = 0
  let scroller = null
  let dragging = false
  let armed = false
  let busy = false

  const label = spinner.querySelector('.pullref-tx')

  function show (distance) {
    const travel = Math.min(distance, MAX_PX)
    spinner.style.transform = `translate(-50%, ${travel - 20}px)`
    spinner.style.opacity = String(Math.min(1, distance / 70))
    spinner.querySelector('.pullref-ic').style.transform = `rotate(${distance * 2.2}deg)`
    const nowArmed = distance >= ARM_PX
    if (nowArmed !== armed) {
      armed = nowArmed
      spinner.classList.toggle('armed', armed)
      label.textContent = armed ? 'Release to refresh' : 'Pull to refresh'
    }
  }

  function reset () {
    spinner.style.transition = 'transform .2s ease, opacity .2s ease'
    spinner.style.transform = 'translate(-50%, -60px)'
    spinner.style.opacity = '0'
    spinner.classList.remove('armed')
    setTimeout(() => { spinner.style.transition = '' }, 220)
    dragging = false
    armed = false
  }

  host.addEventListener('touchstart', (e) => {
    if (busy || e.touches.length !== 1) return
    scroller = scrollerAt(e.target)
    // Only from a genuine top-of-list position, or a screen that does not scroll.
    if (scroller && scroller.scrollTop > 0) return
    startY = e.touches[0].clientY
    dragging = true
    armed = false
    label.textContent = 'Pull to refresh'
  }, { passive: true })

  host.addEventListener('touchmove', (e) => {
    if (!dragging || busy) return
    const delta = e.touches[0].clientY - startY
    if (delta <= IGNORE_PX) { if (delta < 0) dragging = false; return }
    if (scroller && scroller.scrollTop > 0) { dragging = false; reset(); return }
    show(delta)
  }, { passive: true })

  const finish = () => {
    if (!dragging || busy) return
    if (armed) {
      busy = true
      spinner.classList.add('spinning')
      label.textContent = 'Refreshing…'
      hardReload()
      // If the reload lands, this page is gone and the timer with it. If it
      // does not — for any reason, not only the one already fixed — give the
      // screen back rather than leaving a spinner that means nothing. A stuck
      // indicator reads as a frozen app.
      setTimeout(() => {
        if (!busy) return
        busy = false
        spinner.classList.remove('spinning')
        reset()
      }, RELOAD_WATCHDOG_MS)
      return
    }
    reset()
  }

  host.addEventListener('touchend', finish, { passive: true })
  host.addEventListener('touchcancel', finish, { passive: true })
}
