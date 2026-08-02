/**
 * Spot Me — ONE STT pass per speaker, shared across fan-out legs. WS3 design
 * §6.3 ("one STT pass per active speaker, not per listener"), ADR-011b.
 *
 * A three-language group utterance runs three MT+TTS legs, but the speaker
 * only said the words once — paying for three transcriptions of the same
 * audio would be triple cost and triple latency variance for zero information
 * (§14.2). This wrapper turns one underlying IStreamingStt into N per-leg
 * adapters that all observe a SINGLE transcription:
 *
 *   • the FIRST leg to call transcribe() starts the real stream;
 *   • every leg's handlers receive every partial/final as they happen;
 *   • a leg that subscribes AFTER emission began is caught up from the
 *     replay state (latest partial + final) so no leg misses the transcript;
 *   • a leg cancelling only unsubscribes ITSELF; the underlying stream is
 *     cancelled only when EVERY leg has cancelled (barge-in cancels all legs,
 *     so the real cancel still fires exactly once).
 *
 * Replay state is BOUNDED: latest partial + first-token + final — never the
 * full partial history (a long utterance must not accumulate transcript
 * copies; the long-session test holds this).
 */

import { StreamingStatus, normalizeHandlers, assertImplementsStreamingStt } from './streaming-interfaces.js'

/**
 * Begin one shared utterance over `stt`. Returns `{ legAdapter(), legs }`:
 * call `legAdapter()` once per fan-out leg; each returned object satisfies
 * IStreamingStt and may be handed to its own orchestrator.
 *
 * `extraInput` (e.g. `{ audio: [...] }`) merges into the first leg's input so
 * the real audio reaches the underlying adapter even though per-leg
 * orchestrators only pass `{ script, lang }`.
 */
export function beginSharedSttUtterance (stt, extraInput = {}) {
  assertImplementsStreamingStt(stt, 'sharedStt.underlying')
  const subs = new Set()
  let started = false
  let underlying = null
  let sharedDone = null
  const replay = { firstToken: null, lastPartial: null, final: null }
  let legCount = 0

  function ensureStarted (input) {
    if (started) return
    started = true
    underlying = stt.transcribe({ ...input, ...extraInput }, {
      onFirstToken: (f) => { replay.firstToken = f; for (const s of subs) s.h.onFirstToken(f) },
      onPartial: (p) => { replay.lastPartial = p; for (const s of subs) s.h.onPartial(p) },
      onFinal: (f) => { replay.final = f; for (const s of subs) s.h.onFinal(f) },
      onError: (e) => { for (const s of subs) s.h.onError(e) }
    })
    sharedDone = underlying.done
  }

  function legAdapter () {
    legCount += 1
    const leg = {
      open: () => stt.open(),
      close: () => Promise.resolve(), // closing one leg must not close the shared stream
      status: () => stt.status(),
      capabilities: () => ({ ...stt.capabilities(), shared: true }),
      transcribe (input, handlers) {
        const h = normalizeHandlers(handlers)
        const sub = { h, cancelled: null }
        subs.add(sub)
        ensureStarted(input)
        // Late subscriber catch-up (bounded replay, latest-state only).
        if (replay.firstToken) h.onFirstToken(replay.firstToken)
        if (replay.lastPartial) h.onPartial(replay.lastPartial)
        if (replay.final) h.onFinal(replay.final)
        const done = sharedDone.then((r) => (sub.cancelled ? { cancelled: sub.cancelled } : r))
        return {
          cancel (reason = 'cancelled') {
            sub.cancelled = reason
            subs.delete(sub)
            if (subs.size === 0 && underlying) { try { underlying.cancel(reason) } catch { /* done */ } }
          },
          done
        }
      }
    }
    assertImplementsStreamingStt(leg, 'sharedStt.leg')
    return leg
  }

  return {
    legAdapter,
    get legs () { return legCount },
    get status () { return started && underlying ? StreamingStatus.STREAMING : StreamingStatus.IDLE }
  }
}
