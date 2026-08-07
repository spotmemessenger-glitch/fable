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
  /* A 404 IS ONLY "THE DOMAIN IS DARK" UNTIL THE DOMAIN HAS ANSWERED.
   *
   * The gate 404s every route while Moments is off, so a 404 was read as
   * "moments is not available" everywhere. But an ordinary NotFoundException —
   * a missing asset, an id that is not yours — is also a 404, and once the
   * session has had a 200 from this domain the first reading is provably
   * wrong. It made a single broken route report the entire feature as switched
   * off, which is how a 404 on `/media/:id/edit` was reported as the product
   * being unavailable rather than as one call failing.
   *
   * So: before the domain has proved itself, a 404 still means dark. After it
   * has, a 404 means what it says. */
  if (res.status === 404) {
    if (availability === true) {
      const err = new Error('That is no longer there.')
      err.status = 404
      throw err
    }
    throw new MomentsDisabledError()
  }
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
  // COARSE ONLY. The server bands distance; a precise fix must never be sent.
  // We round at the wire here as the enforceable backstop — callers are asked
  // to coarsen too (coarseFix), but this boundary is what actually guarantees
  // no precise device fix ever leaves, exactly as createMoment already does.
  if (origin) { q.set('lat', String(round3(origin.lat))); q.set('lon', String(round3(origin.lon))) }
  if (cursor) q.set('cursor', cursor)
  if (order) q.set('order', order)
  return call(`/feed?${q}`)
}

/** A shared link pointed at a post that is gone, or that this account may not
 *  see. Distinct from MomentsDisabledError so the view can say "this post is
 *  no longer available" instead of "Posts is not switched on for you". */
export class MomentNotFoundError extends Error {
  constructor () { super('post unavailable'); this.name = 'MomentNotFoundError' }
}

/**
 * One post by id — what a `#/posts?m=<id>` share link opens.
 *
 * The 404 is ambiguous on the wire: the domain gate 404s when Moments is off
 * for this account, and the route 404s when the post is missing or not
 * viewable. `call()` maps every 404 to MomentsDisabledError, which would tell
 * a perfectly enabled user their Posts feature is switched off. So when the
 * availability probe says the domain IS on, re-label it as what it actually
 * is: that post, not that feature.
 */
export const momentById = async (id) => {
  try {
    return await call(`/${encodeURIComponent(id)}`)
  } catch (e) {
    if (e instanceof MomentsDisabledError) {
      let on = false
      try { on = await momentsAvailable() } catch { on = false }
      if (on) throw new MomentNotFoundError()
    }
    throw e
  }
}

export const storiesRail = () => call('/stories/rail')
export const comments = (momentId) => call(`/${encodeURIComponent(momentId)}/comments`)

/**
 * MEDIA URLS ARE RESOLVED AGAINST THE API ORIGIN, NOT THE PAGE.
 *
 * The local storage adapter hands back a PATH — `/api/v2/media/local?key=…` —
 * and the S3 adapter hands back an absolute presigned URL. The client used to
 * assign whichever it got straight to `img.src`/`video.src`, which is correct
 * only when the app and the API share an origin.
 *
 * They do not. The app is static on Vercel and the API is on Railway, and
 * `vercel.json` carries no `/api` rewrite — so a path-relative media URL
 * resolved against the STATIC host, which serves no media. Every photo, every
 * video and every story rendered empty, and nothing failed loudly: the SPA host
 * answers those paths with `index.html`, so the request "succeeded" and only
 * the decode failed.
 *
 * It never showed in development because the Vite dev server proxies `/api` to
 * the backend, making the relative URL correct there and only there.
 *
 * Absolutising HERE — at the one boundary every asset crosses — fixes it for
 * both storage adapters at once and cannot be forgotten by a future caller.
 * An already-absolute URL is returned untouched.
 */
const absolutise = (u) => {
  if (!u || typeof u !== 'string') return u || null
  if (/^(?:https?:|blob:|data:)/i.test(u)) return u
  if (!API_BASE) return u                       // same-origin: already correct
  return `${API_BASE}${u.startsWith('/') ? '' : '/'}${u}`
}

export const assetUrl = async (mediaId) => {
  const r = await call(`/media/${encodeURIComponent(mediaId)}/url`)
  if (!r) return r
  return { ...r, url: absolutise(r.url), posterUrl: absolutise(r.posterUrl) }
}

/**
 * Record the composer's trim / cover choices for a video and re-run the
 * transcode. The cut happens on the SERVER — see the route's own note: doing
 * it here would mean re-encoding on the phone, which is slow on mid-range
 * Android, lossy, and dependent on which codecs the browser exposes.
 *
 * Milliseconds throughout, because that is what a <video> currentTime gives
 * once you multiply, and rounding to seconds would visibly move a chosen frame.
 */
export const editMedia = (mediaId, { trimStartMs, trimEndMs, coverAtMs } = {}) =>
  call(`/media/${encodeURIComponent(mediaId)}/edit`, {
    method: 'POST',
    body: {
      ...(trimStartMs != null ? { trimStartMs: Math.round(trimStartMs) } : {}),
      ...(trimEndMs != null ? { trimEndMs: Math.round(trimEndMs) } : {}),
      ...(coverAtMs != null ? { coverAtMs: Math.round(coverAtMs) } : {})
    }
  })

/* ----------------------------------------------------------------- write */

/**
 * Upload one photo/video. The bytes go THROUGH the server on purpose: it
 * strips EXIF/GPS before anything is stored, which a presigned direct upload
 * to the bucket could not do (the original would already be in the bucket).
 */
export async function uploadMedia (file, { onProgress, signal } = {}) {
  const report = typeof onProgress === 'function' ? onProgress : () => {}
  const headers = await authHeaders({ 'Content-Type': file.type || 'application/octet-stream' })
  report(0)
  /* XHR, NOT fetch, and deliberately so.
   *
   * `fetch` cannot report UPLOAD progress — the promise settles when the
   * response arrives and says nothing in between. For a 50 MB video on a phone
   * that is a minute or more of a composer that reads as hung, with no way to
   * tell a slow upload from a dead one and no way out of either. It also could
   * not be aborted, so a stalled connection left "Uploading…" on screen for the
   * life of the page.
   *
   * The body is the File itself rather than an ArrayBuffer: `file.arrayBuffer()`
   * pulls the whole clip into JS memory, on the same phone that is decoding the
   * same file for the trim filmstrip. XHR streams the File from disk. */
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${base()}/media`)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.responseType = 'text'

    /* A STALL TIMEOUT, NOT A TOTAL ONE. A big video on a slow connection is
     * legitimately slow, so a wall-clock deadline would kill uploads that were
     * working. What is never legitimate is no bytes moving at all: this fires
     * only after 30 s of silence, and every progress event pushes it back. */
    let stall = null
    const alive = () => {
      clearTimeout(stall)
      stall = setTimeout(() => { done = true; xhr.abort(); reject(new Error('The upload stalled. Check your connection and try again.')) }, 30000)
    }
    let done = false
    const finish = (fn) => (...a) => { if (done) return; done = true; clearTimeout(stall); off(); fn(...a) }

    const onAbort = () => { done = true; clearTimeout(stall); off(); xhr.abort(); reject(new Error('canceled')) }
    const off = () => signal?.removeEventListener?.('abort', onAbort)
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    xhr.upload.addEventListener('progress', (e) => {
      alive()
      // `lengthComputable` is false for a chunked body; report nothing rather
      // than a fabricated number, and let the caller show an indeterminate bar.
      if (e.lengthComputable && e.total > 0) report(Math.min(0.99, e.loaded / e.total))
    })
    xhr.upload.addEventListener('loadend', alive)      // bytes are up; the server is now working

    xhr.addEventListener('error', finish(() => reject(new Error('Upload failed — the network dropped.'))))
    xhr.addEventListener('abort', finish(() => reject(new Error('canceled'))))
    xhr.addEventListener('load', finish(() => {
      const s = xhr.status
      // Same status semantics as call(): a 404 means the domain is dark, a 403
      // means this account may not post. Divergence here is how an upload
      // reported "failed" for a surface that was merely switched off.
      // Same reading as call(): dark domain only until the domain has answered.
      if (s === 404) {
        if (availability !== true) return reject(new MomentsDisabledError())
        const e404 = new Error('That is no longer there.')
        e404.status = 404
        return reject(e404)
      }
      let detail = null
      try { detail = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { /* non-JSON */ }
      if (s === 403) {
        const m = detail?.message
        return reject(new MomentsForbiddenError(Array.isArray(m) ? m.join(' ') : m))
      }
      if (s < 200 || s >= 300) {
        const err = new Error(detail?.reason || detail?.error || `moments ${s}`)
        err.status = s
        return reject(err)
      }
      report(1)
      resolve(detail)   // { mediaId, deduplicated, exifStripped }
    }))

    alive()
    xhr.send(file)
  })
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
