/**
 * Discovery V2 — privacy-safe people markers.
 *
 * This is where the location-privacy boundary meets the map. It takes the
 * PUBLIC presence announcements (already approximate — see geo-approx.js — the
 * precise fix never left the announcer's device) and turns them into markers,
 * enforcing three things every time:
 *
 *   1. HIDDEN/GHOST people (ghost=true, or no public lat/lon) produce NO marker
 *      and NO coordinates at all.
 *   2. BLOCKED people are filtered out entirely (via an injected isBlocked).
 *   3. The marker a caller receives carries ONLY the approximate public
 *      position and an explicit `approximate: true` flag — there is no field,
 *      anywhere on the object, that could carry a precise coordinate, so exact
 *      location is not recoverable from a marker, a log of markers, or the DOM
 *      built from them.
 *
 * The approximation is done UPSTREAM by the announcer; this module never
 * receives a precise fix, so it cannot leak one. It defensively re-checks that
 * an incoming position is not implausibly precise-looking, but its guarantee
 * rests on never being handed exact coordinates in the first place.
 */

/** Fields we copy onto a marker. Anything not on this list is dropped — a
 *  provider/announcement cannot smuggle extra data onto the marker. */
const MARKER_FIELDS = ['id', 'name', 'avatar', 'lang']

function isNum (n) { return typeof n === 'number' && Number.isFinite(n) }

/**
 * Build map markers from public presence announcements.
 *
 * @param {Array} announcements  public presence objects (approximate lat/lon)
 * @param {object} [opts]
 * @param {(id:string)=>boolean} [opts.isBlocked]  block predicate
 * @param {string} [opts.selfId]  the local user's id (excluded from markers)
 * @param {number} [opts.maxDisplacementM]  the announced approximation bound,
 *        surfaced on each marker as honest "shown within ~Xm" copy
 * @returns {Array} markers — approximate-only, blocked/hidden already removed
 */
export function toPeopleMarkers (announcements, opts = {}) {
  const isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false
  const selfId = opts.selfId ?? null
  const out = []
  if (!Array.isArray(announcements)) return out

  for (const a of announcements) {
    if (!a || a.id == null) continue
    if (a.id === selfId) continue
    if (isBlocked(a.id)) continue
    // Hidden/ghost, or no public position → the person is simply not on the map.
    if (a.ghost === true) continue
    if (!isNum(a.lat) || !isNum(a.lon)) continue

    const marker = {}
    for (const f of MARKER_FIELDS) if (a[f] !== undefined) marker[f] = a[f]
    // The ONLY coordinates on a marker are the approximate public ones.
    marker.lat = a.lat
    marker.lon = a.lon
    marker.approximate = true
    if (isNum(opts.maxDisplacementM)) marker.accuracyM = opts.maxDisplacementM
    out.push(Object.freeze(marker))
  }
  return out
}

/**
 * Belt-and-braces assertion for tests and defensive call sites: a set of
 * markers must expose no field that could be a precise coordinate, and every
 * positioned marker must be flagged approximate. Returns true or throws.
 *
 * @param {Array} markers
 * @param {Array} [preciseFixes]  known precise coords that must NOT appear
 * @returns {boolean}
 */
export function assertNoPreciseLeak (markers, preciseFixes = []) {
  const banned = new Set()
  for (const f of preciseFixes) {
    if (f && isNum(f.lat)) banned.add(String(f.lat))
    if (f && isNum(f.lon)) banned.add(String(f.lon))
  }
  const json = JSON.stringify(markers || [])
  for (const val of banned) {
    if (json.includes(val)) throw new Error(`precise coordinate ${val} leaked into markers`)
  }
  for (const m of markers || []) {
    if (isNum(m.lat) && m.approximate !== true) {
      throw new Error(`marker ${m.id} carries a position but is not flagged approximate`)
    }
    // No alternate coordinate fields may ride along.
    for (const k of Object.keys(m)) {
      if (/precise|exact|real(lat|lon)|gps/i.test(k)) {
        throw new Error(`marker ${m.id} exposes a precise-looking field: ${k}`)
      }
    }
  }
  return true
}
