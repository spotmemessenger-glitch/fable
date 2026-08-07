/**
 * Spot Me — does a relayed connection ACTUALLY FORM? ADR-003, L2.
 *
 * Configuration being present proves nothing. A TURN entry with a stale
 * password, a blocked port or an expired credential looks identical in the
 * response body to one that works, and the difference only appears as "calls
 * fail for some people on mobile data" days later. This forces a connection
 * through the relay and reads back the candidate pair that carried the bytes.
 *
 *   node test/turn-relay.check.mjs                        # local /api/turn
 *   node test/turn-relay.check.mjs https://<host>/api/turn # a deployment
 *
 * HOW IT FORCES THE RELAY. Two RTCPeerConnections in one browser, both with
 * `iceTransportPolicy: 'relay'`, which makes the browser discard host and
 * server-reflexive candidates entirely. Nothing can connect except through the
 * TURN server, so a successful data channel IS proof of relay — and the
 * candidate-pair stats name which one.
 *
 * WHAT IT DOES NOT PROVE. Both peers are on this machine, so this exercises the
 * credential, the allocation and the port, not an Indian carrier's firewall.
 * A relay that works here can still be unreachable from a network that blocks
 * UDP and non-standard ports — which is why the provider is expected to offer
 * `turns:` on TCP/443 (see api/turn.js) and why the final word on mobile
 * networks is a call placed on one.
 */

import { chromium } from 'playwright'

const SOURCE = process.argv[2] || 'http://localhost:5199/api/turn'
const CONNECT_TIMEOUT_MS = 15_000

/** Redact credentials before anything is printed: this output gets pasted. */
const safeUrls = (iceServers) => iceServers.map((s) =>
  (Array.isArray(s.urls) ? s.urls : [s.urls]).join(', '))

async function main () {
  console.log(`TURN relay check — asking ${SOURCE}\n`)

  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`${SOURCE} answered HTTP ${res.status}`)
  const config = await res.json()
  const iceServers = config?.iceServers ?? []

  console.log(`provider          : ${config.provider ?? 'unstated'}`)
  console.log(`claims relay      : ${config.relay}`)
  console.log('ice servers offered:')
  for (const line of safeUrls(iceServers)) console.log(`  ${line}`)

  const relayUrls = iceServers.flatMap((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => String(u).startsWith('turn')))
  if (relayUrls.length === 0) {
    console.log('\nRESULT: NO RELAY CONFIGURED — nothing to verify.')
    console.log('Set METERED_TURN_SUBDOMAIN and METERED_TURN_API_KEY (or CF_TURN_*) and re-run.')
    process.exit(1)
  }

  const browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  console error: ${m.text()}`) })
  await page.goto('about:blank')

  const result = await page.evaluate(async ({ iceServers, timeoutMs }) => {
    // 'relay' discards every candidate that is not a TURN allocation. If this
    // connects, it connected through the relay — there is no other path left.
    const config = { iceServers, iceTransportPolicy: 'relay' }
    const a = new RTCPeerConnection(config)
    const b = new RTCPeerConnection(config)

    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {})
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {})

    const opened = new Promise((resolve, reject) => {
      const channel = a.createDataChannel('probe')
      channel.onopen = () => { channel.send('ping'); resolve(true) }
      setTimeout(() => reject(new Error(`no relayed connection within ${timeoutMs}ms`)), timeoutMs)
    })

    const started = performance.now()
    await a.setLocalDescription(await a.createOffer())
    await b.setRemoteDescription(a.localDescription)
    await b.setLocalDescription(await b.createAnswer())
    await a.setRemoteDescription(b.localDescription)

    try {
      await opened
    } catch (e) {
      a.close(); b.close()
      return { ok: false, error: e.message }
    }
    const elapsedMs = Math.round(performance.now() - started)

    // The pair that actually carried the bytes, not the ones offered.
    const report = await a.getStats()
    let pair = null
    for (const entry of report.values()) {
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
        const local = report.get(entry.localCandidateId)
        const remote = report.get(entry.remoteCandidateId)
        pair = {
          localType: local?.candidateType,
          remoteType: remote?.candidateType,
          protocol: local?.protocol,
          relayProtocol: local?.relayProtocol,
          // The relay's own address, so a multi-region provider tells you which
          // edge answered.
          relayAddress: local?.address,
          bytesSent: entry.bytesSent,
          currentRoundTripTime: entry.currentRoundTripTime
        }
      }
    }
    a.close(); b.close()
    return { ok: true, elapsedMs, pair }
  }, { iceServers, timeoutMs: CONNECT_TIMEOUT_MS })

  await browser.close()

  console.log('')
  if (!result.ok) {
    console.log(`RESULT: FAILED — ${result.error}`)
    console.log('The relay is configured but did not carry a connection. Check that the')
    console.log('credential is current and that the relay ports are reachable from here.')
    process.exit(1)
  }

  console.log(`connected in      : ${result.elapsedMs} ms`)
  console.log(`candidate pair    : ${result.pair?.localType} -> ${result.pair?.remoteType}`)
  console.log(`relay protocol    : ${result.pair?.relayProtocol ?? 'n/a'} (transport ${result.pair?.protocol})`)
  console.log(`relay address     : ${result.pair?.relayAddress}`)
  console.log(`round trip        : ${result.pair?.currentRoundTripTime ?? 'n/a'} s`)

  const relayed = result.pair?.localType === 'relay'
  console.log(relayed
    ? '\nRESULT: PASSED — a RELAYED connection formed and carried data'
    : `\nRESULT: FAILED — connected, but the local candidate was "${result.pair?.localType}", not a relay`)
  process.exit(relayed ? 0 : 1)
}

main().catch((e) => {
  console.error('relay check error:', e.message)
  process.exit(1)
})
