/**
 * Spot Me — Groups REST client.
 *
 * Every route here is behind the server's JwtAuthGuard, so each call needs the
 * same short-lived access token the room socket uses. It is deliberately taken
 * from socket-transport rather than minted here: two auth paths would mean two
 * caches, two expiry clocks, and a group list that works while chat is broken.
 *
 * WHAT THE SERVER CAN AND CANNOT SEE
 * Roles, bans and mutes are enforced server-side, which needs no access to
 * message content. A PRIVATE group's room key never leaves the device — it
 * lives in the invite-URL fragment. A PUBLIC group hands its key to the server
 * so anyone can join by @username; that is a deliberate trade, and the only
 * case where the server can read a group's messages.
 */
import { API_BASE } from './api.js'
import { freshTokens } from './socket-transport.js'

/** Server error messages are user-facing here (`that username is taken`), so
 *  they are surfaced rather than swallowed behind a generic failure. */
async function call (path, { method = 'GET', body } = {}) {
  const { accessToken } = await freshTokens()
  const res = await fetch(`${API_BASE}/api/groups${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const message = data?.message ?? data?.error ?? `request failed (${res.status})`
    throw new Error(Array.isArray(message) ? message.join(', ') : String(message))
  }
  return data
}

const enc = encodeURIComponent

export const groupsApi = {
  create: (payload) => call('', { method: 'POST', body: payload }),
  listMine: () => call(''),
  getOne: (id) => call(`/${enc(id)}`),
  update: (id, patch) => call(`/${enc(id)}`, { method: 'PATCH', body: patch }),
  remove: (id) => call(`/${enc(id)}`, { method: 'DELETE' }),

  usernameAvailable: (username) => call(`/username/available?username=${enc(username)}`),
  findByUsername: (username) => call(`/by-username/${enc(username)}`),
  joinPublic: (username) => call(`/by-username/${enc(username)}/join`, { method: 'POST' }),

  addMember: (id, userId) => call(`/${enc(id)}/members`, { method: 'POST', body: { userId } }),
  removeMember: (id, userId) => call(`/${enc(id)}/members/${enc(userId)}`, { method: 'DELETE' }),
  leave: (id) => call(`/${enc(id)}/leave`, { method: 'POST' }),
  transfer: (id, userId) => call(`/${enc(id)}/transfer/${enc(userId)}`, { method: 'POST' }),

  setRole: (id, userId, role) =>
    call(`/${enc(id)}/members/${enc(userId)}/role`, { method: 'PATCH', body: { role } }),
  setGrants: (id, userId, grants) =>
    call(`/${enc(id)}/members/${enc(userId)}/grants`, { method: 'PATCH', body: grants }),
  setBan: (id, userId, banned) =>
    call(`/${enc(id)}/members/${enc(userId)}/ban`, { method: 'PATCH', body: { banned } }),
  /** minutes null unmutes. */
  setMute: (id, userId, minutes) =>
    call(`/${enc(id)}/members/${enc(userId)}/mute`, { method: 'PATCH', body: { minutes } })
}

/*
 * There was a `lookupUser(username)` here that matched only a COMPLETE handle
 * via /api/users/lookup. It is gone, not merely unused: it is what made adding
 * members impossible — typing "yuv" 404'd into a silent null while @yuva
 * existed — and leaving a second, worse way to find people is how the picker
 * came to use the wrong one. Prefix search now lives in `searchUsers()` in
 * lib/api.js, which needs no token and is covered by test/member-search.test.js.
 */

/* ------------------------------------------------------------ permissions */

/* Re-exported from a dependency-free module so the rules can be tested without
 * standing up a socket. Views import them from here either way. */
export { rank, outranks, may, ROLE_LABEL } from './group-perms.js'
