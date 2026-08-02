/**
 * Spot Me — adaptive playout jitter buffer + packet-loss concealment policy
 * for TRANSLATED audio. WS3 design §8.2 ("playout jitter buffer: adaptive
 * 150–300 ms"), §5.3 ("the jitter buffer flexes ±150 ms"), ADR-011b.
 *
 * The original call's audio rides WebRTC, which has its own jitter machinery
 * — this buffer is ONLY for the translated stream's chunk playout, where we
 * own the schedule. Pure and clock-injected: `push()` accepts sequenced
 * chunks (possibly out of order, possibly missing), `pop()` releases the next
 * chunk when its playout time arrives, and the depth ADAPTS — grows when
 * late/missing chunks are observed, shrinks after sustained clean delivery —
 * trading latency for smoothness exactly as §8.2 prescribes.
 *
 * PLC POLICY, NOT DSP. When a gap is confirmed (a sequence number never
 * arrived by its deadline) the buffer does not synthesize audio; it decides
 * between the two policies the mission names and reports the decision:
 *   'skip'    — drop the gap, play the next chunk now (default for speech:
 *               a skipped 60 ms beats 60 ms of robot noise)
 *   'stretch' — extend the previous chunk's playout window by the gap
 *               duration (the player holds its last buffer; we stretch time,
 *               not samples)
 * The decision surfaces as a `concealment` event so the player and metrics
 * both see exactly what was lost and what was done about it.
 */

export const JITTER_DEFAULTS = Object.freeze({
  targetMs: 150,        // initial depth
  minMs: 60,            // never thinner (speech gets choppy)
  maxMs: 400,           // never fatter (latency budget §4 jitter slice)
  chunkMs: 60,          // nominal chunk duration when none supplied
  growStepMs: 40,       // depth += on observed loss/lateness
  shrinkStepMs: 20,     // depth -= after a clean window
  cleanWindow: 24,      // consecutive on-time chunks before shrinking
  plc: 'skip'           // 'skip' | 'stretch'
})

/**
 * Create the buffer. `clock.now()` is injectable for determinism.
 * push({ seq, chunk, t?, durMs? })  → accepted:boolean (duplicates refused)
 * pop(now)                          → { chunk, seq, at } | { concealment } | null
 */
export function createJitterBuffer (opts = {}) {
  const cfg = { ...JITTER_DEFAULTS, ...opts }
  if (!['skip', 'stretch'].includes(cfg.plc)) throw new Error(`jitter: unknown plc policy "${cfg.plc}"`)
  const clock = opts.clock || { now: () => Date.now() }

  let depthMs = cfg.targetMs      // the ADAPTIVE depth (applies at next reset)
  let schedDepthMs = cfg.targetMs // the depth THIS stream was scheduled with —
  //                                 adaptation must not retro-shift due times
  const pending = new Map()       // seq -> { chunk, arrivedAt, durMs }
  let nextSeq = 0                 // the sequence we owe the player next
  let baseTime = null             // when seq 0 became due
  let cleanRun = 0
  let stats = { pushed: 0, played: 0, lost: 0, late: 0, concealed: 0, grew: 0, shrank: 0 }

  const dueAt = (seq) => baseTime == null ? Infinity : baseTime + schedDepthMs + seq * cfg.chunkMs

  function grow () {
    const next = Math.min(cfg.maxMs, depthMs + cfg.growStepMs)
    if (next !== depthMs) { depthMs = next; stats.grew += 1 }
    cleanRun = 0
  }

  function shrink () {
    const next = Math.max(cfg.minMs, depthMs - cfg.shrinkStepMs)
    if (next !== depthMs) { depthMs = next; stats.shrank += 1 }
    cleanRun = 0
  }

  return {
    get depthMs () { return depthMs },
    get size () { return pending.size },
    get stats () { return { ...stats } },

    /** Offer a chunk. Out-of-order is fine; duplicates and stale are refused. */
    push ({ seq, chunk, durMs } = {}) {
      if (!Number.isInteger(seq) || seq < 0 || typeof chunk !== 'string') return false
      if (seq < nextSeq || pending.has(seq)) { stats.late += seq < nextSeq ? 1 : 0; if (seq < nextSeq) grow(); return false }
      const now = clock.now()
      if (baseTime == null) { baseTime = now; schedDepthMs = depthMs } // new stream adopts the learned depth
      pending.set(seq, { chunk, arrivedAt: now, durMs: durMs || cfg.chunkMs })
      stats.pushed += 1
      return true
    },

    /**
     * Release the next chunk if its playout time has arrived. Returns null
     * when nothing is due yet; a `{ concealment }` record when a gap was
     * confirmed and the policy acted; else `{ chunk, seq, at }`.
     */
    pop () {
      if (baseTime == null) return null
      const now = clock.now()
      const due = dueAt(nextSeq)
      if (now < due) return null
      const entry = pending.get(nextSeq)
      if (entry) {
        pending.delete(nextSeq)
        const seq = nextSeq
        nextSeq += 1
        stats.played += 1
        cleanRun += 1
        if (cleanRun >= cfg.cleanWindow) shrink()
        return { chunk: entry.chunk, seq, at: now, durMs: entry.durMs }
      }
      // The chunk is overdue and absent. That is only a CONFIRMED gap when a
      // LATER chunk has already arrived (proof the missing one was passed
      // over on the wire); an empty buffer is just a stream that hasn't
      // spoken yet, and concealing against it would spin forever.
      let laterExists = false
      for (const s of pending.keys()) { if (s > nextSeq) { laterExists = true; break } }
      if (!laterExists) return null
      const missingSeq = nextSeq
      nextSeq += 1
      stats.lost += 1
      stats.concealed += 1
      grow() // adapt for the NEXT stream; this stream's schedule is not retro-shifted
      if (cfg.plc === 'stretch') {
        // Stretch: the previous chunk's audible window is held across the
        // hole, so every later chunk plays one slot LATER (continuity over
        // pace; the drift is what the adaptive depth then absorbs).
        baseTime += cfg.chunkMs
        return { concealment: { policy: 'stretch', seq: missingSeq, stretchedMs: cfg.chunkMs, at: now } }
      }
      // Skip: drop the hole and CLOSE it — the next chunk plays now, keeping
      // pace with the source (a skipped 60 ms beats 60 ms of robot noise).
      baseTime -= cfg.chunkMs
      return { concealment: { policy: 'skip', seq: missingSeq, skippedMs: cfg.chunkMs, at: now } }
    },

    /** Drain everything ready right now (used at utterance end / teardown). */
    drain () {
      const out = []
      for (;;) {
        const next = this.pop()
        if (next == null) break
        out.push(next)
      }
      return out
    },

    /** Forget state between utterances; depth ADAPTATION is retained. */
    reset () {
      pending.clear()
      nextSeq = 0
      baseTime = null
      cleanRun = 0
    },

    /** Full reset including learned depth (teardown). */
    hardReset () {
      this.reset()
      depthMs = cfg.targetMs
      schedDepthMs = cfg.targetMs
      stats = { pushed: 0, played: 0, lost: 0, late: 0, concealed: 0, grew: 0, shrank: 0 }
    }
  }
}
