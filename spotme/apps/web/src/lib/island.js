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
 * THE INVERSION (2026-08-08, after the functional sweep proved the surfaces
 * WORK, not merely mount): the slices in DEFAULT_ON ship React BY DEFAULT.
 * Setting the flag to the literal 'off' restores the legacy screen — the
 * rollback the migration plan promised, now pointing the other way. 'on'
 * still force-enables anything (including default-off slices).
 *
 * DELIBERATELY NOT IN DEFAULT_ON:
 *   chat    — proven working, but the owner flips it himself;
 *   moments — its React slice has NO composer (the sweep's one failure).
 *
 * A THROWING localStorage still reads as OFF for every slice: private-mode
 * storage cannot flip anyone INTO React, and the legacy screens remain the
 * failure mode of the storage layer — the safe direction is unchanged.
 */
const DEFAULT_ON = new Set([
  'profile', 'inbox', 'contacts', 'notifications', 'groups',
  'stories', 'discovery', 'verify', 'exchange',
])

export function uiFlag (slice) {
  try {
    const v = localStorage.getItem(`spotme.ui.${slice}`)
    if (v === 'on') return true
    if (v === 'off') return false
    return DEFAULT_ON.has(slice)
  } catch {
    return false
  }
}

let mounted = null

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
  const [{ createRoot }, mod] = await Promise.all([
    import('react-dom/client'),
    import('@spotme/ui')
  ])

  await unmountIsland()
  const root = createRoot(host)
  root.render(pick(mod))
  mounted = { root, host }
  return true
}

/** Idempotent; safe to call when nothing is mounted. */
export async function unmountIsland () {
  if (!mounted) return
  const { root } = mounted
  mounted = null
  // Unmount is deferred a tick: React warns if a root is torn down during the
  // render pass that is still mounting it.
  await Promise.resolve()
  root.unmount()
}

/** Test/debug seam, mirroring window.__db and window.__rooms. */
export const __island = { get mounted () { return mounted } }
