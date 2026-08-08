/**
 * The React island host — deferred from slice 0, landing with slice 1.
 *
 * WHY IT WAS DEFERRED. Slice 0 hardened the dark fences, one of which asserts
 * that the live app entry imports no dark client package
 * (`liveEntryDarkPackageImports()`). With `@spotme/ui` still dark, a mount
 * point had nothing to mount and would have been dead code that tripped the
 * fence it shared a PR with. Slice 1 is its first real consumer.
 *
 * WHY A DYNAMIC IMPORT AND NOT A STATIC ONE. Two reasons, both load-bearing:
 *
 *   1. The fence. A static `import '@spotme/ui'` at the top of a live module
 *      is exactly what the dark fence forbids, and it would be right to: it
 *      makes every dark surface reachable from the shipped entry. The import
 *      specifier is ASSEMBLED AT CALL TIME from a flag that is off by default,
 *      so nothing resolves unless a human opted in.
 *   2. The bundle. A static import pulls React and every domain surface into
 *      the main chunk for the 100% of users who have the flag off. Dynamic
 *      keeps it a separate chunk that is never requested.
 *
 * ROLLBACK (ADR-035 §(g) tier 1): flip the flag off. The legacy route is
 * untouched and renders on the next navigation. Nothing here writes to
 * storage, so there is no persisted shape to diverge -- the §(g) rule that
 * makes tier-1 rollback real rather than theoretical.
 */

/**
 * Slice flags. Namespaced under `spotme.ui.` and read through one accessor so
 * a grep for the prefix finds every migration flag in the app.
 *
 * Surfaces that passed the 2026-08-08 functional sweep default ON: an ABSENT
 * key renders React. The flag is still read on every render — any explicit
 * value other than the literal 'on' (e.g. 'off') falls back to the legacy
 * view, and a storage throw still reads as legacy, so the failure mode of the
 * storage layer remains "legacy renders", never "React renders unexpectedly".
 *
 * chat and moments are deliberately NOT in this set: chat's default stays off
 * until the owner flips it on the stage-1 evidence, and the React moments
 * feed is missing its composer and its nearby results.
 */
export const DEFAULT_ON = new Set([
  'profile', 'inbox', 'contacts', 'notifications', 'groups',
  'stories', 'discovery', 'verify', 'exchange'
])

export function uiFlag (slice) {
  try {
    const v = localStorage.getItem(`spotme.ui.${slice}`)
    if (v === null) return DEFAULT_ON.has(slice)
    return v === 'on'
  } catch {
    return false
  }
}

let mounted = null
/* Monotonic mount generation. A mount takes a ticket before awaiting its
 * chunks; teardown (unmountIsland) and every newer mount advance the
 * generation, so a mount whose ticket is stale by the time the chunks arrive
 * KNOWS it lost the race and stands down. Without this, a slow island (the
 * inbox imports half the app before it mounts) resolving after the router
 * had already moved on would unmount the WINNING island and render itself
 * into a detached host — an intermittently blank screen, seen on #/exchange
 * the moment inbox defaulted on (2026-08-08). */
let mountSeq = 0

/**
 * Mount a React surface into `host`. Resolves to false when the flag is off,
 * which is the caller's signal to render the legacy view instead.
 *
 * @param {string} slice   flag suffix, e.g. 'exchange'
 * @param {HTMLElement} host
 * @param {(mod: any) => any} pick  chooses the element from the loaded module
 * @returns {Promise<boolean>} whether React took over
 */
export async function mountIsland (slice, host, pick) {
  if (!uiFlag(slice)) return false

  /* LITERAL dynamic imports, deliberately. The old assembled-at-runtime
   * specifier dodged the dark fence and Rollup alike — which meant the
   * browser was handed a bare '@spotme/ui' it could never resolve, and
   * every flag flip silently fell back to legacy (found 2026-08-08).
   * Literal + dynamic is the correct pair: Vite resolves and code-splits
   * the whole React surface into its own lazy chunk, so nothing here
   * downloads until a flag is ON — the flag guard above returns first.
   * The fence now pins THIS gate (flag-gated reachability), not the
   * absence of the string. */
  const ticket = ++mountSeq
  const [{ createRoot }, mod] = await Promise.all([
    import('react-dom/client'),
    import('@spotme/ui')
  ])

  // Lost the race while the chunks loaded — a newer mount started or the
  // view was torn down. Do NOT unmount (that would kill the winner).
  if (ticket !== mountSeq || !host.isConnected) return false
  await teardownMounted()
  if (ticket !== mountSeq || !host.isConnected) return false
  /* React's container is a PRIVATE wrapper, never the caller's element. Two
   * views (inbox, groups) hand the router's SHARED view container in as
   * `host`, and React clears its container on unmount — so the deferred
   * teardown wiped whatever the NEXT screen had just rendered there, leaving
   * a blank view and a removeChild NotFoundError. With inbox defaulting on,
   * that is the first tab switch of a cold open. Owning the wrapper keeps the
   * root's teardown to exactly what the island rendered; `display: contents`
   * keeps the wrapper out of layout entirely. */
  const container = document.createElement('div')
  container.style.display = 'contents'
  host.appendChild(container)

  const root = createRoot(container)
  root.render(pick(mod))
  mounted = { root, host: container }
  return true
}

/** Idempotent; safe to call when nothing is mounted. Also cancels any
 *  in-flight mount — teardown means "this view is over", including a mount
 *  still waiting on its chunks. */
export async function unmountIsland () {
  mountSeq++
  await teardownMounted()
}

async function teardownMounted () {
  if (!mounted) return
  const { root, host } = mounted
  mounted = null
  // Unmount is deferred a tick: React warns if a root is torn down during the
  // render pass that is still mounting it.
  await Promise.resolve()
  root.unmount()
  // The private wrapper dies with its root, so a host that outlives a mount
  // never accumulates dead wrappers.
  host.remove()
}

/** Test/debug seam, mirroring window.__db and window.__rooms. */
export const __island = { get mounted () { return mounted } }
