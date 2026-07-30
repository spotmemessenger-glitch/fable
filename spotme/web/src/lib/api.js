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
export const API_BASE = (import.meta.env?.VITE_SPOTME_SERVER || '').replace(/\/$/, '')

/** Absolute URL for an /api path — accepts '/api/x' or 'api/x'. */
export const apiUrl = (path) => `${API_BASE}/${String(path).replace(/^\//, '')}`
