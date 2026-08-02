/**
 * Spot Me — the provider capability matrix, as DATA (design §4).
 *
 * The whole point of the abstraction is that "which provider is good at what"
 * stops being branches in `handler()` and becomes a table the router scores
 * against. This file IS that table. Every row is exactly the design's §4 matrix
 * for one provider: what it can do, which languages/scripts, its measured
 * latency class, its cost class, and its privacy posture. Nothing here calls a
 * vendor or holds a key — it is a description, read by the scorer.
 *
 * `languagePairs` in the design is a function `(src,tgt) => fitness`. Storing a
 * function in a data table is awkward and untestable, so each row carries a
 * declarative `pairs` descriptor and `pairFitness()` computes the 0..1 number
 * from it. `providerCapabilities(id)` then hands back a normalised object whose
 * `languagePairs` closes over that descriptor — so the router sees the function
 * shape the interface promises, while the source of truth stays data.
 */

/** Languages the Indic specialist (Sarvam) actually speaks — from the engine's
 *  own SARVAM_LANGS table (api/translate.js). Anything outside this is not its
 *  problem and scores 0, exactly as the engine falls through to Google/Azure. */
export const SARVAM_LANGS = Object.freeze([
  'en', 'hi', 'bn', 'gu', 'kn', 'ml', 'mr', 'od', 'or', 'pa', 'ta', 'te'
])

/** The Indic bases the platform treats as first-class (§1.1). */
export const INDIC_LANGS = Object.freeze([
  'hi', 'mr', 'gom', 'ne', 'sa', 'bn', 'as', 'pa', 'gu', 'or', 'od',
  'ta', 'te', 'kn', 'tcy', 'ml', 'si'
])

/** The world majors every general engine handles well. */
const MAJOR_LANGS = Object.freeze(['en', 'es', 'fr', 'de', 'pt', 'ar', 'ja', 'zh', 'ru', 'ko'])

const base = (c) => String(c || '').toLowerCase().split('-')[0]
const isIndic = (c) => INDIC_LANGS.includes(base(c))

/**
 * Fitness of a provider for a src→tgt pair, 0..1, from its `pairs` descriptor.
 * 0 is a HARD gate in the router (an unsupported pair excludes the provider),
 * so this must return 0 — not a small number — for pairs a provider cannot do.
 */
export function pairFitness (pairs, src, tgt) {
  if (!pairs) return 0
  const s = base(src)
  const t = base(tgt)
  switch (pairs.kind) {
    case 'none':
      return 0
    case 'indic-specialist': {
      // Sarvam can only translate INTO a language it speaks, so the TARGET is
      // the gate — a French target scores 0 even from an English source. When
      // it does speak the target, reference quality if either side is Indic
      // (en→kn, ta→en), else the plain English↔en case at 0.7.
      const speaks = (c) => SARVAM_LANGS.includes(base(c))
      if (!speaks(t)) return 0
      const indicSide = isIndic(t) || (src && isIndic(s))
      return indicSide ? 1.0 : 0.7
    }
    case 'indic-reader': {
      // Gemini/LLM legs: broad, with a bonus on the romanized-Indic chat this
      // app lives on.
      if (isIndic(t) || (src && isIndic(s))) return 0.85
      return MAJOR_LANGS.includes(t) ? 0.75 : 0.65
    }
    case 'broad':
      return MAJOR_LANGS.includes(t) ? 0.75 : 0.6
    case 'subset': {
      // On-device model coverage. The engine's own rule: the on-device
      // translator NEEDS A KNOWN SOURCE (lib/translate.js) — it cannot detect —
      // so a request with no declared source scores 0 and gates out, which is
      // exactly why romanized→English must reach a cloud reader instead.
      const langs = pairs.langs || []
      return src && langs.includes(s) && langs.includes(t) ? 0.6 : 0
    }
    case 'translit-only':
      // Transliteration engines don't translate — 0 fitness for the translate
      // capability; their value is exposed through the `transliterate` method.
      return isIndic(t) ? 0.8 : 0
    default:
      return 0
  }
}

/**
 * The matrix. One frozen row per provider — the design §4 table, verbatim in
 * spirit. `pairs` is the descriptor `pairFitness()` reads.
 */
export const PROVIDER_MATRIX = Object.freeze({
  device: {
    supports: ['translate'],
    scripts: ['Latn', 'Deva', 'Taml', 'Telu', 'Knda', 'Mlym'],
    streaming: false, qualityTier: 'general', latencyClass: 'realtime',
    costClass: 'free', privacy: 'on-device',
    rateLimit: { note: 'needs known source; downloadable != usable' },
    pairs: { kind: 'subset', langs: ['en', 'es', 'fr', 'de', 'pt', 'hi', 'ta'] }
  },
  google: {
    supports: ['translate', 'detect'],
    scripts: ['Latn', 'Deva', 'Beng', 'Taml', 'Telu', 'Knda', 'Mlym', 'Arab', 'Hans', 'Jpan', 'Cyrl'],
    streaming: false, qualityTier: 'high', latencyClass: 'fast',
    costClass: 'metered', privacy: 'cloud-contract',
    rateLimit: { note: 'vendor quota' },
    pairs: { kind: 'broad' }
  },
  azure: {
    supports: ['translate', 'detect', 'transliterate'],
    scripts: ['Latn', 'Deva', 'Beng', 'Taml', 'Telu', 'Knda', 'Mlym', 'Guru', 'Gujr', 'Orya', 'Arab'],
    streaming: false, qualityTier: 'high', latencyClass: 'fast',
    costClass: 'metered', privacy: 'cloud-contract',
    rateLimit: { rpm: 600, note: 'free tier ~10 rps -> 429 + wait' },
    pairs: { kind: 'broad' }
  },
  sarvam: {
    supports: ['translate', 'detect', 'transliterate'],
    scripts: ['Deva', 'Beng', 'Taml', 'Telu', 'Knda', 'Mlym', 'Guru', 'Gujr', 'Orya'],
    streaming: false, qualityTier: 'reference', latencyClass: 'medium',
    costClass: 'metered', privacy: 'cloud-contract',
    rateLimit: { note: 'api-subscription-key header only' },
    pairs: { kind: 'indic-specialist' }
  },
  gemini: {
    supports: ['translate', 'detect', 'comprehend', 'adjudicate'],
    scripts: ['Latn', 'Deva', 'Beng', 'Taml', 'Telu', 'Knda', 'Mlym'],
    streaming: true, qualityTier: 'high', latencyClass: 'medium',
    costClass: 'metered', privacy: 'cloud-contract',
    rateLimit: { note: '429 often = out of credit' },
    pairs: { kind: 'indic-reader' }
  },
  openai: {
    supports: ['comprehend', 'adjudicate'],
    scripts: ['Latn', 'Deva', 'Taml', 'Telu', 'Knda', 'Mlym'],
    streaming: true, qualityTier: 'high', latencyClass: 'slow',
    costClass: 'premium', privacy: 'cloud-contract',
    rateLimit: { note: 'key found rotated in field' },
    pairs: { kind: 'indic-reader' }
  },
  anthropic: {
    supports: ['comprehend', 'adjudicate'],
    scripts: ['Latn', 'Deva', 'Taml', 'Telu', 'Knda', 'Mlym'],
    streaming: true, qualityTier: 'high', latencyClass: 'slow',
    costClass: 'premium', privacy: 'cloud-contract',
    rateLimit: { note: 'unpinned alias on purpose' },
    pairs: { kind: 'indic-reader' }
  },
  'google-inputtools': {
    supports: ['transliterate'],
    scripts: ['Deva', 'Taml', 'Telu', 'Knda', 'Mlym', 'Beng', 'Guru', 'Gujr'],
    streaming: false, qualityTier: 'high', latencyClass: 'fast',
    costClass: 'free', privacy: 'cloud-keyless',
    rateLimit: { note: 'undocumented; every failure -> fall back to Azure' },
    pairs: { kind: 'translit-only' }
  },
  elevenlabs: {
    // Voice legs are declared for the ③ substrate (ADR-011), not executed by
    // the text platform. No text method is required for these (see types.js).
    supports: ['stt', 'tts', 'clone'],
    scripts: [],
    streaming: true, qualityTier: 'general', latencyClass: 'medium',
    costClass: 'metered', privacy: 'cloud-contract',
    rateLimit: { note: 'consent-bound clone' },
    pairs: { kind: 'none' }
  },
  gtx: {
    supports: ['translate', 'detect'],
    scripts: ['Latn', 'Deva', 'Taml', 'Telu', 'Knda', 'Mlym'],
    streaming: false, qualityTier: 'general', latencyClass: 'fast',
    costClass: 'free', privacy: 'cloud-keyless',
    rateLimit: { note: 'client-only fallback; roadmap §7: replace' },
    pairs: { kind: 'broad' }
  },
  mymemory: {
    supports: ['translate'],
    scripts: ['Latn', 'Deva', 'Taml', 'Telu', 'Knda', 'Mlym'],
    streaming: false, qualityTier: 'fallback', latencyClass: 'medium',
    costClass: 'free', privacy: 'cloud-keyless',
    rateLimit: { note: 'last resort; junk on some pairs' },
    pairs: { kind: 'broad' }
  }
})

/**
 * The economic + operational half of each provider row (design §4, extended for
 * the completed platform): a cost model, a data-retention posture, regional
 * availability, whether the provider accepts romanized (Latin-script) input of a
 * non-Latin language, whether it batches, and a max input size. Kept BESIDE the
 * matrix rather than inside each frozen row so the capability table above stays
 * readable; `providerCapabilities()` merges the two into one object.
 *
 * COSTS ARE ESTIMATES FOR GOVERNANCE, NOT BILLING. `microUsdPerUnit` is a public,
 * order-of-magnitude figure used to estimate a request's spend BEFORE it is made
 * and to enforce ceilings (cost.js). It carries no account, key or invoice, is
 * deliberately conservative, and every free provider is 0. RETENTION is the
 * honest posture, not a promise: `contract` = a data-processing agreement is
 * in place; `contract-no-trace` = contract plus a documented no-trace option;
 * `none` = nothing leaves the device; `unknown-no-contract` = a keyless endpoint
 * with no agreement, denied to enterprise tenants by default (privacy.js).
 */
export const PROVIDER_ECONOMICS = Object.freeze({
  device: { costModel: { unit: 'none', microUsdPerUnit: 0 }, retention: 'none', regions: ['on-device'], romanized: false, batch: false, maxInputChars: 5000 },
  google: { costModel: { unit: 'char', microUsdPerUnit: 0.02 }, retention: 'contract', regions: ['global'], romanized: true, batch: true, maxInputChars: 5000 },
  azure: { costModel: { unit: 'char', microUsdPerUnit: 0.01 }, retention: 'contract-no-trace', regions: ['global', 'eastus', 'westeurope', 'southeastasia'], romanized: true, batch: true, maxInputChars: 10000 },
  sarvam: { costModel: { unit: 'char', microUsdPerUnit: 0.03 }, retention: 'contract', regions: ['in'], romanized: true, batch: false, maxInputChars: 1000 },
  gemini: { costModel: { unit: 'token', microUsdPerUnit: 0.3 }, retention: 'contract', regions: ['global'], romanized: true, batch: false, maxInputChars: 8000 },
  openai: { costModel: { unit: 'token', microUsdPerUnit: 2.5 }, retention: 'contract', regions: ['global'], romanized: true, batch: false, maxInputChars: 8000 },
  anthropic: { costModel: { unit: 'token', microUsdPerUnit: 3.0 }, retention: 'contract', regions: ['global'], romanized: true, batch: false, maxInputChars: 8000 },
  'google-inputtools': { costModel: { unit: 'call', microUsdPerUnit: 0 }, retention: 'unknown-no-contract', regions: ['global'], romanized: true, batch: false, maxInputChars: 200 },
  elevenlabs: { costModel: { unit: 'call', microUsdPerUnit: 100 }, retention: 'contract', regions: ['global'], romanized: false, batch: false, maxInputChars: 5000 },
  gtx: { costModel: { unit: 'char', microUsdPerUnit: 0 }, retention: 'unknown-no-contract', regions: ['global'], romanized: true, batch: false, maxInputChars: 480 },
  mymemory: { costModel: { unit: 'char', microUsdPerUnit: 0 }, retention: 'unknown-no-contract', regions: ['global'], romanized: false, batch: false, maxInputChars: 480 }
})

/** The conservative default for a provider with no economics row of its own. */
export const DEFAULT_ECONOMICS = Object.freeze({
  costModel: { unit: 'none', microUsdPerUnit: 0 }, retention: 'unknown-no-contract',
  regions: ['global'], romanized: false, batch: false, maxInputChars: 1000
})

/** A fresh copy of a provider's economics (never the shared frozen object). */
export function providerEconomics (id) {
  const e = PROVIDER_ECONOMICS[id] || DEFAULT_ECONOMICS
  return {
    costModel: { ...e.costModel },
    retention: e.retention,
    regions: [...e.regions],
    romanized: e.romanized,
    batch: e.batch,
    maxInputChars: e.maxInputChars
  }
}

/** The per-unit cost model {unit, microUsdPerUnit} for a provider. */
export const costModelOf = (id) => providerEconomics(id).costModel
/** The data-retention posture string for a provider. */
export const retentionOf = (id) => providerEconomics(id).retention
/** The regions a provider is available in (for regional failover). */
export const regionsOf = (id) => providerEconomics(id).regions

/**
 * Normalised capabilities for a provider id — the shape the interface promises,
 * with a real `languagePairs(src,tgt)` function derived from the row's data, and
 * the economic/operational fields merged in. Returns null for an unknown id so a
 * caller cannot silently register a ghost.
 */
export function providerCapabilities (id) {
  const row = PROVIDER_MATRIX[id]
  if (!row) return null
  const pairs = row.pairs
  const econ = providerEconomics(id)
  return {
    supports: [...row.supports],
    scripts: [...row.scripts],
    streaming: row.streaming,
    qualityTier: row.qualityTier,
    latencyClass: row.latencyClass,
    costClass: row.costClass,
    privacy: row.privacy,
    rateLimit: { ...row.rateLimit },
    // Extended, operational half — merged from PROVIDER_ECONOMICS.
    costModel: econ.costModel,
    retention: econ.retention,
    regions: econ.regions,
    romanized: econ.romanized,
    batch: econ.batch,
    maxInputChars: econ.maxInputChars,
    languagePairs: (src, tgt) => pairFitness(pairs, src, tgt)
  }
}

/**
 * The matrix as a plain array of rows (the admin `?op=admin.providers` view).
 * Carries the extended columns too, but NEVER the `languagePairs` function or any
 * message content — this is a public description, safe to return to an admin.
 */
export function capabilityMatrixData () {
  return Object.keys(PROVIDER_MATRIX).map((id) => {
    const row = PROVIDER_MATRIX[id]
    const econ = providerEconomics(id)
    return {
      id,
      supports: [...row.supports],
      scripts: [...row.scripts],
      streaming: row.streaming,
      qualityTier: row.qualityTier,
      latencyClass: row.latencyClass,
      costClass: row.costClass,
      privacy: row.privacy,
      retention: econ.retention,
      regions: econ.regions,
      romanized: econ.romanized,
      batch: econ.batch,
      maxInputChars: econ.maxInputChars,
      costModel: econ.costModel
    }
  })
}
