/**
 * Spot Me AR/beauty — temporal smoothing over tracker output.
 *
 * Raw per-frame detections jitter (detector noise) and flap (a face lost
 * for one frame is not a face that left). Anchoring a mask to raw boxes
 * makes the dog ears vibrate; keying beauty on raw identity makes effects
 * blink. This layer fixes both with two boring, testable mechanisms:
 *
 *   EMA           box fields and every landmark point are exponentially
 *                 smoothed: s ← s + α·(new − s). α = 1 disables smoothing;
 *                 small α is steadier but laggier.
 *   IDENTITY      faces get monotonic per-smoother `trackId`s, matched
 *   HYSTERESIS    frame-to-frame by greedy best-IoU (≥ iouThreshold), and
 *                 a matched track KEEPS its id. A track that vanishes is
 *                 COASTED for `holdFrames` frames (`held: true`, last
 *                 smoothed geometry) before it is dropped — so a one-frame
 *                 detector miss does not restart every anchored effect.
 *
 * PRIVACY: `trackId` is a session-transient integer minted by this
 * instance. It encodes nothing about the face and dies with the smoother —
 * see ar-threat-model.md.
 */

import { iou } from './armath.js'

export const SMOOTHER_DEFAULTS = Object.freeze({
  alpha: 0.45,            // box EMA factor — jitter-halving on the fixtures
  landmarkAlpha: 0.55,    // landmarks track faster than boxes (expressions)
  iouThreshold: 0.25,     // below this two boxes are different faces
  holdFrames: 3,          // coast this many missed frames before dropping
})

export function createFaceSmoother (opts = {}) {
  for (const key of Object.keys(opts)) {
    if (!(key in SMOOTHER_DEFAULTS)) throw new Error(`unknown smoother option: ${key}`)
  }
  const cfg = { ...SMOOTHER_DEFAULTS, ...opts }
  if (!(cfg.alpha > 0 && cfg.alpha <= 1)) throw new Error('smoother alpha must be in (0, 1]')
  if (!(cfg.landmarkAlpha > 0 && cfg.landmarkAlpha <= 1)) throw new Error('smoother landmarkAlpha must be in (0, 1]')
  if (!(cfg.iouThreshold >= 0 && cfg.iouThreshold < 1)) throw new Error('smoother iouThreshold must be in [0, 1)')
  if (!(Number.isInteger(cfg.holdFrames) && cfg.holdFrames >= 0)) throw new Error('smoother holdFrames must be an integer ≥ 0')

  let nextId = 1
  const tracks = new Map()          // trackId → {box, landmarks, conf, missed, age}

  const emaBox = (prev, next, a) => ({
    x: prev.x + a * (next.x - prev.x),
    y: prev.y + a * (next.y - prev.y),
    width: prev.width + a * (next.width - prev.width),
    height: prev.height + a * (next.height - prev.height),
  })

  const emaLandmarks = (prev, next, a) => {
    if (!next) return prev || null
    if (!prev) {
      const copy = {}
      for (const [name, p] of Object.entries(next)) copy[name] = { x: p.x, y: p.y }
      return copy
    }
    const out = {}
    for (const [name, p] of Object.entries(next)) {
      const q = prev[name]
      out[name] = q ? { x: q.x + a * (p.x - q.x), y: q.y + a * (p.y - q.y) } : { x: p.x, y: p.y }
    }
    return out
  }

  return {
    config: Object.freeze({ ...cfg }),

    /**
     * Feed one tracked frame `{faces, ts}` (trackFaces() facts). Returns
     * `{faces, ts}` where every face carries a stable `trackId`, smoothed
     * geometry, `held` (true while coasting a miss) and `age` (frames
     * matched since birth).
     */
    feed ({ faces = [], ts = 0 } = {}) {
      // Greedy best-IoU matching: strongest overlaps claim ids first, so a
      // near face cannot steal a far face's id when both moved.
      const pairs = []
      for (const [id, track] of tracks) {
        for (let i = 0; i < faces.length; i++) {
          const score = iou(track.box, faces[i].box)
          if (score >= cfg.iouThreshold && score > 0) pairs.push({ id, i, score })
        }
      }
      pairs.sort((a, b) => b.score - a.score)
      const usedTracks = new Set()
      const usedFaces = new Set()
      for (const pair of pairs) {
        if (usedTracks.has(pair.id) || usedFaces.has(pair.i)) continue
        usedTracks.add(pair.id)
        usedFaces.add(pair.i)
        const track = tracks.get(pair.id)
        const face = faces[pair.i]
        track.box = emaBox(track.box, face.box, cfg.alpha)
        track.landmarks = emaLandmarks(track.landmarks, face.landmarks || null, cfg.landmarkAlpha)
        track.conf = face.conf
        track.missed = 0
        track.age++
      }

      // Unmatched existing tracks coast, then drop. Done BEFORE minting new
      // tracks so a brand-new track cannot be aged by the feed that made it.
      for (const [id, track] of tracks) {
        if (usedTracks.has(id)) continue
        track.missed++
        if (track.missed > cfg.holdFrames) tracks.delete(id)
      }

      // Unmatched incoming faces start new tracks at their raw geometry.
      for (let i = 0; i < faces.length; i++) {
        if (usedFaces.has(i)) continue
        const face = faces[i]
        tracks.set(nextId++, {
          box: { ...face.box },
          landmarks: emaLandmarks(null, face.landmarks || null, 1),
          conf: face.conf,
          missed: 0,
          age: 1,
        })
      }

      const out = []
      for (const [trackId, track] of tracks) {
        out.push(Object.freeze({
          trackId,
          box: { ...track.box },
          landmarks: track.landmarks ? { ...track.landmarks } : null,
          conf: track.conf,
          held: track.missed > 0,
          age: track.age,
        }))
      }
      return { faces: out, ts }
    },

    /** Live track count (coasting included) — the tests' inspection hook. */
    trackCount: () => tracks.size,

    reset () {
      tracks.clear()
    },
  }
}
