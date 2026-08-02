/**
 * Spot Me — public-location approximation (the privacy boundary for presence).
 *
 * WHY THIS EXISTS: precise GPS may be used LOCALLY (distance, radius, centring,
 * routing) but must NEVER be broadcast to the public discovery lobby. This
 * module turns a device-local precise fix into a privacy-safe PUBLIC position
 * that is computed BEFORE anything leaves the device.
 *
 * The model, and the property each part buys:
 *   1. SNAP to a coarse privacy cell (~CELL_M). The public point orbits the
 *      CELL CENTRE, so an observer who averages many announcements over time
 *      converges only on the coarse cell — never the home/exact point. This is
 *      what defeats long-term correlation (a stable per-person jitter would
 *      instead average straight back to the true location).
 *   2. A per-person, per-WINDOW rotating offset inside the cell gives liveness
 *      (the point moves) while staying bounded (<= MAX_OFFSET_M). The offset is
 *      deterministic from (id, window) — stable INSIDE a window, different
 *      ACROSS windows.
 *   3. The offset angle advances by a fixed step per window, so consecutive
 *      windows are a bounded chord apart — the point drifts, it never teleports.
 *
 * Everything is pure and deterministic: pass `now` (clock) and the person `id`
 * (seed) and the output is reproducible, which is how the privacy tests pin it.
 *
 * This is a LIVE-PATH privacy primitive, not Discovery-V2 dark code — it must
 * run whenever presence is announced, regardless of any Discovery-V2 flag.
 */

/** Privacy cell edge in metres: the granularity the public position reveals. */
export const CELL_M = 500
/** Rotation window in millis: how often the in-cell offset changes. */
export const WINDOW_MS = 30 * 60 * 1000
/** Max offset from the cell centre in metres (kept well under CELL_M / 2). */
export const MAX_OFFSET_M = 150
/** Angular step per window (radians). 60° → a full orbit every 6 windows, and
 *  consecutive windows sit one chord apart (bounded drift, no teleport). */
const ANGLE_STEP = Math.PI / 3

const M_PER_DEG_LAT = 111_320

/** FNV-1a → a stable float in [0, 1) from a string seed. */
function unitHash (seed) {
  let h = 2166136261
  const s = String(seed)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

function isFiniteNumber (n) {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Snap a precise fix to the centre of its ~cellM privacy cell. This is the
 * correlation-defeating step: any two fixes inside the same cell collapse to
 * the SAME base point, so averaging many announcements over time reveals only
 * the coarse cell, never the metres-apart true positions. Exported so the
 * marker layer and the privacy tests can reason about cells directly.
 *
 * @param {number} lat precise latitude
 * @param {number} lon precise longitude
 * @param {object} [opts]
 * @param {number} [opts.cellM] override the privacy cell edge
 * @returns {{lat:number, lon:number}} the cell centre
 */
export function snapToCell (lat, lon, opts = {}) {
  const cellM = isFiniteNumber(opts.cellM) && opts.cellM > 0 ? opts.cellM : CELL_M
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180))
  const cellDegLat = cellM / M_PER_DEG_LAT
  const cellDegLon = cellM / (M_PER_DEG_LAT * cosLat)
  return {
    lat: Math.round(lat / cellDegLat) * cellDegLat,
    lon: Math.round(lon / cellDegLon) * cellDegLon
  }
}

/**
 * Compute the privacy-safe PUBLIC position for a precise fix.
 *
 * @param {number} lat precise latitude (device-local, never broadcast)
 * @param {number} lon precise longitude (device-local, never broadcast)
 * @param {object} opts
 * @param {string} opts.id     the announcing person's id (privacy seed)
 * @param {number} opts.now    epoch millis (clock — inject in tests)
 * @param {number} [opts.cellM]      override the privacy cell edge
 * @param {number} [opts.windowMs]   override the rotation window
 * @param {number} [opts.maxOffsetM] override the max in-cell offset
 * @returns {{lat:number, lon:number}|null} approximate public position, or null
 *          when the input is not a usable fix.
 */
export function approxPublicPosition (lat, lon, opts = {}) {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const id = opts.id == null ? '' : String(opts.id)
  const now = isFiniteNumber(opts.now) ? opts.now : 0
  const cellM = isFiniteNumber(opts.cellM) && opts.cellM > 0 ? opts.cellM : CELL_M
  const windowMs = isFiniteNumber(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : WINDOW_MS
  const maxOffsetM = isFiniteNumber(opts.maxOffsetM) && opts.maxOffsetM > 0 ? opts.maxOffsetM : MAX_OFFSET_M

  // 1. Snap to the cell centre — the only signal that survives averaging.
  const base = snapToCell(lat, lon, { cellM })
  const baseLat = base.lat
  const baseLon = base.lon
  const baseCosLat = Math.max(0.01, Math.cos((baseLat * Math.PI) / 180))

  // 2. Per-person, per-window bounded offset inside the cell.
  const windowIdx = Math.floor(now / windowMs)
  const phase = unitHash(id) * 2 * Math.PI
  const angle = phase + windowIdx * ANGLE_STEP
  // Stable-per-person radius in [0.5, 1.0] × maxOffset (still bounded by cap).
  const radiusM = maxOffsetM * (0.5 + 0.5 * unitHash(`${id}:r`))

  const dNorthM = radiusM * Math.cos(angle)
  const dEastM = radiusM * Math.sin(angle)
  const dLat = dNorthM / M_PER_DEG_LAT
  const dLon = dEastM / (M_PER_DEG_LAT * baseCosLat)

  return { lat: baseLat + dLat, lon: baseLon + dLon }
}

/**
 * THE PUBLIC-POSITION BOUNDARY. The single place a precise fix becomes the
 * public lat/lon that presence announces. Precise coordinates must never flow
 * through here to the wire — only the on-device approximation.
 *
 *   - ghost/hidden (show=false) or no fix → { lat: null, lon: null }
 *   - otherwise                           → approxPublicPosition(...)
 *
 * Lives in this pure module (no app/browser imports) so the privacy tests can
 * assert, mutation-style, that restoring raw coordinates fails the suite.
 * `now` is injectable for deterministic tests.
 */
export function publicPositionFor (position, show, id, now = Date.now()) {
  if (!show || !position || position.lat == null || position.lon == null) {
    return { lat: null, lon: null }
  }
  const approx = approxPublicPosition(position.lat, position.lon, { id, now })
  return approx || { lat: null, lon: null }
}

/**
 * The upper bound (metres) on how far a public position may sit from the true
 * fix: worst-case cell-corner snap error plus the max offset. Tests assert the
 * approximation never exceeds this, and callers can surface it as the honest
 * "shown within ~Xm" copy.
 */
export function maxDisplacementM (opts = {}) {
  const cellM = isFiniteNumber(opts.cellM) && opts.cellM > 0 ? opts.cellM : CELL_M
  const maxOffsetM = isFiniteNumber(opts.maxOffsetM) && opts.maxOffsetM > 0 ? opts.maxOffsetM : MAX_OFFSET_M
  // Half-cell diagonal (worst snap) + offset cap.
  return Math.SQRT2 * (cellM / 2) + maxOffsetM
}
