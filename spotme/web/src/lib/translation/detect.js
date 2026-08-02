/**
 * Spot Me — the language & script detection pipeline shim (design §7).
 *
 * ORDER IS LOAD-BEARING. The deterministic guards must run BEFORE any model
 * gets an opinion, or plain English becomes romanized Kannada — the real
 * incident that `src/lib/english.js` documents. So this pipeline reproduces the
 * design's ordered steps, cheapest and most certain first:
 *
 *   1. ENGLISH GUARD   deterministic, no network — reuses isPlainEnglish()
 *   2. SCRIPT DETECT   deterministic, no network — which Indic block, if any
 *   3. NON-LATIN SHORTCUT   an Indic script is decisive on its own; no detect
 *   4. PROVIDER DETECT  network, ONLY when still ambiguous (romanized→English);
 *                       injected, so this file stays pure and offline-testable
 *   5. ROUTE            hand the decision to the router
 *
 * REUSE, NOT REBUILD. The wrong-script gate is the engine's own `scriptOk`,
 * imported from `api/translate.js` — the same arithmetic that guards every
 * translation path today, not a second copy that could drift. The English guard
 * is `english.js`, unchanged. Only the script-BLOCK identification (which of the
 * Indic blocks a string is in) is added here, as platform data — the design
 * calls script detection "provider-independent and free", and it is the
 * platform's cheapest guard.
 *
 * This module imports `scriptOk` at load time; `api/translate.js` is
 * side-effect-free at module scope (its keys are read per-call), so importing it
 * for the guard costs nothing and starts nothing.
 */
import { scriptOk } from '../../../api/translate.js'
import { isPlainEnglish, englishScore, wordCount } from '../english.js'

/**
 * ISO-15924 block identification — platform data. Ordered so the first match
 * wins; the Indic blocks mirror the engine's TARGET_BLOCK ranges exactly so the
 * two guards never disagree about which script a string is in.
 */
export const SCRIPT_BLOCKS = Object.freeze([
  Object.freeze({ script: 'Deva', re: /[ऀ-ॿ]/ }),
  Object.freeze({ script: 'Beng', re: /[ঀ-৿]/ }),
  Object.freeze({ script: 'Guru', re: /[਀-੿]/ }),
  Object.freeze({ script: 'Gujr', re: /[઀-૿]/ }),
  Object.freeze({ script: 'Orya', re: /[଀-୿]/ }),
  Object.freeze({ script: 'Taml', re: /[஀-௿]/ }),
  Object.freeze({ script: 'Telu', re: /[ఀ-౿]/ }),
  Object.freeze({ script: 'Knda', re: /[ಀ-೿]/ }),
  Object.freeze({ script: 'Mlym', re: /[ഀ-ൿ]/ }),
  Object.freeze({ script: 'Sinh', re: /[඀-෿]/ }),
  Object.freeze({ script: 'Arab', re: /[؀-ۿ]/ }),
  Object.freeze({ script: 'Cyrl', re: /[Ѐ-ӿ]/ }),
  Object.freeze({ script: 'Hani', re: /[一-鿿]/ }),
  Object.freeze({ script: 'Kana', re: /[぀-ヿ]/ }),
  Object.freeze({ script: 'Latn', re: /[A-Za-z]/ })
])

/** Devanagari through Sinhala — the same span the engine's ANY_INDIC covers. */
export const ANY_INDIC = /[ऀ-෿]/

/** Is there any Indic-script character at all? (design step 3 shortcut). */
export function hasIndicScript (text) {
  return ANY_INDIC.test(String(text || ''))
}

/**
 * Which script is this text written in? Deterministic, local, sync — the
 * interface's `detectScript`. Returns `{ script, confident }`. `confident` is
 * false for input with no letters to judge (emoji/digits/punct only).
 */
export function detectScript (text) {
  const s = String(text || '')
  const hasLetters = /\p{L}/u.test(s)
  for (const block of SCRIPT_BLOCKS) {
    if (block.re.test(s)) {
      return { script: block.script, confident: hasLetters }
    }
  }
  return { script: 'Zyyy', confident: false } // Zyyy = undetermined (ISO-15924)
}

/** The English guard, reused unchanged from english.js. */
export function englishGuard (text) {
  return isPlainEnglish(text)
}

/**
 * Run the detection pipeline for a request. Local steps are pure and offline;
 * the network step (provider detect) is injected as `providerDetect` and only
 * consulted when the input is genuinely ambiguous — romanized Indic typed in
 * Latin letters with no declared source and an English target, which is most of
 * this app's reading traffic and the one case with no local signal.
 *
 * Returns a decision object; `stage` names which step decided it, so the router
 * (and the tests) can see the pipeline actually short-circuits in order.
 *
 * @param {string} text
 * @param {{sourceLang?: string, targetLang?: string,
 *          providerDetect?: (t: string) => Promise<{language: string, score?: number}|null>}} opts
 */
export async function runDetectionPipeline (text, opts = {}) {
  const q = String(text || '')
  const declared = opts.sourceLang ? String(opts.sourceLang) : null
  const target = String(opts.targetLang || '')
  const base = (c) => String(c || '').toLowerCase().split('-')[0]

  // 1. ENGLISH GUARD — if it is obviously English, nothing downstream may argue.
  if (englishGuard(q)) {
    return { stage: 'english', lang: 'en', script: 'Latn', romanized: false, needsProviderDetect: false, stop: true }
  }

  // 2 + 3. SCRIPT DETECT and the NON-LATIN SHORTCUT — an Indic script is
  // decisive on its own; no detect call is needed or made.
  const { script } = detectScript(q)
  if (hasIndicScript(q)) {
    return { stage: 'script', lang: null, script, romanized: false, needsProviderDetect: false, stop: true }
  }

  // A declared non-English source, or a non-English target, already decides it
  // (the engine's own gating): no ambiguity, no network.
  if (declared && base(declared) !== 'en') {
    return { stage: 'declared', lang: base(declared), script: 'Latn', romanized: false, needsProviderDetect: false, stop: true }
  }
  if (target && base(target) !== 'en') {
    return { stage: 'target', lang: null, script, romanized: false, needsProviderDetect: false, stop: true }
  }

  // Emoji/digits-only has no language to detect — never pay for a detect call.
  if (!/\p{L}/u.test(q)) {
    return { stage: 'no-language', lang: null, script: 'Zyyy', romanized: false, needsProviderDetect: false, stop: true }
  }

  // 4. PROVIDER DETECT — the ambiguous romanized→English case. Injected; if no
  // detector is supplied the pipeline reports it needs one rather than guessing.
  if (typeof opts.providerDetect !== 'function') {
    return { stage: 'ambiguous', lang: null, script: 'Latn', romanized: null, needsProviderDetect: true, stop: false }
  }
  let hit = null
  try { hit = await opts.providerDetect(q) } catch { hit = null }
  if (hit && hit.language) {
    const code = String(hit.language)
    return {
      stage: 'provider',
      lang: base(code),
      script: 'Latn',
      romanized: /-Latn$/i.test(code),
      score: hit.score ?? null,
      needsProviderDetect: false,
      stop: true
    }
  }
  // Detector said nothing — behave exactly as the engine does: fall through.
  return { stage: 'provider-empty', lang: null, script: 'Latn', romanized: null, needsProviderDetect: false, stop: false }
}

/**
 * The wrong-script verification gate — the engine's own `scriptOk`, re-exported
 * so every platform path uses the identical arithmetic and none reimplements it.
 */
export { scriptOk }

/** Re-exports for callers that want the raw English signals. */
export { englishScore, wordCount }
