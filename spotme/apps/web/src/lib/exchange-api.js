/**
 * Spot Me — Exchange REST client + the ExchangeLivePort the React island mounts.
 *
 * THE FLAG IS THE SERVER'S, NOT OURS (same contract as moments-api.js): every
 * /api/v1/exchange route 404s while the `exchange` domain flag is off, so a
 * 404 here means "the surface does not exist", never a bug.
 *
 * FIELD HONESTY. The server's public projection is mapped 1:1 and NOTHING is
 * invented. Deliberately omitted because the API does not return them:
 *   - ownerName            (owner is a {kind,id} reference only)
 *   - any audience/contact count, media, distance-to-me
 * Contact requests have NO server route yet; the island renders the button
 * disabled with copy that says so — this module exposes no requestContact.
 *
 * PRIVACY: the device fix is coarsened to the server's 3-decimal grid HERE,
 * at the wire, before anything leaves. `cell` is never sent (server-derived).
 */

import { API_BASE } from './api.js'
import { freshTokens } from './socket-transport.js'

export class ExchangeDisabledError extends Error {
  constructor () { super('exchange is not available'); this.name = 'ExchangeDisabledError' }
}

const base = () => `${API_BASE}/api/v1/exchange`

async function call (path, { method = 'GET', body } = {}) {
  const { accessToken } = (await freshTokens()) || {}
  if (!accessToken) throw new Error('not signed in')
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (res.status === 404) throw new ExchangeDisabledError()
  let data = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) {
    const m = data?.message
    throw new Error(Array.isArray(m) ? m.join(' ') : m || `exchange ${res.status}`)
  }
  // The service returns typed failures inside a 200 envelope.
  if (data?.state === 'failed' && data?.error) {
    throw new Error(data.error.message || data.error.code || 'exchange request failed')
  }
  return data
}

/** Server public projection → the view the screens render. Omissions listed
 *  in the header are the whole difference; nothing else is reshaped. */
const toView = (p) => ({
  id: p.id,
  kind: p.kind,
  status: p.status,
  category: p.category,
  title: p.title,
  text: p.text,
  tags: p.tags || [],
  ...(p.budgetBand ? { budgetBand: p.budgetBand } : {}),
  ...(p.informationalPrice ? { informationalPrice: p.informationalPrice } : {}),
  approxLocation: p.approxLocation,
  radius: p.radius,
  availability: p.availability,
  visibility: p.visibility,
  createdAtIso: p.createdAtIso,
  expiresAtIso: p.expiresAtIso ?? null,
  version: p.version
})

const page = (r) => ({ results: (r?.results || []).map(toView), state: r?.state || 'failed' })

/** 3 decimals — the exact grid exchange.policy quantizes to server-side. */
const round3 = (n) => Math.round(Number(n) * 1000) / 1000

/** One coarse fix. Rejection or absence of geolocation is a typed refusal —
 *  posting needs an approximate area; browsing never calls this. */
function coarseFix () {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device does not report a location, and posting needs an approximate area.'))
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: round3(pos.coords.latitude), lon: round3(pos.coords.longitude) }),
      () => reject(new Error('Location permission is needed to place your post in an approximate area.')),
      { maximumAge: 600000, timeout: 15000 }
    )
  })
}

/** The port the island mounts. Shape: ExchangeLivePort in @spotme/ui. */
export function buildExchangePort () {
  return {
    browse: async ({ kind, category } = {}) => {
      const q = new URLSearchParams()
      if (kind) q.set('kind', kind)
      if (category) q.set('category', category)
      const qs = q.toString()
      return page(await call(`/browse${qs ? `?${qs}` : ''}`))
    },

    listMine: async () => page(await call('/intents/mine')),

    /* Publish = create draft + activate: a draft alone is invisible to
     * everyone else, so the composer's "Post intent" means both. */
    publish: async (draft) => {
      const origin = await coarseFix()
      const body = {
        kind: draft.kind,
        category: draft.category,
        title: draft.title,
        text: draft.text,
        tags: [],
        ...(draft.budgetBand ? { budgetBand: draft.budgetBand } : {}),
        availability: draft.scheduleLabel
          ? { state: 'recurring', scheduleLabel: draft.scheduleLabel }
          : { state: 'unknown' },
        origin,
        radiusKm: draft.radiusKm,
        visibility: draft.discoverable ? 'discoverable' : 'hidden',
        idempotencyKey: `web:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
      }
      const created = await call('/intents', { method: 'POST', body })
      const activated = await call(`/intents/${encodeURIComponent(created.id)}/activate`, {
        method: 'POST', body: { version: created.version.seq }
      })
      return toView(activated)
    },

    transition: async (id, version, to) => {
      const route = { active: 'resume', paused: 'pause', withdrawn: 'withdraw', fulfilled: 'fulfilled' }[to]
      return toView(await call(`/intents/${encodeURIComponent(id)}/${route}`, { method: 'POST', body: { version } }))
    }
  }
}
