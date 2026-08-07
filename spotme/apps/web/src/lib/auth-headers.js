/**
 * Spot Me — the Authorization header for our own vendor proxies.
 *
 * `/api/translate` and `/api/voice` both proxy paid vendors and both now
 * require the same short-lived access token the room socket and the groups API
 * carry. This lives in its own module rather than in api.js because
 * socket-transport imports api.js, and putting it there would close the cycle.
 *
 * THE TIMEOUT IS THE POINT. `freshTokens()` busy-waits for onboarding to
 * produce a profile and will wait forever if none arrives
 * (socket-transport.js:163-166), and the AbortController at each call site only
 * covers the fetch — so without this race a pre-onboarding call hangs instead of
 * failing. Going out unauthenticated earns a clean 401, which every caller
 * treats as "try the next engine" or a readable error.
 */
import { freshTokens } from './socket-transport.js'

const TOKEN_WAIT_MS = 4000

export async function authHeaders () {
  const headers = { 'content-type': 'application/json' }
  try {
    const { accessToken } = await Promise.race([
      freshTokens(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no token yet')), TOKEN_WAIT_MS))
    ])
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
  } catch { /* unauthenticated attempt; the caller handles the 401 */ }
  return headers
}
