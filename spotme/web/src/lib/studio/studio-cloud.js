/**
 * Spot Me — Creative Studio cloud-AI CLIENT adapter. DARK.
 *
 * Typed ops over /api/studio-ai: { inpaint, styleTransfer, stickerFromPhoto,
 * captionSuggest }. Every one of them is a D1-boundary crossing — the user's
 * image plaintext goes to a third-party provider — so the adapter enforces
 * the flag BEFORE any byte is serialized: with STUDIO_CLOUD_AI_ENABLED off
 * (the shipped state) a call rejects locally with zero egress, zero DNS,
 * zero anything. The server enforces its own independent gate (env flag ⇒
 * 501) so a client bug can never outrun the owner's decision.
 *
 * Fully dependency-injected: fetch and auth-header provider come from the
 * caller (index.js wires the app's real lib/auth-headers.js at integration
 * time). This module imports nothing outside lib/studio — the fence stays
 * bidirectionally clean and the whole adapter tests offline.
 */

const MAX_IMAGE_CHARS = 8_000_000
const MAX_MASK_CHARS = 2_000_000
const MAX_DIM = 4096
const OPS = Object.freeze({
  inpaint: 'inpaint',
  styleTransfer: 'style',
  stickerFromPhoto: 'sticker',
  captionSuggest: 'caption'
})

export function createCloudClient ({ flags, fetchImpl, getAuthHeaders, base = '' } = {}) {
  if (!flags || typeof flags !== 'object') throw new TypeError('cloud client: resolved flags required')

  function assertEnabled () {
    if (flags.STUDIO_CLOUD_AI_ENABLED !== true) {
      throw new Error(
        'studio cloud AI is disabled: STUDIO_CLOUD_AI_ENABLED is off (and remains off until the owner ratifies the D1 provider-plaintext boundary) — no image data leaves this device')
    }
  }

  function checkDataURL (value, field, cap) {
    if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) {
      throw new TypeError(`${field} must be an image data URL`)
    }
    if (value.length > cap) throw new RangeError(`${field} exceeds the ${cap}-char cap — downscale before the cloud leg`)
    return value
  }

  function checkDims (w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > MAX_DIM || h > MAX_DIM) {
      throw new RangeError(`dimensions must be 16..${MAX_DIM}`)
    }
  }

  async function call (op, body, { signal } = {}) {
    assertEnabled()
    const doFetch = fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') throw new Error('cloud client: no fetch available')
    const headers = getAuthHeaders ? await getAuthHeaders() : { 'content-type': 'application/json' }
    const res = await doFetch(`${base}/api/studio-ai?op=${OPS[op]}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    })
    let json = null
    try { json = await res.json() } catch { /* non-JSON error body */ }
    if (res.status === 501) {
      throw new Error('cloud AI is not enabled on the server — the owner has not activated this deployment (D1)')
    }
    if (res.status === 401) throw new Error('sign in required for cloud AI')
    if (res.status === 429) throw new Error(json?.error || 'cloud AI budget reached — try later')
    if (!res.ok) throw new Error(json?.error || `cloud AI failed (${res.status})`)
    return json
  }

  return {
    enabled: () => flags.STUDIO_CLOUD_AI_ENABLED === true,

    /** Large/semantic removal — the tier above the local Telea fill. */
    async inpaint ({ image, mask, prompt, w, h }, opts) {
      assertEnabled()
      checkDims(w, h)
      return call('inpaint', {
        image: checkDataURL(image, 'image', MAX_IMAGE_CHARS),
        mask: checkDataURL(mask, 'mask', MAX_MASK_CHARS),
        prompt: prompt === undefined ? '' : String(prompt).slice(0, 400),
        w,
        h
      }, opts)
    },

    /** Neural style transfer — the thing local looks honestly are not. */
    async styleTransfer ({ image, styleId, w, h }, opts) {
      assertEnabled()
      checkDims(w, h)
      if (typeof styleId !== 'string' || !styleId) throw new TypeError('styleId required')
      return call('styleTransfer', { image: checkDataURL(image, 'image', MAX_IMAGE_CHARS), styleId, w, h }, opts)
    },

    /** Subject cutout → transparent die-cut sticker. */
    async stickerFromPhoto ({ image, w, h }, opts) {
      assertEnabled()
      checkDims(w, h)
      return call('stickerFromPhoto', { image: checkDataURL(image, 'image', MAX_IMAGE_CHARS), w, h }, opts)
    },

    /** Caption ideas for a photo, in the user's language. */
    async captionSuggest ({ image, lang, w, h }, opts) {
      assertEnabled()
      checkDims(w, h)
      const code = lang === undefined ? 'en' : String(lang)
      if (!/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/i.test(code)) throw new RangeError('bad lang code')
      return call('captionSuggest', { image: checkDataURL(image, 'image', MAX_IMAGE_CHARS), lang: code, w, h }, opts)
    }
  }
}
