/**
 * Spot Me — TURN credential minting.
 *
 * Two phones on mobile data usually cannot reach each other directly: Indian
 * carriers put subscribers behind shared addresses (CGNAT), so WebRTC needs a
 * relay to fall back on. Both providers here hand out SHORT-LIVED credentials
 * rather than a fixed password — which is why this has to be a server call
 * instead of a value baked into the app bundle.
 *
 * GET /api/turn → { iceServers: [...], relay: bool, provider: string }
 *                 ready to hand to RTCPeerConnection
 *
 * The API keys stay in the environment and never reach the browser. What the
 * browser receives is a username and password that expire, and that grant
 * nothing except the right to relay bytes.
 *
 * A relay only ever forwards encrypted traffic — it cannot read messages — but
 * it does observe that two addresses are exchanging data.
 *
 * ---------------------------------------------------------------------------
 * PROVIDER ORDER AND WHY IT IS THIS WAY (ADR-003 §TURN)
 *
 * Metered first, Cloudflare second, STUN-only last. Not a preference — the
 * ordering follows what survives a hostile network:
 *
 *   Metered returns five entries, and the fifth is the one that matters:
 *     stun:stun.relay.metered.ca:80
 *     turn:global.relay.metered.ca:80                  UDP, cheapest path
 *     turn:global.relay.metered.ca:80?transport=tcp    TCP when UDP is blocked
 *     turn:global.relay.metered.ca:443                 UDP on the HTTPS port
 *     turns:global.relay.metered.ca:443?transport=tcp  TLS over TCP/443
 *
 *   That last one is indistinguishable from ordinary HTTPS on the wire, which
 *   is what gets a call through a network that drops UDP wholesale — the exact
 *   condition Jio and Airtel subscribers hit. Cloudflare's endpoint was already
 *   measured working on friendly networks (2026-07-25) but does not give us a
 *   TLS/443 fallback.
 *
 * ICE tries these in parallel and prefers the cheapest that works: host, then
 * server-reflexive (direct, via STUN), and only relay if both fail. Handing
 * over a relay candidate does NOT force its use — a call between two phones on
 * the same wifi still goes direct and costs nothing. Relay bandwidth is metered
 * and billed, so this ordering is a cost decision as much as a reachability one.
 *
 * Whichever provider answers, the WHOLE array is passed through unmodified.
 * Filtering it to "the good ones" is how you discover, in production, that the
 * one you dropped was the only one that worked on someone's network.
 */

const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
const TTL_SECONDS = 6 * 60 * 60      // six hours: long enough for a session
const UPSTREAM_TIMEOUT_MS = 4000     // a slow relay mint must not stall a call

const FALLBACK_STUN = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
]

/**
 * Metered's v1 credentials endpoint returns a bare RTCIceServer[] — no
 * envelope, no unwrapping.
 *
 * `METERED_TURN_API_KEY` is the CREDENTIAL-scoped key, not the account
 * secretKey. Metered documents the account secretKey as server-only and in
 * bold; it can mint and revoke credentials, so it must never be what this
 * reads. If per-user credentials are wanted later, the secretKey call that
 * creates them belongs behind an authenticated endpoint, not here.
 */
async function fromMetered (subdomain, apiKey, signal) {
  const url = `https://${subdomain}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`
  const upstream = await fetch(url, { signal })
  if (!upstream.ok) throw new Error(`metered ${upstream.status}`)
  const json = await upstream.json()
  // A bare array is the documented shape; accept an envelope too rather than
  // breaking if they ever wrap it.
  const iceServers = Array.isArray(json)
    ? json
    : (Array.isArray(json?.iceServers) ? json.iceServers : null)
  if (!iceServers?.length) throw new Error('metered returned no ice servers')
  return iceServers
}

async function fromCloudflare (keyId, token, signal) {
  const upstream = await fetch(`${CF_API}/${keyId}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
    signal
  })
  if (!upstream.ok) throw new Error(`cloudflare ${upstream.status}`)
  const json = await upstream.json()
  const iceServers = Array.isArray(json?.iceServers) ? json.iceServers : null
  if (!iceServers?.length) throw new Error('cloudflare returned no ice servers')
  return iceServers
}

/** True if any entry actually relays — a list of STUN URLs is not a relay. */
const hasRelay = (iceServers) => iceServers.some((s) =>
  (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith('turn')))

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  const providers = []
  if (process.env.METERED_TURN_SUBDOMAIN && process.env.METERED_TURN_API_KEY) {
    providers.push({
      name: 'metered',
      mint: (signal) => fromMetered(
        process.env.METERED_TURN_SUBDOMAIN, process.env.METERED_TURN_API_KEY, signal
      )
    })
  }
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_TOKEN) {
    providers.push({
      name: 'cloudflare',
      mint: (signal) => fromCloudflare(process.env.CF_TURN_KEY_ID, process.env.CF_TURN_TOKEN, signal)
    })
  }

  for (const provider of providers) {
    try {
      const iceServers = await provider.mint(AbortSignal.timeout(UPSTREAM_TIMEOUT_MS))
      // Credentials outlive this response, but not by much — let a browser
      // reuse them for a while without re-minting on every reload.
      res.setHeader('Cache-Control', `private, max-age=${Math.floor(TTL_SECONDS / 2)}`)
      res.status(200).json({ iceServers, relay: hasRelay(iceServers), provider: provider.name })
      return
    } catch (e) {
      // Logged, never swallowed: a provider that has started failing must be
      // visible here, because downstream all anyone sees is "calls stopped
      // connecting for some people".
      console.error(`turn mint failed (${provider.name}):`, String(e?.message || e))
    }
  }

  // Without a relay the app still works on friendly networks, so degrade to
  // STUN rather than failing the whole connection attempt. `relay: false` is
  // the client's cue that a CGNAT-to-CGNAT call is likely to fail.
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({ iceServers: FALLBACK_STUN, relay: false, provider: 'stun-only' })
}
