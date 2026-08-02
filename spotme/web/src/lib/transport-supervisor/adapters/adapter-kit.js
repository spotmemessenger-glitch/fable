/**
 * Spot Me — shared plumbing for the real ITransport adapters. ADR-012b.
 *
 * Every adapter owes the supervisor the same honesty: a lifecycle status that
 * matches reality, a quality sample grounded in operations that actually
 * happened, and a cost signal. This kit is that bookkeeping, once.
 *
 * QUALITY IS MEASURED FROM REAL TRAFFIC. `stats.timed(promise)` wraps an
 * operation the adapter was doing anyway (a publish ack, a GATT write) and
 * feeds its RTT and outcome into small EWMAs. No adapter manufactures probe
 * traffic just to have numbers — the passive-first rule the monitor's header
 * states, enforced by giving adapters no probe helper to reach for.
 *
 * Envelope (de)serialisation lives here too: envelopes cross adapter wires as
 * JSON of ROUTING METADATA + the opaque ciphertext (base64 text or bytes
 * re-encoded base64). One codec, so no adapter invents a dialect. Ciphertext
 * is copied through byte-identically — the codec never inspects it (INV-2).
 */
import { makeQualitySample, makeCostSignal } from '../ITransport.js'
import { TransportStatus } from '../../transport/ITransportAdapter.js'
import { makeSealedEnvelope } from '../envelope.js'
import { createEwma } from '../ewma.js'

export { TransportStatus }

/** Rolling per-adapter measurements from real operations. */
export function createAdapterStats ({ alpha = 0.3 } = {}) {
  const rtt = createEwma({ alpha })
  const loss = createEwma({ alpha })
  const throughput = createEwma({ alpha })

  return {
    /** Time `promise`; record RTT + outcome; rethrow failures untouched. */
    async timed (promise, { bytes = 0, now = () => Date.now() } = {}) {
      const t0 = now()
      try {
        const v = await promise
        const ms = Math.max(0, now() - t0)
        rtt.push(ms)
        loss.push(0)
        if (bytes > 0 && ms > 0) throughput.push((bytes * 8) / ms)   // kbps = bits/ms
        return v
      } catch (err) {
        loss.push(1)
        throw err
      }
    },
    recordFailure () { loss.push(1) },
    recordRtt (ms) { if (Number.isFinite(ms) && ms >= 0) { rtt.push(ms); loss.push(0) } },
    sample ({ connected }) {
      return makeQualitySample({
        latencyMs: rtt.value,
        lossPct: loss.value == null ? 0 : Math.max(0, Math.min(1, loss.value)),
        throughputKbps: throughput.value,
        jitterMs: 0,
        connected
      })
    },
    get rttMs () { return rtt.value },
    get lossPct () { return loss.value ?? 0 }
  }
}

/**
 * Cost signal helper. `metered` is read from the Network Information API
 * where the platform offers it (Chromium; injected for tests) and reported
 * unknown-as-false elsewhere — a transport must not imagine a data cap.
 */
export function costSignalFor ({ battery = 0.1, connection = undefined } = {}) {
  const conn = connection !== undefined
    ? connection
    : (typeof navigator !== 'undefined' ? navigator.connection : null)
  const metered = conn?.saveData === true ||
    (typeof conn?.type === 'string' && conn.type === 'cellular')
  return makeCostSignal({ monetary: metered ? 0.3 : 0, battery, metered })
}

/* ------------------------------------------------------ envelope codec --- */

const b64 = (bytes) => {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** SealedEnvelope -> wire string. Ciphertext passes through opaque. */
export function encodeEnvelope (envelope) {
  const ct = envelope.ciphertext
  return JSON.stringify({
    v: 1,
    envelopeId: envelope.envelopeId,
    roomId: envelope.roomId,
    origin: envelope.origin,
    ordering: envelope.ordering || null,
    ts: envelope.ts || 0,
    ct: typeof ct === 'string' ? ct : b64(ct),
    ctBin: typeof ct !== 'string'
  })
}

/** wire string -> SealedEnvelope. Returns null on any malformation — a bad
 *  frame is dropped by the caller with a counter, never thrown upstream. */
export function decodeEnvelope (text) {
  try {
    const w = JSON.parse(text)
    if (!w || w.v !== 1 || !w.envelopeId || !w.roomId || !w.origin) return null
    if (typeof w.ct !== 'string') return null
    return makeSealedEnvelope({
      roomId: w.roomId,
      origin: w.origin,
      ciphertext: w.ctBin ? unb64(w.ct) : w.ct,
      ordering: w.ordering || null,
      ts: w.ts || 0,
      envelopeId: w.envelopeId
    })
  } catch { return null }
}

/** A tiny receive hub: adapters register app handlers; wires call emit. */
export function createReceiveHub () {
  const handlers = new Set()
  return {
    receive (handler) {
      if (typeof handler !== 'function') throw new Error('receive: handler must be a function')
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    emit (envelope, meta) {
      for (const fn of handlers) {
        try { fn(envelope, meta) } catch { /* one bad handler must not stop the rest */ }
      }
    },
    get size () { return handlers.size }
  }
}
