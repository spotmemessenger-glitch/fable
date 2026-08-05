/**
 * Spot Me — Discovery v2 REST client (Wave 1C, C3).
 *
 * The web surface's data path to the new server Discovery engine
 * (/api/v2/discovery), replacing the legacy P2P-lobby source for the map view.
 * Every route is behind the server's JwtAuthGuard AND
 * DomainGate('discovery', { requireAdult: true }), so:
 *
 *  - 404  → Discovery is not enabled for this account (the dark/allowlist state,
 *           or the domain flag is off). The surface treats it EXACTLY like the
 *           feature not existing — no error toast, no "coming soon" that leaks
 *           the roadmap; the caller renders its ordinary empty/hidden state.
 *  - 403 age_requirement → an unverified or frozen account. Surfaced as the
 *           policy notice, never as a generic failure.
 *
 * PRIVACY (P3): only the COARSE public contract crosses this boundary. The
 * client sends a coarse origin for a query and NEVER a precise fix; the server
 * coarsens again server-side regardless. Responses carry `distanceBand`
 * (under500m / …), never a precise distance or coordinate — see the server
 * projection and the C4 privacy fences.
 */
import { API_BASE } from './api.js'
import { freshTokens } from './socket-transport.js'

export class DiscoveryDisabledError extends Error {} // 404 — treat as "not here"
export class AgePolicyError extends Error {} // 403 age_requirement / account_frozen

async function call (path, { method = 'GET', body } = {}) {
  const { accessToken } = (await freshTokens()) || {}
  const res = await fetch(`${API_BASE}/api/v2/discovery${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 404) throw new DiscoveryDisabledError('discovery not enabled')
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  if (res.status === 403 && (data?.error === 'age_requirement' || data?.error === 'account_frozen')) {
    throw new AgePolicyError(data?.message || 'age policy')
  }
  if (!res.ok) {
    const message = data?.message ?? data?.error ?? `request failed (${res.status})`
    throw new Error(Array.isArray(message) ? message.join(', ') : String(message))
  }
  return data
}

export const discoveryApi = {
  /** Nearby-people query. `origin` MUST already be coarse (grid cell); the
   *  server re-coarsens and refuses a precise-shaped origin. */
  query: (origin, { radiusKm = 1, scope = 'people' } = {}) =>
    call('/query', { method: 'POST', body: { origin, radius: { km: radiusKm }, scope } }),

  /** Read my visibility preference (enabled + coarse cell + ghost). */
  getVisibility: () => call('/visibility'),

  /** Set my visibility. `enabled:false` OR `ghost:true` removes me from results.
   *  Location is coarsened server-side; never send a precise fix. */
  setVisibility: (pref) => call('/visibility', { method: 'PUT', body: pref }),

  /** Ghost mode: opt out of appearing in anyone's results without losing my
   *  own map. Implemented as a visibility flag so one server-side switch governs
   *  both the read and the projection. */
  setGhost: (ghost) => call('/visibility', { method: 'PUT', body: { ghost: !!ghost } })
}
