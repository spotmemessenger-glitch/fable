/**
 * Spot Me — Creative Studio feature flags. EVERYTHING SHIPS DARK.
 *
 * This module is the single source of truth for what the studio is allowed to
 * do. Every constant below is `false` and stays `false` in the repository:
 * the studio ships as dead code that the bundler tree-shakes away (nothing
 * outside lib/studio/ imports it — studio-fence.test.js holds that line), and
 * turning anything on is an explicit owner decision recorded in
 * docs/ai-camera/studio-activation.md, never a code default.
 *
 * LAYERING. Flags form a tree: children are meaningless without their parent.
 * `resolveFlags()` computes the EFFECTIVE value — a child is on only when its
 * whole parent chain is on — so a stray `STUDIO_LOOKS_ENABLED: true` with the
 * master off still resolves to off. That is what makes "master off ⇒ studio
 * inert" a property of the flag algebra rather than of every call site
 * remembering to check two flags.
 *
 * PLATFORM MASTER (documented dependency, not an import). The AI Camera
 * platform master flag `AI_CAMERA_ENABLED` is owned by the camera-engine
 * mission (CAM-1) and does not exist on the branch this module is built from,
 * so it CANNOT be imported here. At wiring time the integrator must add
 *
 *     CREATIVE_STUDIO_ENABLED → AI_CAMERA_ENABLED
 *
 * to the platform's parent map (or AND the two masters at the call site that
 * constructs the studio). Until that wiring lands, CREATIVE_STUDIO_ENABLED is
 * the root of this module's own tree and is false anyway.
 *
 * OWNER GATES BEYOND THE CODE. `STUDIO_CLOUD_AI_ENABLED` parents every
 * provider leg (client adapter + /api/studio-ai). Flipping it is NOT enough to
 * ship cloud AI: it is additionally gated on the owner's D1 decision (image
 * plaintext may cross to a provider — default OFF, see
 * docs/ai-camera/studio-threat-model.md) and on the server env flag
 * `STUDIO_AI_ENABLED`, which is absent in production until D1 is ratified.
 * Three independent switches, all currently off.
 */

export const DEFAULT_FLAGS = Object.freeze({
  /** Module master. Off ⇒ createStudio() is inert: no canvas, no DB, no timers. */
  CREATIVE_STUDIO_ENABLED: false,

  /** Non-destructive editor (op-graph, adjustments, geometry). */
  STUDIO_EDITOR_ENABLED: false,
  /** Local mask-brush + small-region inpainting; large/semantic removal is a cloud leg. */
  STUDIO_OBJECT_REMOVAL_ENABLED: false,
  /** Manual mask / chroma-key background replacement (+ ISegmenter adapter slot). */
  STUDIO_BG_REPLACE_ENABLED: false,
  /** Heuristic sky mask + procedural sky + sky-tint relight. */
  STUDIO_SKY_ENABLED: false,
  /** Directional key-light relight (2D luma tier; depth tier deferred). */
  STUDIO_RELIGHT_ENABLED: false,
  /** Procedural 3D-LUT looks. Honestly named looks — NOT "AI style transfer". */
  STUDIO_LOOKS_ENABLED: false,
  /** Stories/reels timeline composition and video render. */
  STUDIO_COMPOSER_ENABLED: false,
  /** Collage layout engine. */
  STUDIO_COLLAGE_ENABLED: false,
  /** Data-driven templates (op-doc + composer presets). */
  STUDIO_TEMPLATES_ENABLED: false,
  /** IndexedDB draft persistence ('spotme-studio-drafts'; joins wipeDevice). */
  STUDIO_DRAFTS_ENABLED: false,
  /**
   * Parents ALL provider legs (inpaint/styleTransfer/stickerFromPhoto/
   * captionSuggest). Additionally owner-D1-gated and server-env-gated — see
   * the header. Image bytes NEVER leave the device while this is false.
   */
  STUDIO_CLOUD_AI_ENABLED: false
})

/** Child → parent. Every studio child hangs off the module master. */
export const FLAG_PARENT = Object.freeze({
  STUDIO_EDITOR_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_OBJECT_REMOVAL_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_BG_REPLACE_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_SKY_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_RELIGHT_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_LOOKS_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_COMPOSER_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_COLLAGE_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_TEMPLATES_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_DRAFTS_ENABLED: 'CREATIVE_STUDIO_ENABLED',
  STUDIO_CLOUD_AI_ENABLED: 'CREATIVE_STUDIO_ENABLED'
})

/**
 * Effective flags from defaults + overrides.
 *
 * Strict at the boundary (CLAUDE.md: validate input at system boundaries):
 * an unknown flag name or a non-boolean value throws rather than being
 * silently dropped, because a typo in a flag override is precisely how a
 * feature meant to stay dark goes live — or how one meant to go live silently
 * does not, which then gets "fixed" by force.
 *
 * The effective value of a flag is its raw value AND every ancestor's — a
 * child can never outrank its parent.
 */
export function resolveFlags (overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('flag overrides must be a plain object')
  }
  const raw = { ...DEFAULT_FLAGS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_FLAGS)) throw new RangeError(`unknown studio flag: ${key}`)
    if (typeof value !== 'boolean') throw new TypeError(`studio flag ${key} must be boolean`)
    raw[key] = value
  }
  const effective = {}
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    let on = raw[key]
    let cursor = key
    // Walk the parent chain; any off ancestor turns the child off. The chain
    // is a tree by construction (one parent per child, root has none), so
    // this terminates without cycle bookkeeping.
    while (on && FLAG_PARENT[cursor]) {
      cursor = FLAG_PARENT[cursor]
      on = on && raw[cursor]
    }
    effective[key] = on
  }
  return Object.freeze(effective)
}

/**
 * The shipped-dark invariant, as an executable assertion.
 *
 * Called by the test suite against DEFAULT_FLAGS on every run: if any default
 * ever flips to true, the suite fails before a reviewer has to notice it in a
 * diff. Also callable at runtime against a resolved set when a caller needs
 * to prove a context is fully dark (e.g. the fence test's inert-studio check).
 */
export function assertShippedDark (flags = DEFAULT_FLAGS) {
  const lit = Object.entries(flags).filter(([, v]) => v === true).map(([k]) => k)
  if (lit.length > 0) {
    throw new Error(`studio must ship dark, but these flags are on: ${lit.join(', ')}`)
  }
  return true
}
