/**
 * Spot Me — where the API lives.
 *
 * One value, imported by every module that calls /api/*, because the parts have
 * to agree. The username registry, guest identity and the room gateway are all
 * the same server now: point the registry at one host and the rooms at another
 * and you get a split brain — names claimed in one place, conversations keyed to
 * ids from the other, and a search that finds people you cannot reach.
 *
 * Empty string means same-origin, which is what the dev server (Vite proxies
 * /api and /socket.io) and a single-host deployment both want. A hosted build
 * where the static app and the API are on different hosts sets
 * VITE_SPOTME_SERVER at build time.
 */
/* The deployed backend, as recorded in DEPLOY.md. This is a FALLBACK, not the
 * configuration: VITE_SPOTME_SERVER still wins whenever it is set.
 *
 * It exists because the failure without it is invisible and total. The static
 * app is on Vercel and the API is on Railway, so an unset variable left
 * API_BASE as '' — every /api call and `io('/rooms')` then pointed at the
 * static host, which runs no server. The app loaded, onboarding worked, and
 * every conversation sat forever unable to connect. The build exited 0 and said
 * nothing, and a git-connected Vercel build (which sets no variables of its
 * own) produced exactly that.
 *
 * Same-origin is still the right answer for the dev server, which proxies /api
 * and /socket.io — hence the localhost check rather than a blanket default. */
const HOSTED_API = 'https://api-production-0a4ca.up.railway.app'
const sameOriginServes = typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || /^[\d.:[\]]+$/.test(location.hostname))

export const API_BASE = (
  import.meta.env?.VITE_SPOTME_SERVER || (sameOriginServes ? '' : HOSTED_API)
).replace(/\/$/, '')

/** Absolute URL for an /api path — accepts '/api/x' or 'api/x'. */
export const apiUrl = (path) => `${API_BASE}/${String(path).replace(/^\//, '')}`

/** What the server's prefix endpoint accepts: 1-16 handle characters. Matching
 *  PREFIX_RE in backend/src/auth/username.controller.ts, so a query this file
 *  lets through is never one the server then rejects as invalid. */
const HANDLE_PREFIX = /^[a-z0-9_]{1,16}$/

/**
 * Find people by the START of their @username.
 *
 * WHY THIS EXISTS RATHER THAN AN EXACT LOOKUP. The member picker used to
 * resolve strangers through `/api/users/lookup?username=`, which matches only a
 * complete handle, and it declined to query at all below three characters. With
 * @yuva registered, typing "yu" sent no request and typing "yuv" 404'd into a
 * silent null — the picker reported "Nobody is registered as @yuv" while the
 * account sat one character away. Since the creation wizard will not advance
 * until two members are picked, that did not merely degrade group creation, it
 * blocked it. The server has answered prefix queries all along and the inbox
 * search already used them; only the picker was asking the wrong way.
 *
 * Deliberately UNAUTHENTICATED, like the endpoint it calls — it lives in this
 * dependency-free module rather than groups-api.js precisely so it needs no
 * token, no socket, and no `window`, which is also what makes it testable.
 *
 * Returns [] for every failure. This runs on each keystroke, so a dead registry
 * or an offline phone must read as "no matches yet", never as a thrown error
 * mid-typing. Callers that need to distinguish those cases should not use this.
 */
export async function searchUsers (query, { excludeId = null, signal } = {}) {
  const q = String(query ?? '').trim().toLowerCase().replace(/^@+/, '')
  if (!HANDLE_PREFIX.test(q)) return []
  try {
    const res = await fetch(`${API_BASE}/api/username?q=${encodeURIComponent(q)}`, { signal })
    if (!res.ok) return []
    const data = await res.json()
    const rows = Array.isArray(data?.results) ? data.results : []
    return rows.filter((u) => u?.username && u.id && u.id !== excludeId)
  } catch {
    return []
  }
}
