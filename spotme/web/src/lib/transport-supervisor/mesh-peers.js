/**
 * Spot Me — MESH PEERS: discovery records, reputation, RSSI, duty cycle. ADR-012b.
 *
 * Four small models the mesh engine composes; each is pure and separately
 * testable.
 *
 * DISCOVERY RECORD — the compact advertisement a Spot Me node exposes so
 * another node can decide "is this a mesh peer worth connecting to?" before
 * spending a connection on it. On web (central-only) it is READ from a GATT
 * characteristic after connect; a native peripheral (P10) additionally
 * advertises it as service data. It carries a ROTATING device-id hash — never
 * the account id, never a stable radio identity (the tracking surface the
 * threat model T7 names) — plus protocol version and relay capacity.
 *
 * REPUTATION — availability accounting, NOT trust. A peer that accepts frames
 * and they get acked earns delivery-success EWMA; timeouts erode it; protocol
 * misbehaviour (malformed frames, TTL inflation, payload tampering caught by
 * frameId mismatch) applies an immediate multiplicative penalty. The score
 * chooses WHICH NEIGHBOUR to hand a frame to first — it never authenticates
 * anyone (authenticity is the seal's job, and the threat model's
 * reputation-gaming section explains why these must not mix).
 *
 * RSSI — where the platform exposes signal strength (native always; Web
 * Bluetooth only via watchAdvertisements on Chromium), it maps onto a 0..1
 * link-quality prior. Where it does not, `null` in → neutral 0.5 out, so the
 * ranking never punishes a platform for hiding a number.
 *
 * DUTY CYCLE — scan/advertise scheduling as a pure function of battery and
 * engagement, so "scanning drains the battery" has one tunable answer. The
 * web central can only honour the scan half (requestDevice/watchAdvertisements
 * are user-gesture-bound); the native layer (P10) honours both.
 */

/* ------------------------------------------------------------ discovery --- */

export const DISCOVERY_VERSION = 1
/** How often the advertised device-id hash rotates (threat model T7). */
export const DISCOVERY_ROTATION_MS = 15 * 60_000

/**
 * Build the discovery record a node exposes. `deviceIdHash` must already be
 * the ROTATED hash for the current epoch — this module never sees a raw
 * device id (compute the hash with hash.js's digest over id|epoch upstream).
 */
export function makeDiscoveryRecord ({ deviceIdHash, relayCapacity = 4, battery = null, protocolVersion = DISCOVERY_VERSION }) {
  if (!deviceIdHash || typeof deviceIdHash !== 'string') throw new Error('discovery: deviceIdHash required')
  if (deviceIdHash.length > 32) throw new Error('discovery: deviceIdHash too long for an advertisement')
  const cap = Math.max(0, Math.min(15, Math.floor(relayCapacity)))
  const bat = battery == null ? null : Math.max(0, Math.min(1, battery))
  return Object.freeze({ v: protocolVersion, id: deviceIdHash, cap, bat })
}

/** Serialise for a GATT characteristic / service-data slot (UTF-8 JSON —
 *  small, versioned, forward-parseable). Bounded: refuses records that would
 *  not fit a conservative 128-byte advertisement budget. */
export function encodeDiscoveryRecord (record) {
  const bytes = new TextEncoder().encode(JSON.stringify(record))
  if (bytes.byteLength > 128) throw new Error('discovery: record exceeds 128-byte budget')
  return bytes
}

/** Parse bytes read from a peer. Malformed input returns null — a peer that
 *  advertises garbage is a peer to ignore, not an exception to throw. */
export function parseDiscoveryRecord (bytes) {
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
    const rec = JSON.parse(text)
    if (!rec || typeof rec !== 'object') return null
    if (rec.v !== DISCOVERY_VERSION) return null
    if (typeof rec.id !== 'string' || !rec.id || rec.id.length > 32) return null
    return Object.freeze({
      v: rec.v,
      id: rec.id,
      cap: Math.max(0, Math.min(15, Number(rec.cap) || 0)),
      bat: rec.bat == null ? null : Math.max(0, Math.min(1, Number(rec.bat)))
    })
  } catch { return null }
}

/* ----------------------------------------------------------- reputation --- */

export const REPUTATION_DEFAULTS = Object.freeze({
  alpha: 0.25,              // EWMA weight of the newest outcome
  initial: 0.6,             // optimistic-but-not-blind prior for a new peer
  misbehaviourPenalty: 0.5, // multiplicative hit per protocol violation
  floor: 0.05,              // scores never pin to 0 — a peer can redeem itself
  deprioritiseBelow: 0.3    // below this a peer is tried last, not first
})

export function createPeerReputation ({ config = {} } = {}) {
  const cfg = { ...REPUTATION_DEFAULTS, ...config }
  // peerId -> { score, deliveries, failures, misbehaviours, lastSeen }
  const peers = new Map()

  function lane (peerId) {
    let p = peers.get(peerId)
    if (!p) { p = { score: cfg.initial, deliveries: 0, failures: 0, misbehaviours: 0, lastSeen: 0 }; peers.set(peerId, p) }
    return p
  }

  const scoreOf = (peerId) => (peers.has(peerId) ? peers.get(peerId).score : cfg.initial)

  return Object.freeze({
    /** A frame handed to this peer was eventually acked end-to-end. */
    delivered (peerId, now = 0) {
      const p = lane(peerId)
      p.score = cfg.alpha * 1 + (1 - cfg.alpha) * p.score
      p.deliveries++
      p.lastSeen = now
      return p.score
    },
    /** A frame handed to this peer timed out unacked. */
    failed (peerId, now = 0) {
      const p = lane(peerId)
      p.score = Math.max(cfg.floor, cfg.alpha * 0 + (1 - cfg.alpha) * p.score)
      p.failures++
      p.lastSeen = now
      return p.score
    },
    /** Protocol violation observed (malformed frame, TTL inflation, payload
     *  mutation caught by frameId mismatch): immediate multiplicative hit. */
    misbehaved (peerId, why = 'protocol', now = 0) {
      const p = lane(peerId)
      p.score = Math.max(cfg.floor, p.score * cfg.misbehaviourPenalty)
      p.misbehaviours++
      p.lastSeen = now
      p.lastMisbehaviour = why
      return p.score
    },
    score: scoreOf,
    /** Neighbours ordered best-first for forwarding; deprioritised ones last. */
    rank (peerIds) {
      return [...peerIds].sort((a, b) => {
        const sa = scoreOf(a); const sb = scoreOf(b)
        const da = sa < cfg.deprioritiseBelow ? 1 : 0
        const db = sb < cfg.deprioritiseBelow ? 1 : 0
        if (da !== db) return da - db
        if (sb !== sa) return sb - sa
        return a < b ? -1 : a > b ? 1 : 0
      })
    },
    inspect (peerId) { return peers.has(peerId) ? { ...peers.get(peerId) } : null },
    get size () { return peers.size }
  })
}

/* ----------------------------------------------------------------- rssi --- */

/**
 * Map an RSSI reading (dBm) to 0..1 link quality. Piecewise-linear over the
 * usable BLE band: ≥ −50 dBm is as good as BLE gets (1.0); ≤ −95 dBm is
 * effectively out of range (0.0). `null` (platform hides RSSI) → 0.5, the
 * honest neutral.
 */
export function rssiToLinkQuality (rssiDbm) {
  if (rssiDbm == null || !Number.isFinite(rssiDbm)) return 0.5
  const clamped = Math.max(-95, Math.min(-50, rssiDbm))
  return (clamped + 95) / 45
}

/* ----------------------------------------------------------- duty cycle --- */

/**
 * Scan schedules by battery band. Windows are web-realistic (a scan here is a
 * watchAdvertisements window or a reconnect attempt burst, not a raw
 * controller scan); the native layer maps the same bands onto real scan
 * parameters. `receiveOnly` is the T8 defence: below the floor the node
 * stops initiating and only serves already-connected links.
 */
export const DUTY_CYCLE = Object.freeze({
  active: Object.freeze({ scanMs: 3_000, idleMs: 7_000, receiveOnly: false }),   // healthy battery, user engaged
  background: Object.freeze({ scanMs: 2_000, idleMs: 28_000, receiveOnly: false }),
  low: Object.freeze({ scanMs: 1_000, idleMs: 59_000, receiveOnly: false }),
  critical: Object.freeze({ scanMs: 0, idleMs: 60_000, receiveOnly: true })
})

/**
 * Choose the schedule. `engaged` = the user is actively in an offline
 * conversation (the one case that justifies spending on an aggressive scan).
 * Unknown battery uses the `background` schedule — the conservative default
 * battery.js documents.
 */
export function dutyCycleFor ({ batteryLevel = null, batteryKnown = false, charging = null, engaged = false } = {}) {
  if (charging === true) return engaged ? DUTY_CYCLE.active : DUTY_CYCLE.background
  if (!batteryKnown || batteryLevel == null) return DUTY_CYCLE.background
  if (batteryLevel < 0.15) return DUTY_CYCLE.critical
  if (batteryLevel < 0.3) return DUTY_CYCLE.low
  return engaged ? DUTY_CYCLE.active : DUTY_CYCLE.background
}
