/**
 * Spot Me — TURN credential minting.
 *
 * Two phones on mobile data usually cannot reach each other directly: Indian
 * carriers put subscribers behind shared addresses, so WebRTC needs a relay
 * to fall back on. Cloudflare's TURN service provides one, and it hands out
 * SHORT-LIVED credentials rather than a fixed password — which is why this
 * has to be a server call instead of a value baked into the app bundle.
 *
 * GET /api/turn → { iceServers: [...] }  ready to hand to RTCPeerConnection
 *
 * The API token stays in the environment and never reaches the browser. What
 * the browser receives is a username and password that expire, and that grant
 * nothing except the right to relay bytes.
 *
 * A relay only ever forwards encrypted traffic — it cannot read messages —
 * but it does observe that two addresses are exchanging data.
 */
const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
const TTL_SECONDS = 6 * 60 * 60      // six hours: long enough for a session
const FALLBACK_STUN = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
]

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  const keyId = process.env.CF_TURN_KEY_ID
  const token = process.env.CF_TURN_TOKEN
  if (!keyId || !token) {
    // Without a relay the app still works on friendly networks, so degrade to
    // STUN rather than failing the whole connection attempt.
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ iceServers: FALLBACK_STUN, relay: false })
    return
  }

  try {
    const upstream = await fetch(`${CF_API}/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS })
    })
    if (!upstream.ok) throw new Error(`cloudflare ${upstream.status}`)
    const json = await upstream.json()
    const iceServers = Array.isArray(json?.iceServers) ? json.iceServers : null
    if (!iceServers?.length) throw new Error('no ice servers returned')

    // Credentials outlive this response, but not by much — let a browser reuse
    // them for a while without re-minting on every reload.
    res.setHeader('Cache-Control', `private, max-age=${Math.floor(TTL_SECONDS / 2)}`)
    res.status(200).json({ iceServers, relay: true })
  } catch (e) {
    console.error('turn mint failed:', String(e?.message || e))
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ iceServers: FALLBACK_STUN, relay: false })
  }
}
