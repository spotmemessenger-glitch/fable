/**
 * Spot Me — the transport CAPABILITY MATRIX, as data. Priority 2, ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired).
 *
 * The adaptive supervisor's whole job is to choose a transport WITHOUT the user
 * choosing one. That choice is only as good as the facts it is fed, so the
 * facts live here as plain data — range, whether the internet is required,
 * whether it works offline, nominal bandwidth/latency, battery pressure, and
 * the largest frame it can carry — one row per transport the app could plausibly
 * carry a room over. selection.js scores against these rows; it never hard-codes
 * a transport name.
 *
 * These are NOMINAL capabilities (what a link CAN do), distinct from the LIVE
 * QualitySample a transport reports at runtime (what it IS doing right now).
 * The selector combines both. Keeping the static half as inert data is what lets
 * a benchmark or a test reason about selection without standing up a network.
 */

/** Reach classes, coarsest axis of the matrix. */
export const RANGE = Object.freeze({
  INTERNET: 'internet',   // anywhere, needs the public internet
  LAN: 'lan',             // same network segment / signalling-assisted P2P
  PROXIMITY: 'proximity'  // radio range only (Bluetooth), no internet at all
})

/** The exact fields every capability row must carry. Validated on construction. */
export const CAPABILITY_KEYS = Object.freeze([
  'range',              // one of RANGE
  'needsInternet',      // boolean — false is what makes a transport usable offline
  'offline',            // boolean — can carry a room with no internet present
  'bandwidthKbps',      // number  — nominal sustained throughput
  'latencyMs',          // number  — nominal one-way baseline
  'batteryCostPerMin',  // number 0..1 — relative drain while active
  'maxPayloadBytes'     // number  — largest single frame the link accepts
])

/**
 * Build and validate a capability row. Throws at the boundary rather than
 * letting a malformed row silently score as zero and vanish from selection.
 */
export function makeCapabilities (row) {
  if (!row || typeof row !== 'object') throw new Error('capabilities: row must be an object')
  if (!Object.values(RANGE).includes(row.range)) throw new Error(`capabilities: unknown range "${row.range}"`)
  for (const k of ['needsInternet', 'offline']) {
    if (typeof row[k] !== 'boolean') throw new Error(`capabilities: ${k} must be boolean`)
  }
  for (const k of ['bandwidthKbps', 'latencyMs', 'maxPayloadBytes']) {
    if (typeof row[k] !== 'number' || row[k] < 0) throw new Error(`capabilities: ${k} must be a non-negative number`)
  }
  if (typeof row.batteryCostPerMin !== 'number' || row.batteryCostPerMin < 0 || row.batteryCostPerMin > 1) {
    throw new Error('capabilities: batteryCostPerMin must be 0..1')
  }
  // A transport that needs the internet cannot also be usable offline. Catching
  // the contradiction here stops it reaching the selector, where it would make
  // the offline branch pick a link that cannot work.
  if (row.needsInternet && row.offline) throw new Error('capabilities: needsInternet && offline is contradictory')
  return Object.freeze({
    range: row.range,
    needsInternet: row.needsInternet,
    offline: row.offline,
    bandwidthKbps: row.bandwidthKbps,
    latencyMs: row.latencyMs,
    batteryCostPerMin: row.batteryCostPerMin,
    maxPayloadBytes: row.maxPayloadBytes
  })
}

/**
 * The matrix for the transports Spot Me could plausibly route a room over.
 *
 * Numbers are deliberately illustrative nominal figures for SCORING and TESTS,
 * not measured SLAs — the benchmark plan (ADR-012 addendum) is where measured
 * values will replace these. `bleMesh` is the reason this whole feature exists:
 * it is the only row with `offline: true`, and its cost is high latency, low
 * bandwidth and real battery drain — exactly the trade the selector must weigh.
 */
export const CAPABILITY_MATRIX = Object.freeze({
  socketio: makeCapabilities({
    range: RANGE.INTERNET, needsInternet: true, offline: false,
    bandwidthKbps: 5000, latencyMs: 80, batteryCostPerMin: 0.10, maxPayloadBytes: 1_000_000
  }),
  centrifugo: makeCapabilities({
    range: RANGE.INTERNET, needsInternet: true, offline: false,
    bandwidthKbps: 8000, latencyMs: 60, batteryCostPerMin: 0.10, maxPayloadBytes: 1_000_000
  }),
  webrtc: makeCapabilities({
    range: RANGE.LAN, needsInternet: true, offline: false,   // needs signalling to establish
    bandwidthKbps: 20000, latencyMs: 30, batteryCostPerMin: 0.25, maxPayloadBytes: 256_000
  }),
  bleMesh: makeCapabilities({
    range: RANGE.PROXIMITY, needsInternet: false, offline: true,
    bandwidthKbps: 100, latencyMs: 400, batteryCostPerMin: 0.60, maxPayloadBytes: 512
  })
})

/** Normalise latency to a 0..1 "better is higher" score against a reference. */
export function latencyScore (latencyMs, referenceMs = 500) {
  if (latencyMs == null) return 0
  return Math.max(0, Math.min(1, 1 - latencyMs / referenceMs))
}

/** Normalise bandwidth to 0..1 against a reference ceiling. */
export function bandwidthScore (kbps, referenceKbps = 20000) {
  if (!kbps) return 0
  return Math.max(0, Math.min(1, kbps / referenceKbps))
}
