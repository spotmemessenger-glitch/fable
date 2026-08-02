/**
 * Spot Me — LanTransport: same-network delivery over the WebRTC
 * host-candidate path. ADR-012b.
 *
 * WHAT "LAN" MEANS ON THE WEB, HONESTLY. The browser offers no mDNS
 * responder, no raw sockets, no Wi-Fi Direct — those are native capabilities
 * and are documented as Priority 10, exactly as views/bluetooth.js documents
 * the radio. What the web DOES offer is WebRTC with HOST ICE candidates:
 * when two devices sit on the same network segment, a data channel can
 * connect over local addresses and every data byte stays on the LAN — the
 * lowest-latency, highest-bandwidth path a browser can open. Establishment
 * still needs a signalling exchange (the internet socket today), so
 * `needsInternet: true` — the DATA path is local, the HANDSHAKE is not, and
 * pretending otherwise would be the kind of lie the capability matrix exists
 * to prevent.
 *
 * MECHANICALLY it is the WebRtcTransport with three differences:
 *   1. NO STUN/TURN — `iceServers: []`, so only host (and mDNS-obfuscated
 *      .local) candidates exist and the connection either succeeds locally
 *      or not at all: the failure IS the "not on the same LAN" signal.
 *   2. VERIFICATION — after connect, getStats() is inspected for the
 *      selected candidate pair; `lanVerified()` answers whether both ends
 *      are host-type. Browsers hide raw addresses behind mDNS names
 *      (privacy), so candidate TYPE — not address parsing — is the check.
 *   3. ITS OWN capability row (below) and name, so the selector can prefer
 *      it over the general WebRTC path when both are alive.
 */
import { makeCapabilities, RANGE } from '../capabilities.js'
import { createWebRtcTransport } from './webrtc-transport.js'
import { costSignalFor } from './adapter-kit.js'

export const LAN_CAPABILITIES = makeCapabilities({
  range: RANGE.LAN,
  needsInternet: true,     // signalling — the honest note in capabilities.js applies
  offline: false,          // true offline LAN (mDNS/Wi-Fi Direct) is native, P10
  bandwidthKbps: 50_000,
  latencyMs: 5,
  batteryCostPerMin: 0.15,
  maxPayloadBytes: 256_000
})

export function createLanTransport ({
  peerId,
  selfId,
  signal,
  createPc = null,
  connection = undefined,
  config = {},
  clock = null
} = {}) {
  const inner = createWebRtcTransport({
    peerId,
    selfId,
    signal,
    // The one load-bearing difference: no ICE servers, host candidates only.
    rtcConfig: { iceServers: [] },
    createPc,
    capabilities: LAN_CAPABILITIES,
    connection,
    config: { ...config, channelLabel: config.channelLabel || 'spotme-sup-lan' },
    clock
  })

  let verified = null   // null = not checked; true/false once stats answered

  async function verify () {
    try {
      const report = await inner.getStats()
      if (!report || typeof report.forEach !== 'function') { verified = null; return verified }
      const byId = new Map()
      report.forEach((row) => { if (row.id) byId.set(row.id, row) })
      let pair = null
      report.forEach((row) => {
        if (row.type === 'transport' && row.selectedCandidatePairId) pair = byId.get(row.selectedCandidatePairId) || pair
        if (!pair && row.type === 'candidate-pair' && (row.selected === true || row.state === 'succeeded')) pair = pair || row
      })
      if (!pair) { verified = null; return verified }
      const local = byId.get(pair.localCandidateId)
      const remote = byId.get(pair.remoteCandidateId)
      verified = local?.candidateType === 'host' && remote?.candidateType === 'host'
      return verified
    } catch {
      verified = null
      return verified
    }
  }

  return Object.freeze({
    name: 'lan',
    async connect () {
      await inner.connect()
      await verify()
    },
    disconnect: inner.disconnect,
    send: inner.send,
    receive: inner.receive,
    quality: inner.quality,
    costSignal: () => costSignalFor({ battery: LAN_CAPABILITIES.batteryCostPerMin, connection }),
    capabilities: () => LAN_CAPABILITIES,
    status: inner.status,
    unavailableReason: inner.unavailableReason,
    /** true / false / null(unknown) — whether the selected pair is host↔host. */
    lanVerified: () => verified,
    reverify: verify
  })
}
