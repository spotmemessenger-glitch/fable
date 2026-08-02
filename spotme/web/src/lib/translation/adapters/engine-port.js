/**
 * Spot Me — the delegation seam between the V2 adapters and the shipped engine.
 *
 * The design's rule is "registration, not rewrite": the adapters must NOT
 * re-implement any provider's API calls, keys, or prompt fencing — all of that
 * lives in `api/translate.js` and stays there. An adapter is a thin object that
 * declares a provider's capabilities and DELEGATES its operations to the engine
 * through this port. So there is exactly one place the platform touches the
 * engine, and it is here.
 *
 * DEFAULT = NOT WIRED. The platform ships OFF (see ../flag.js). With no delegate
 * supplied, every operation throws `NOT_WIRED_MESSAGE` — the honest state:
 * built, exercised by the suite, and unable to spend a vendor call. Only
 * `scriptOk` is live, because it is the engine's own pure guard imported
 * directly (`api/translate.js` is side-effect-free at module scope), and reusing
 * it — rather than copying it — is the whole point.
 *
 * FUTURE ON-RAMP. `createHandlerDelegate()` wraps the engine's exported
 * `handler` so, when the owner enables the platform, a provider operation
 * delegates to `api/translate.js` verbatim — imported, never duplicated. It is
 * deliberately NOT the default and is never invoked by the suite; wiring it in
 * is a separate, deliberate change.
 */
import handler, { scriptOk } from '../../../../api/translate.js'

/** Thrown by any operation while the platform is not wired to the live engine. */
export const NOT_WIRED_MESSAGE =
  'translation V2 is built but not wired to the live engine (flag OFF) — ' +
  'no adapter may spend a vendor call until the platform is enabled'

/** The operations the port brokers to the engine. */
export const PORT_OPS = Object.freeze([
  'translate', 'detectLanguage', 'transliterate', 'comprehend', 'adjudicate'
])

/**
 * Create the engine port. `delegate` is optional; without it the port is
 * inert (throws on every op), which is correct for the OFF default.
 *
 * @param {null | Record<string, Function>} delegate
 */
export function createEnginePort (delegate = null) {
  const port = { scriptOk, wired: Boolean(delegate) }
  for (const op of PORT_OPS) {
    port[op] = async (...args) => {
      if (delegate && typeof delegate[op] === 'function') return delegate[op](...args)
      throw new Error(`${NOT_WIRED_MESSAGE} [${op}]`)
    }
  }
  return port
}

/**
 * The future on-ramp: a delegate that wraps the shipped `handler`, so an op is
 * served by the real engine end-to-end. Dormant — returned for the eventual
 * enabled path, not used by the OFF default and not exercised by tests.
 *
 * @param {{token?: string, origin?: string}} opts  auth for the gated endpoint
 */
export function createHandlerDelegate (opts = {}) {
  const auth = opts.token ? `Bearer ${opts.token}` : ''
  const origin = opts.origin || 'http://localhost:5173'

  // Invoke the engine handler with a synthesized req/res, capturing its answer.
  async function call (op, body) {
    let out = null
    const res = {
      setHeader () {}, removeHeader () {}, end () {},
      status (code) { out = { code }; return res },
      json (b) { if (out) out.body = b }
    }
    const url = op ? `/api/translate?op=${op}` : '/api/translate'
    await handler({ method: 'POST', body, headers: { authorization: auth, origin }, url, query: {} }, res)
    if (!out || out.code !== 200) {
      throw new Error(`engine ${out ? out.code : 'no-response'}: ${JSON.stringify(out?.body)?.slice(0, 160)}`)
    }
    return out.body
  }

  return {
    translate: (req) => call(null, { q: req.text, source: req.sourceLang || undefined, target: req.targetLang }),
    detectLanguage: (text) => call('detect', { q: text }),
    transliterate: (req) => call('translit', { q: req.text, lang: req.lang, toScript: req.toScript, fromScript: req.fromScript || 'Latn' }),
    comprehend: (req) => call('read', { q: req.text, hint: req.hint || '' })
  }
}

/** The engine's wrong-script guard, reused (not copied) across the platform. */
export { scriptOk }
