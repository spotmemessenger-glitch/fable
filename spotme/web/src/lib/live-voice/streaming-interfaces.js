/**
 * Spot Me — the streaming AI contracts for live voice. Roadmap V2 §6, ADR-011.
 *
 * Three replaceable providers sit in the pipeline: streaming speech-to-text,
 * streaming machine translation, and streaming text-to-speech. §6.3 requires
 * each to remain a swappable module, and the standing AI principle (CLAUDE.md)
 * forbids any one becoming a hard dependency — the app must route/fall back on
 * quality, availability, cost, and latency. A shared, checkable contract is what
 * makes "swappable" true rather than aspirational, so this file is to live voice
 * what `ITransportAdapter.js` is to transport: frozen method lists, a forbidden
 * surface, a status enum, and `assertImplements*` the tests run.
 *
 * THE STREAMING CONTRACT — the three things every adapter must do, because a
 * <2.5 s budget (ADR-011) is impossible without them:
 *
 *   • PARTIAL RESULTS. Emit interim output as it forms via `handlers.onPartial`,
 *     not just a final blob. Captions and downstream stages start on partials.
 *   • FIRST TOKEN. Signal the first partial/first audio via `handlers.onFirstToken`.
 *     Its arrival time is what the latency budget measures per stage (§6.5); a
 *     final-only adapter cannot report it and cannot meet the budget.
 *   • CANCEL. A running stream returns a controller with `cancel(reason)`. Barge-
 *     in (§6.2 interruption support) must abandon in-flight STT/MT/TTS at once,
 *     or the listener hears the answer to a sentence the speaker already
 *     retracted.
 *
 * Each role method returns a StreamController: `{ cancel(reason), done }` where
 * `done` is a Promise resolving to the final result (or rejecting on error).
 *
 * PRIVACY IS A CONTRACT, NOT A HOPE. §6.3/§6.4 forbid retaining raw voice by
 * default and forbid leaking more than the enabled feature needs. So, mirroring
 * the transport layer's FORBIDDEN_KEY_SURFACE, adapters must NOT expose members
 * that imply local retention of audio or transcripts. The prohibition is a test,
 * not a paragraph.
 */

/* --------------------------------------------------------------- statuses */

/** Streaming session lifecycle, normalised across the three providers. */
export const StreamingStatus = Object.freeze({
  IDLE: 'idle',
  OPEN: 'open',            // session allocated, ready for input
  STREAMING: 'streaming',  // partials in flight
  CLOSED: 'closed',
  FAILED: 'failed'
})

/* Handler names an adapter invokes. Documented as constants so a caller and an
 * adapter cannot disagree by a typo. */
export const STREAM_HANDLERS = Object.freeze(['onFirstToken', 'onPartial', 'onFinal', 'onError'])

/* Members that must NOT exist on any streaming adapter — retention/persistence
 * surface that would contradict §6.3/§6.4. Same shape and same enforcement as
 * the transport layer's key-surface ban. */
export const FORBIDDEN_RETENTION_SURFACE = Object.freeze([
  'store', 'persist', 'save', 'saveAudio', 'record', 'recording',
  'history', 'transcriptLog', 'audioLog', 'retain', 'cache'
])

/* Lifecycle methods every adapter shares, plus the one role method that differs.
 * Narrow on purpose (ADR-002's lesson): a wide contract would leak one
 * provider's SDK shape into the seam and the next provider would become an
 * emulator of the first. */
const LIFECYCLE = Object.freeze(['open', 'close', 'status', 'capabilities'])

export const STREAMING_STT_METHODS = Object.freeze([...LIFECYCLE, 'transcribe'])
export const STREAMING_MT_METHODS = Object.freeze([...LIFECYCLE, 'translate'])
export const STREAMING_TTS_METHODS = Object.freeze([...LIFECYCLE, 'synthesize'])

/* ----------------------------------------------------------- assertions */

function assertShape (adapter, methods, label) {
  if (!adapter || typeof adapter !== 'object') throw new Error(`${label}: not an object`)
  for (const m of methods) {
    if (typeof adapter[m] !== 'function') throw new Error(`${label}: missing required method ${m}()`)
  }
  for (const banned of FORBIDDEN_RETENTION_SURFACE) {
    if (banned in adapter) {
      throw new Error(
        `${label}: exposes "${banned}" — live-voice adapters must not retain raw ` +
        'audio or transcripts (Roadmap §6.3/§6.4, ADR-011)'
      )
    }
  }
  const s = adapter.status()
  if (!Object.values(StreamingStatus).includes(s)) {
    throw new Error(`${label}: status() returned "${s}", not a StreamingStatus`)
  }
  const caps = adapter.capabilities()
  if (!caps || typeof caps !== 'object') throw new Error(`${label}: capabilities() must return an object`)
  // The three contract capabilities must be declared true — an adapter that
  // cannot do partials/first-token/cancel cannot meet the budget, and saying so
  // up front beats discovering it mid-call.
  for (const cap of ['partial', 'firstToken', 'cancel']) {
    if (caps[cap] !== true) throw new Error(`${label}: capabilities().${cap} must be true (streaming contract)`)
  }
}

/** Throw unless `adapter` satisfies IStreamingStt. */
export function assertImplementsStreamingStt (adapter, label = 'StreamingStt') {
  assertShape(adapter, STREAMING_STT_METHODS, label)
}

/** Throw unless `adapter` satisfies IStreamingMt. */
export function assertImplementsStreamingMt (adapter, label = 'StreamingMt') {
  assertShape(adapter, STREAMING_MT_METHODS, label)
}

/** Throw unless `adapter` satisfies IStreamingTts. */
export function assertImplementsStreamingTts (adapter, label = 'StreamingTts') {
  assertShape(adapter, STREAMING_TTS_METHODS, label)
}

/**
 * Throw unless `controller` is a StreamController: `{ cancel(reason), done }`.
 * The role methods promise this shape; a stage runner relies on it to implement
 * barge-in, so it is asserted rather than assumed.
 */
export function assertStreamController (controller, label = 'StreamController') {
  if (!controller || typeof controller !== 'object') throw new Error(`${label}: not an object`)
  if (typeof controller.cancel !== 'function') throw new Error(`${label}: missing cancel()`)
  if (!controller.done || typeof controller.done.then !== 'function') throw new Error(`${label}: done must be a Promise`)
}

/**
 * Normalise a handlers bag so a stage runner can call every hook without a
 * per-call existence check. Unknown keys are dropped; missing hooks become
 * no-ops. Returned object is frozen so an adapter cannot smuggle state back
 * through it.
 */
export function normalizeHandlers (handlers = {}) {
  const out = {}
  for (const name of STREAM_HANDLERS) {
    const fn = handlers[name]
    out[name] = typeof fn === 'function' ? fn : () => {}
  }
  return Object.freeze(out)
}
