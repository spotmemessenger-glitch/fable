/**
 * Media classes and their trust TIER.
 *
 * Owner decisions ratified for this mission:
 *   - Private conversational media is E2E by default.
 *   - Explicitly public media may use a separately labelled server-visible tier.
 *
 * The tier is the single most load-bearing property in the media platform: it
 * decides whether bytes are opaque ciphertext the server may never inspect
 * ('e2e') or plaintext the server legitimately processes ('public', where
 * Sharp/FFmpeg/malware pipelines live). These are TYPE contracts only — no
 * behaviour, no crypto, no I/O ships in this package.
 *
 * NOTE — the default tier for a few classes (profile image, story, nearby
 * post) can be product-configured; the map below is the safe DEFAULT and is an
 * owner-configurable decision at wiring time, never inferred at runtime here.
 */

/** Every media class the product scope names. */
export type MediaClass =
  // conversational (E2E by default)
  | 'chat-photo'
  | 'chat-video'
  | 'chat-file'
  | 'voice-note'
  | 'contact-card'
  | 'location'
  // social / broadcast (server-visible by default)
  | 'story'
  | 'reel'
  | 'profile-image'
  | 'nearby-post'
  | 'channel-media'

/** Trust tier: 'e2e' = opaque ciphertext, zero-knowledge server; 'public' =
 *  server-visible plaintext (thumbnail/transcode/scan pipelines allowed). */
export type MediaTier = 'e2e' | 'public'

/** The DEFAULT tier per class (owner-configurable at wiring; not inferred). */
export const DEFAULT_MEDIA_TIER: Readonly<Record<MediaClass, MediaTier>> = Object.freeze({
  'chat-photo': 'e2e',
  'chat-video': 'e2e',
  'chat-file': 'e2e',
  'voice-note': 'e2e',
  'contact-card': 'e2e',
  location: 'e2e',
  story: 'public',
  reel: 'public',
  'profile-image': 'public',
  'nearby-post': 'public',
  'channel-media': 'public',
})

/** All known classes, frozen — the closed set a validator/UI can enumerate. */
export const MEDIA_CLASSES: readonly MediaClass[] = Object.freeze(
  Object.keys(DEFAULT_MEDIA_TIER) as MediaClass[],
)

export function isMediaClass(value: string): value is MediaClass {
  return Object.prototype.hasOwnProperty.call(DEFAULT_MEDIA_TIER, value)
}

/** The default tier for a class. Wiring code may override per product policy. */
export function defaultTierOf(mediaClass: MediaClass): MediaTier {
  return DEFAULT_MEDIA_TIER[mediaClass]
}
