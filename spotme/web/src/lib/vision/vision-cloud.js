/**
 * Spot Me vision — the cloud-AI CLIENT port. DARK.
 *
 * Typed ops over POST /api/vision-ai: { ocr, recognize, translatePhoto,
 * assist, shopping }. Every one crosses the D1 boundary — a user image (or a
 * crop of it) leaves the device for a third-party provider — so the port
 * enforces the flag BEFORE any byte is serialized: with VISION_CLOUD_ENABLED
 * off (the shipped state) each op returns unavailable(CLOUD_DISABLED) with
 * ZERO egress, zero DNS, zero fetch. Flipping that flag is the owner's D1
 * decision (docs/priority-2/91-ENGINEERING-RISK-REGISTER.md D1); the server
 * carries its own independent env gate so a client bug can never outrun it.
 *
 * The server endpoint api/vision-ai.js is authored at activation time
 * (vision-activation.md) — this port is the empty adapter slot it fills.
 * Fully dependency-injected (fetch + auth-header provider come from the
 * caller); imports nothing outside lib/vision, so the fence stays clean and
 * the whole port tests offline against a fake fetch.
 *
 * Idiom note: this port RETURNS the vision availability vocabulary
 * (available/unavailable), it does not throw — the same object contract the
 * rest of lib/vision speaks, so a caller handles a dark cloud and a missing
 * detector with one code path.
 */

import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'

/** Byte caps mirror api/studio-ai.js — a base64 image data URL, bounded. */
const MAX_IMAGE_CHARS = 8_000_000
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/i
const OP_PATH = Object.freeze({
  ocr: 'ocr', recognize: 'recognize', translatePhoto: 'translate', assist: 'assist', shopping: 'shopping',
})

function checkImage (value) {
  if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'image must be a png|jpeg|webp base64 data URL')
  }
  if (value.length > MAX_IMAGE_CHARS) {
    return unavailable(VISION_UNAVAILABLE.INPUT_TOO_LARGE, `image exceeds the ${MAX_IMAGE_CHARS}-char cap — downscale first`)
  }
  return null
}

export function createVisionCloudClient ({ flags, fetchImpl = null, getAuthHeaders = null, base = '' } = {}) {
  if (!flags || typeof flags !== 'object') throw new TypeError('vision cloud: resolved flags required')

  /** The gate that keeps a dark build silent. Checked before any read of the
   *  payload, so a disabled client never even inspects the image bytes. */
  const gate = () => (flags.VISION_CLOUD_ENABLED === true
    ? null
    : unavailable(VISION_UNAVAILABLE.CLOUD_DISABLED,
      'VISION_CLOUD_ENABLED is off (owner D1 decision) — no image leaves this device'))

  async function call (op, body, { signal } = {}) {
    const doFetch = fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') return unavailable(VISION_UNAVAILABLE.FAILED, 'no fetch available')
    const headers = getAuthHeaders ? await getAuthHeaders() : { 'content-type': 'application/json' }
    let res
    try {
      res = await doFetch(`${base}/api/vision-ai?op=${OP_PATH[op]}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal,
      })
    } catch (e) {
      return unavailable(VISION_UNAVAILABLE.FAILED, `cloud request failed: ${e?.message || e}`)
    }
    let json = null
    try { json = await res.json() } catch { /* non-JSON error body */ }
    if (res.status === 501) return unavailable(VISION_UNAVAILABLE.CLOUD_DISABLED, 'server has not activated vision cloud AI (D1)')
    if (res.status === 429) return unavailable(VISION_UNAVAILABLE.BUDGET_EXCEEDED, json?.error || 'daily cloud budget reached')
    if (res.status === 400) return unavailable(VISION_UNAVAILABLE.BAD_INPUT, json?.error || 'bad request')
    if (!res.ok) return unavailable(VISION_UNAVAILABLE.FAILED, json?.error || `cloud AI failed (${res.status})`)
    return available({ ...json })
  }

  return {
    enabled: () => flags.VISION_CLOUD_ENABLED === true,

    /** Cloud OCR — one op of the endpoint, the tier above on-device tesseract. */
    async ocr ({ image } = {}, opts) {
      return gate() || checkImage(image) || call('ocr', { image }, opts)
    },

    /** Identify-what-you-see (plant/food/animal/landmark/product/coin). */
    async recognize ({ image, categories } = {}, opts) {
      const bad = gate() || checkImage(image)
      if (bad) return bad
      return call('recognize', { image, categories: Array.isArray(categories) ? categories.slice(0, 12) : undefined }, opts)
    },

    /** Photo translation: read + translate + return positioned overlay text. */
    async translatePhoto ({ image, to } = {}, opts) {
      const bad = gate() || checkImage(image)
      if (bad) return bad
      if (typeof to !== 'string' || !LANG_RE.test(to)) return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'bad target lang code')
      return call('translatePhoto', { image, to }, opts)
    },

    /** Solve/explain assistant. `category` carries the safety-layer routing;
     *  the server owns the refusal for the medical category. */
    async assist ({ image, category, prompt } = {}, opts) {
      const bad = gate() || checkImage(image)
      if (bad) return bad
      if (typeof category !== 'string' || !category) return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'category required')
      return call('assist', { image, category, prompt: prompt === undefined ? '' : String(prompt).slice(0, 400) }, opts)
    },

    /** Shopping / product search from a photo. */
    async shopping ({ image } = {}, opts) {
      return gate() || checkImage(image) || call('shopping', { image }, opts)
    },
  }
}
