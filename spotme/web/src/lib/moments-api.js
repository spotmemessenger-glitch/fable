/**
 * Spot Me — Moments (Posts/Stories/Reels) REST client.
 *
 * THE FLAG IS THE SERVER'S, NOT OURS. Every route 404s while the `moments`
 * domain is dark, so this module never carries a local "is it on" switch that
 * could disagree with the backend. `momentsAvailable()` asks once and caches
 * the answer for the session; a 404 anywhere else throws MomentsDisabledError,
 * which the view treats as "this surface does not exist" rather than as a bug.
 * That way the client cannot enable something the server refuses to serve, and
 * a rollback (flag row deleted) simply stops answering.
 *
 * The 403 case is separate and must NOT be confused with 404: it means the
 * account is not a verified adult, or is frozen (D6 + the freeze addendum).
 * The surface exists; this person may not use it.
 */

import { API_BASE } from './api.js'
import { freshTokens } from './socket-transport.js'

export class MomentsDisabledError extends Error {
  constructor () { super('moments is not available'); this.name = 'MomentsDisabledError' }
}
export class MomentsForbiddenError extends Error {
  constructor (msg) { super(msg || 'not permitted'); this.name = 'MomentsForbiddenError' }
}

const base = () => `${API_BASE}/api/v1/moments`

async function authHeaders (extra) {
  const { accessToken } = (await freshTokens()) || {}
  if (!accessToken) throw new Error('not signed in')
  return { Authorization: `Bearer ${accessToken}`, ...(extra || {}) }
}

async function call (path, { method = 'GET', body, raw, contentType } = {}) {
  const headers = await authHeaders(
    raw ? { 'Content-Type': contentType } : body ? { 'Content-Type': 'application/json' } : undefined
  )
  const res = await fetch(`${base()}${path}`, {
    method,
    headers,
    body: raw || (body ? JSON.stringify(body) : undefined)
  })
  if (res.status === 404) throw new MomentsDisabledError()
  if (res.status === 403) {
    let msg = null
    try { msg = (await res.clone().json())?.message } catch { /* non-JSON */ }
    throw new MomentsForbiddenError(Array.isArray(msg) ? msg.join(' ') : msg)
  }
  if (!res.ok) {
    let detail = null
    try { detail = await res.clone().json() } catch { /* non-JSON */ }
    const err = new Error(detail?.reason || detail?.error || `moments ${res.status}`)
    err.status = res.status
    throw err
  }
  // 204s and empty bodies are legitimate (delete, unreact).
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/* ---------------------------------------------------------------- gating */

let availability = null
/** Is Moments served to THIS account? Cached per session; never assumed. */
export async function momentsAvailable () {
  if (availability !== null) return availability
  try {
    await call('/feed?mode=friends')
    availability = true
  } catch (e) {
    // Forbidden means the surface EXISTS — cache true. A 404 (disabled) is a
    // real, cacheable "off". Anything else (network, 5xx) is TRANSIENT: do not
    // poison the whole session — leave availability null so the next check
    // re-asks. Previously any transient failure hid the tab until reload.
    if (e instanceof MomentsForbiddenError) { availability = true } else if (e instanceof MomentsDisabledError) { availability = false } else { availability = null; return false }
  }
  return availability
}
/** Forget the cached answer — used after sign-in changes the account. */
export function resetMomentsAvailability () { availability = null }

/* ------------------------------------------------------------------ read */

export const feed = ({ mode = 'friends', origin = null, cursor = null, order } = {}) => {
  const q = new URLSearchParams({ mode })
  // COARSE ONLY. The server bands distance; a precise fix must never be sent,
  // and the caller is expected to have coarsened already (see discovery.js).
  if (origin) { q.set('lat', String(origin.lat)); q.set('lon', String(origin.lon)) }
  if (cursor) q.set('cursor', cursor)
  if (order) q.set('order', order)
  return call(`/feed?${q}`)
}

export const storiesRail = () => call('/stories/rail')
export const comments = (momentId) => call(`/${encodeURIComponent(momentId)}/comments`)
export const assetUrl = (mediaId) => call(`/media/${encodeURIComponent(mediaId)}/url`)

/* ----------------------------------------------------------------- write */

/**
 * Upload one photo/video. The bytes go THROUGH the server on purpose: it
 * strips EXIF/GPS before anything is stored, which a presigned direct upload
 * to the bucket could not do (the original would already be in the bucket).
 */
export async function uploadMedia (file, { onProgress } = {}) {
  const buf = await file.arrayBuffer()
  if (typeof onProgress === 'function') onProgress(0)
  const out = await call('/media', {
    method: 'POST', raw: buf, contentType: file.type || 'application/octet-stream'
  })
  if (typeof onProgress === 'function') onProgress(1)
  return out    // { mediaId, deduplicated, exifStripped }
}

/**
 * Post. `location` is the server's allow-listed key (NOT `origin`), and it is
 * accepted only on nearby/public posts and only in the COARSE shape: a
 * 4-decimal value, or any GeolocationCoordinates field like `accuracy`, is
 * refused outright rather than rounded — the refusal is the feature. The
 * stored cell is always server-derived, so we never send one.
 */
export const createMoment = ({ kind, text, mediaIds, visibility, location }) =>
  call('', {
    method: 'POST',
    body: {
      kind,
      ...(text ? { text } : {}),
      mediaIds: mediaIds || [],
      visibility,
      ...(location ? { location: { lat: round3(location.lat), lon: round3(location.lon) } } : {})
    }
  })

/** 3 decimals ≈ 110 m — the coarse grid the server will accept. */
const round3 = (n) => Math.round(Number(n) * 1000) / 1000

export const deleteMoment = (id, version) =>
  call(`/${encodeURIComponent(id)}?version=${Number(version) || 0}`, { method: 'DELETE' })

export const addComment = (id, text, parentId) =>
  call(`/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { text, ...(parentId ? { parentId } : {}) } })

export const react = (id, reaction) =>
  call(`/${encodeURIComponent(id)}/reactions`, { method: 'POST', body: { reaction } })

export const unreact = (id) =>
  call(`/${encodeURIComponent(id)}/reactions`, { method: 'DELETE' })

export const follow = (targetId) => call(`/follow/${encodeURIComponent(targetId)}`, { method: 'POST' })
export const block = (blockedId) => call(`/block/${encodeURIComponent(blockedId)}`, { method: 'POST' })

export const createStory = ({ mediaId, visibility = 'friends' }) =>
  call('/stories', { method: 'POST', body: { mediaId, visibility } })

export const report = ({ targetKind, targetId, reason, note }) =>
  call('/reports', { method: 'POST', body: { targetKind, targetId, reason, ...(note ? { note } : {}) } })
