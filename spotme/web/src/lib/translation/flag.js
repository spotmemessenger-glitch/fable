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

/* ------------------------------------------------------------------ layered */

/**
 * The strict reader every flag uses, factored out so the master and each
 * sub-capability share one rule: a global override wins ONLY when it is exactly
 * `true` or `false`; otherwise the env var counts ONLY when it is exactly the
 * string "true". Anything else — "1", "yes", an object, unset — is OFF. This is
 * the same discipline `isTranslationV2Enabled()` established; nothing truthy but
 * inexact may spend vendor credit or route plaintext.
 */
function readStrictFlag (envName, globalName) {
  const override = globalName ? globalThis?.[globalName] : undefined
  if (override === true) return true
  if (override === false) return false
  try {
    if (typeof process !== 'undefined' && process?.env?.[envName] === 'true') return true
  } catch { /* no process (browser) — OFF */ }
  return false
}

/** The canonical master switch for the completed platform (design §17.5). */
export const TRANSLATION_PLATFORM_V2_FLAG = 'TRANSLATION_PLATFORM_V2_ENABLED'
export const TRANSLATION_PLATFORM_V2_GLOBAL = '__SPOTME_TRANSLATION_PLATFORM_V2__'

/**
 * Is the platform (its enabled execution path) on? The master gate.
 *
 * BACKWARD COMPATIBLE: the original `TRANSLATION_V2_ENABLED` switch still turns
 * the platform on, so the not-shipped fence and any early shadow wiring keep
 * their meaning; the new `TRANSLATION_PLATFORM_V2_ENABLED` is the name the
 * rollout doc and the layered sub-flags hang off. Either enables the master.
 */
export function isPlatformV2Enabled () {
  if (isTranslationV2Enabled()) return true
  return readStrictFlag(TRANSLATION_PLATFORM_V2_FLAG, TRANSLATION_PLATFORM_V2_GLOBAL)
}

/**
 * The sub-capability flags. Each is LAYERED under the master: a sub-flag reads
 * true only when the master is on AND the sub-flag itself is on. You cannot get
 * cross-verification, adjudication fan-out, a plaintext cache or cost governance
 * without first, deliberately, enabling the platform — so a single stray env var
 * can never light up an expensive or privacy-sensitive path on its own.
 */
export const TRANSLATION_SUBFLAGS = Object.freeze({
  dynamicRouting: Object.freeze({ env: 'TRANSLATION_DYNAMIC_ROUTING_ENABLED', global: '__SPOTME_TRANSLATION_DYNAMIC_ROUTING__' }),
  crossVerify: Object.freeze({ env: 'TRANSLATION_CROSS_VERIFY_ENABLED', global: '__SPOTME_TRANSLATION_CROSS_VERIFY__' }),
  adjudication: Object.freeze({ env: 'TRANSLATION_ADJUDICATION_ENABLED', global: '__SPOTME_TRANSLATION_ADJUDICATION__' }),
  cache: Object.freeze({ env: 'TRANSLATION_CACHE_ENABLED', global: '__SPOTME_TRANSLATION_CACHE__' }),
  costGovernance: Object.freeze({ env: 'TRANSLATION_COST_GOVERNANCE_ENABLED', global: '__SPOTME_TRANSLATION_COST_GOVERNANCE__' })
})

/** A sub-capability is on only if the master is on AND its own flag is on. */
function subEnabled (key) {
  if (!isPlatformV2Enabled()) return false
  const f = TRANSLATION_SUBFLAGS[key]
  return f ? readStrictFlag(f.env, f.global) : false
}

/** Dynamic (scored) routing vs. the frozen legacy order. Layered under master. */
export const isDynamicRoutingEnabled = () => subEnabled('dynamicRouting')
/** Run a second engine and compare for consensus. Layered under master. */
export const isCrossVerifyEnabled = () => subEnabled('crossVerify')
/** Allow an LLM adjudication fan-out when engines disagree. Layered + costed. */
export const isAdjudicationEnabled = () => subEnabled('adjudication')
/** Consult the in-memory translation cache before a provider. Layered. */
export const isCacheEnabled = () => subEnabled('cache')
/** Enforce cost counters/ceilings before spending a provider call. Layered. */
export const isCostGovernanceEnabled = () => subEnabled('costGovernance')

/**
 * The whole flag state as data, for the readiness surface and the router's
 * legible decision — never any secret, only booleans.
 */
export function translationFlagSnapshot () {
  return {
    platformV2: isPlatformV2Enabled(),
    dynamicRouting: isDynamicRoutingEnabled(),
    crossVerify: isCrossVerifyEnabled(),
    adjudication: isAdjudicationEnabled(),
    cache: isCacheEnabled(),
    costGovernance: isCostGovernanceEnabled()
  }
}
