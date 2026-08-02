/**
 * Spot Me — streaming failover chain. WS3 design §7.4, roadmap rule 10 (no
 * provider is a hard dependency).
 *
 * Batch translation fails over BETWEEN requests (the #51 router walks a
 * fallback chain). A live stream can die IN THE MIDDLE of an utterance, so the
 * chain has to fail over mid-stream without repeating what the listener
 * already heard and without voicing anything wrong. This wrapper does exactly
 * that, per role:
 *
 *   STT  — a failed leg re-issues only the REMAINING audio segments to the
 *          next candidate; transcript text confirmed before the hop is kept
 *          and the fallback's text appends to it. Captions may revise (they
 *          are allowed to); voiced text only ever comes from finals, so
 *          nothing wrong is ever said aloud.
 *   MT   — the whole segment re-issues to the next candidate (text in, text
 *          out; nothing was played yet).
 *   TTS  — the next candidate synthesizes only the REMAINING text, computed
 *          from how many chunks the dead provider confirmed (§7.4: "already-
 *          played audio is not repeated"). If the fallback lacks the clone the
 *          caller sees the provider change and must flip the indicator —
 *          honest, never silent.
 *
 * The wrapper IS an IStreaming* adapter itself (same contract, same asserts),
 * so the orchestrator cannot tell one provider from a chain of three — which
 * is the whole point. Candidates are tried in order; per-candidate failures
 * are recorded on the result as `failovers` so tests, metrics and the router's
 * quality feedback see exactly what happened. cancel() during any leg cancels
 * the active candidate and stops the chain.
 */

import {
  StreamingStatus, normalizeHandlers,
  assertImplementsStreamingStt, assertImplementsStreamingMt, assertImplementsStreamingTts
} from '../streaming-interfaces.js'

const ROLE_METHOD = Object.freeze({ stt: 'transcribe', mt: 'translate', tts: 'synthesize' })
const ROLE_ASSERT = Object.freeze({
  stt: assertImplementsStreamingStt,
  mt: assertImplementsStreamingMt,
  tts: assertImplementsStreamingTts
})

const joinText = (a, b) => `${a || ''} ${b || ''}`.replace(/\s+/g, ' ').trim()

/**
 * Build a failover chain over `candidates` (ordered, best first) for `role`
 * ('stt' | 'mt' | 'tts'). Each candidate must implement the role's streaming
 * interface. Options:
 *   maxFailovers — how many hops the chain may take (default: all candidates)
 *   onFailover   — observer `({ role, from, to, reason, attempt })`
 */
export function createFailoverChain (role, candidates = [], opts = {}) {
  const method = ROLE_METHOD[role]
  if (!method) throw new Error(`failover: unknown role "${role}"`)
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('failover: at least one candidate required')
  for (const c of candidates) ROLE_ASSERT[role](c, `failover(${role}) candidate`)
  const maxFailovers = Number.isInteger(opts.maxFailovers) ? opts.maxFailovers : candidates.length - 1
  const onFailover = typeof opts.onFailover === 'function' ? opts.onFailover : null

  let status = StreamingStatus.IDLE
  const idOf = (c, i) => c.capabilities()?.provider || `candidate-${i}`

  function run (input, handlers) {
    const h = normalizeHandlers(handlers)
    let cancelled = null
    let active = null
    const failovers = []

    // Progress the chain must respect across hops.
    const segmented = role === 'stt' && Array.isArray(input?.audio)
    let sttSegmentsDone = 0        // completed audio segments (segmented stt)
    let committedText = ''         // stt transcript confirmed before a hop
    let ttsChunksOut = 0           // audio chunks already emitted (tts)
    let firstEmitted = false

    const done = (async () => {
      let attempt = 0
      let lastError = null
      for (let i = 0; i < candidates.length; i++) {
        if (cancelled) return { cancelled }
        if (i > 0 && attempt > maxFailovers) break
        const candidate = candidates[i]
        const legInput = shapeLegInput(input)
        if (legInput == null) break // nothing remains for a fallback to do
        let legSegments = 0
        let legLastText = ''
        try {
          const result = await runLeg(candidate, legInput, {
            onSegment: (text) => { legSegments += 1; legLastText = text }
          })
          status = StreamingStatus.OPEN
          if (result?.cancelled) return result
          const out = { ...result, provider: idOf(candidate, i) }
          if (role === 'stt' && committedText) out.text = joinText(committedText, result.text)
          if (role === 'tts' && ttsChunksOut > 0 && Array.isArray(result?.chunks)) out.resumed = true
          if (failovers.length) out.failovers = failovers.slice()
          return out
        } catch (e) {
          lastError = e
          attempt += 1
          if (segmented) { sttSegmentsDone += legSegments; committedText = joinText(committedText, legLastText) }
          const from = idOf(candidate, i)
          const to = i + 1 < candidates.length ? idOf(candidates[i + 1], i + 1) : null
          failovers.push({ from, to, reason: String(e?.message || e), attempt })
          if (onFailover) onFailover({ role, from, to, reason: String(e?.message || e), attempt })
          if (cancelled) return { cancelled }
        }
      }
      status = StreamingStatus.FAILED
      const err = new Error(`failover(${role}): all ${candidates.length} candidates failed — last: ${String(lastError?.message || lastError)}`)
      err.failovers = failovers
      h.onError(err)
      throw err
    })()

    function runLeg (candidate, legInput, { onSegment }) {
      return new Promise((resolve, reject) => {
        const ctrl = candidate[method](legInput, {
          onFirstToken: (f) => { if (!firstEmitted) { firstEmitted = true; h.onFirstToken(f) } },
          onPartial: (p) => {
            if (role === 'stt') {
              const merged = joinText(committedText, p.text)
              onSegment(p.text)
              h.onPartial({ ...p, text: merged })
            } else if (role === 'tts') {
              h.onPartial({ ...p, index: ttsChunksOut, firstAudio: ttsChunksOut === 0 })
              ttsChunksOut += 1
            } else {
              h.onPartial(p)
            }
          },
          onFinal: (f) => {
            const out = role === 'stt' && committedText ? { ...f, text: joinText(committedText, f.text) } : f
            h.onFinal(out)
          },
          onError: () => { /* the leg's own rejection carries the error */ }
        })
        active = ctrl
        ctrl.done.then(resolve, reject)
      })
    }

    /** What does the NEXT candidate get, given how far the stream progressed? */
    function shapeLegInput (base) {
      if (segmented) {
        const rest = base.audio.slice(sttSegmentsDone)
        if (rest.length === 0 && sttSegmentsDone > 0) return null
        return { ...base, audio: rest }
      }
      if (role === 'tts' && ttsChunksOut > 0) {
        // Approximate the un-played remainder by the fraction of chunks that
        // made it out — the design's alignment-offset resume, at chunk
        // granularity (provider alignment maps refine this when present).
        const text = String(base?.text ?? '')
        const per = Math.max(1, Math.ceil(text.length / (ttsChunksOut + 2)))
        const remaining = text.slice(per * ttsChunksOut)
        if (!remaining.trim()) return null
        return { ...base, text: remaining, resumedAtChunk: ttsChunksOut }
      }
      return base
    }

    return {
      cancel: (reason = 'cancelled') => {
        cancelled = reason
        if (active) { try { active.cancel(reason) } catch { /* done */ } }
      },
      done
    }
  }

  const chain = {
    open: async () => { status = StreamingStatus.OPEN; await Promise.all(candidates.map((c) => c.open())) },
    close: async () => { status = StreamingStatus.CLOSED; await Promise.all(candidates.map((c) => c.close())) },
    status: () => status,
    capabilities: () => ({
      partial: true,
      firstToken: true,
      cancel: true,
      streaming: true,
      provider: `failover(${candidates.map(idOf).join('>')})`,
      role
    }),
    [method]: run
  }
  ROLE_ASSERT[role](chain, `failover(${role})`)
  return chain
}
