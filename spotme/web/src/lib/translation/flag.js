/**
 * Spot Me — the single switch for the V2 translation platform. DEFAULT OFF.
 *
 * WHY A FLAG THAT NOTHING READS YET. This whole module (a provider interface, a
 * scored router, a circuit breaker, confidence scoring, provider adapters) is
 * built additively ALONGSIDE the shipped engine in `api/translate.js`, not in
 * place of it. The live translate path — `src/lib/translate.js` on the client,
 * `api/translate.js` on the server — is untouched and keeps serving every
 * request exactly as before. Until the owner turns this on, the correct state
 * is "built, exercised by the suite, and unreachable from the app" (mirrors
 * `test/signing-not-shipped.test.js`). The flag is the eventual on-switch; the
 * structural guarantee — no app module imports this one — is the real fence,
 * proved by `test/translation-v2-not-shipped.test.js`.
 *
 * OFF MEANS OFF. There is exactly one way to turn it on and it must be
 * deliberate: the server env `TRANSLATION_V2_ENABLED=true`, or an explicit
 * `globalThis.__SPOTME_TRANSLATION_V2__ = true` (the seam the suite uses to
 * exercise the enabled branch and then reset). Anything else — unset, empty,
 * "false", "1", "yes", any object — reads as OFF. There is no default-on path
 * and no way for a truthy-but-not-exactly-true value to flip it.
 */

/** The environment variable that gates the platform on the server. */
export const TRANSLATION_V2_FLAG = 'TRANSLATION_V2_ENABLED'

/** The global override, honoured first so a browser/test can flip it. */
export const TRANSLATION_V2_GLOBAL = '__SPOTME_TRANSLATION_V2__'

/**
 * Is the V2 translation platform enabled? Default false.
 *
 * The global override wins when it is EXACTLY `true` or `false` (so a test can
 * force either state); otherwise the server env is consulted, and only the
 * exact string "true" counts. Every other input — including a truthy object or
 * the string "1" — is OFF, on purpose: a feature that spends vendor credit and
 * routes plaintext must never switch on by accident.
 */
export function isTranslationV2Enabled () {
  const override = globalThis?.[TRANSLATION_V2_GLOBAL]
  if (override === true) return true
  if (override === false) return false
  try {
    if (typeof process !== 'undefined' && process?.env?.[TRANSLATION_V2_FLAG] === 'true') {
      return true
    }
  } catch { /* no process (browser) — fall through to OFF */ }
  return false
}
