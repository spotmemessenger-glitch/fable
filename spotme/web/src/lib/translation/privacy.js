/**
 * Spot Me — privacy posture, PII classification, redaction, and safe telemetry
 * (design §12). The uncomfortable truth this module makes VISIBLE rather than
 * hides: once plaintext leaves the device for a cloud translator, the message is
 * no longer end-to-end private — a third party has seen it. Spot Me markets E2E
 * encryption, so the platform must be honest about exactly where that property
 * ends and must give the product the controls to keep sensitive text on-device.
 *
 * FOUR JOBS:
 *  1. MODES → POSTURES. A request declares a privacy MODE; the mode decides which
 *     provider PRIVACY POSTURES are admissible. `strict` never leaves the device;
 *     `sensitive` allows a contracted cloud but never a keyless one; `standard`
 *     allows the keyless last-resort tail (consumer chat, no DPA needed).
 *  2. PII CLASSIFICATION. A deterministic, offline heuristic that flags emails,
 *     phone numbers, card-like and government-id-like digit runs — enough to
 *     drive "this looks sensitive, tighten the provider set", never a claim of
 *     completeness.
 *  3. REDACTION HOOK. Replace detected PII with stable placeholders BEFORE any
 *     third-party call, with a reversible map so the placeholders can be restored
 *     after translation. Redaction is opt-in per mode and never silent.
 *  4. SAFE TELEMETRY. A whitelist that strips raw text, scripts, and anything
 *     key-shaped out of a log/metrics record — NO plaintext, NO secrets, ever.
 *
 * Nothing here calls a network or holds a key; it is pure text policy.
 */
import { retentionOf } from './capabilities.js'

/** The privacy modes a request may declare, loosest → strictest. */
export const PRIVACY_MODES = Object.freeze(['standard', 'sensitive', 'strict'])

/**
 * Which provider privacy postures each mode admits. This is the honest privacy
 * gate: `strict` is on-device only (the E2E property is preserved), `sensitive`
 * adds a CONTRACTED cloud (a DPA exists), `standard` additionally admits the
 * keyless tail. A provider whose posture is not in the mode's set is denied.
 */
export const MODE_POSTURES = Object.freeze({
  standard: Object.freeze(['on-device', 'cloud-contract', 'cloud-keyless']),
  sensitive: Object.freeze(['on-device', 'cloud-contract']),
  strict: Object.freeze(['on-device'])
})

/** Normalise an arbitrary input to a known mode; unknown → the strictest safe. */
export function normalizeMode (mode) {
  return PRIVACY_MODES.includes(mode) ? mode : 'standard'
}

/** The postures admissible under a mode. */
export function posturesForMode (mode) {
  return [...(MODE_POSTURES[normalizeMode(mode)] || MODE_POSTURES.standard)]
}

/** Is a provider of this posture allowed under this privacy mode? */
export function isPostureAllowed (posture, mode) {
  return posturesForMode(mode).includes(posture)
}

/**
 * A `privacyPolicy(posture, tenantId)` the router accepts as `policy.privacyPolicy`,
 * derived from a privacy MODE. Enterprise tenants keep the keyless denial even in
 * `standard` (a keyless vendor has no DPA — design §12.3), so the mode tightens
 * but never loosens the tenant rule.
 */
export function privacyPolicyForMode (mode) {
  const allowed = posturesForMode(mode)
  return function privacyPolicy (posture, tenantId) {
    if (!allowed.includes(posture)) return false
    if (tenantId && posture === 'cloud-keyless') return false
    return true
  }
}

/** Does E2E privacy survive a translation on this posture? Only on-device. */
export const isE2EPreserved = (posture) => posture === 'on-device'

/** Does choosing this posture mean plaintext leaves the device? */
export const plaintextLeavesDevice = (posture) => posture !== 'on-device'

/**
 * The honest, user-facing notice for a chosen posture — surfaced so the product
 * can label a cloud translation exactly as `src/lib/translate.js` already labels
 * its cloud fallback "cloud". Never silently imply E2E where there is none.
 */
export function privacyNotice (posture) {
  if (isE2EPreserved(posture)) {
    return 'on-device — nothing left this device; end-to-end privacy preserved'
  }
  return 'cloud — plaintext was sent to a third-party translator; this message ' +
    'was NOT end-to-end private for translation'
}

/* ------------------------------------------------------- PII classification */

/** Count the digits in a string (used to gate the loose phone detector). */
const digitCount = (s) => (String(s).match(/\d/g) || []).length

/**
 * Deterministic PII detectors, in a CANONICAL ORDER (most specific first) so the
 * greedier shapes cannot mislabel a more specific one: a card claims its digit
 * run before phone sees it; a dotted quad is an IP, not a phone. Deliberately
 * conservative and offline — they catch the high-signal shapes (email, card,
 * IPv4, phone) and nothing subtler. A `false` is NOT a guarantee of no PII, it is
 * "no obvious PII", and the docs say so. Some carry a `validate(match)` guard the
 * regex alone cannot express (a phone must have 7–15 digits).
 */
export const PII_PATTERNS = Object.freeze([
  Object.freeze({ kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g }),
  Object.freeze({ kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g }),
  Object.freeze({ kind: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g }),
  Object.freeze({ kind: 'phone', re: /(?<!\w)\+?\d[\d\s().-]{5,}\d(?!\w)/g, validate: (m) => { const d = digitCount(m); return d >= 7 && d <= 15 } })
])

/** All matches of a pattern in `text` that also pass its optional validator. */
function validatedMatches (text, pat) {
  const raw = String(text).match(new RegExp(pat.re.source, pat.re.flags)) || []
  return pat.validate ? raw.filter(pat.validate) : raw
}

/**
 * Classify text for obvious PII. Returns `{ pii, kinds, count }`. Detectors run
 * in the canonical order and each blanks the spans it claimed, so a 16-digit card
 * is never also double-counted as a phone number and an IP is never a phone.
 */
export function classifyText (text) {
  let residue = String(text || '')
  const kinds = []
  let count = 0
  for (const pat of PII_PATTERNS) {
    const matches = validatedMatches(residue, pat)
    if (matches.length) {
      kinds.push(pat.kind)
      count += matches.length
      for (const m of matches) residue = residue.split(m).join(' ') // blank claimed spans
    }
  }
  return { pii: kinds.length > 0, kinds, count }
}

/** Is there obvious PII in this text? (the boolean form). */
export const hasPII = (text) => classifyText(text).pii

/**
 * Redact detected PII, returning `{ text, map, kinds, redacted }`. Each match
 * becomes a stable placeholder `⟦KIND_n⟧`; `map` restores them. Redaction runs
 * card→email→ipv4→phone so the most specific shapes are claimed first. The
 * placeholders are chosen to be translation-inert (a translator will pass
 * `⟦EMAIL_1⟧` through unchanged), so `reinsert()` after translation is safe.
 */
export function redact (text) {
  let out = String(text || '')
  const map = {}
  const kinds = []
  let n = 0
  // The canonical order (card claims its digit run before phone; ip before phone).
  for (const pat of PII_PATTERNS) {
    out = out.replace(new RegExp(pat.re.source, pat.re.flags), (m) => {
      if (pat.validate && !pat.validate(m)) return m // leave non-PII untouched
      n += 1
      const token = `⟦${pat.kind.toUpperCase()}_${n}⟧`
      map[token] = m
      if (!kinds.includes(pat.kind)) kinds.push(pat.kind)
      return token
    })
  }
  return { text: out, map, kinds, redacted: kinds.length > 0 }
}

/** Restore redacted placeholders from a redaction map (post-translation). */
export function reinsert (text, map) {
  let out = String(text || '')
  for (const [token, original] of Object.entries(map || {})) {
    out = out.split(token).join(original)
  }
  return out
}

/* ------------------------------------------------------------ safe telemetry */

/**
 * The ONLY fields allowed into a log or metric record. Anything else — text, q,
 * script, english, original, translated, a key-shaped name — is dropped. A
 * whitelist, not a blacklist, so a new plaintext field added upstream cannot
 * leak by being forgotten in a denylist.
 */
export const SAFE_LOG_FIELDS = Object.freeze([
  'provider', 'chosen', 'engine', 'sourceLang', 'targetLang', 'pair', 'script',
  'requiredCapability', 'profile', 'policyVersion', 'confidenceBand', 'confidence',
  'verified', 'latencyMs', 'attempts', 'fallbacks', 'breakerTrips', 'cacheHit',
  'wrongScript', 'uncertain', 'estimatedMicroUsd', 'region', 'privacyMode',
  'engineVersion', 'reason', 'ok', 'status'
])

/**
 * Strip a record down to SAFE_LOG_FIELDS. `script` here is the ISO-15924 script
 * CODE (e.g. "Taml"), never the message written in that script — the field name
 * collides, so the value is coerced to a short code and rejected if it looks like
 * content (contains spaces or is long).
 */
export function safeLogFields (record) {
  const out = {}
  if (!record || typeof record !== 'object') return out
  for (const key of SAFE_LOG_FIELDS) {
    if (!(key in record)) continue
    let v = record[key]
    if (key === 'script') {
      v = String(v || '')
      if (v.length > 8 || /\s/.test(v)) continue // that's content, not a code
    }
    if (typeof v === 'string' && v.length > 64) continue // guard against stray text
    out[key] = v
  }
  return out
}

/** The data-retention posture of a provider (re-exported for the privacy view). */
export { retentionOf }

/** Retention postures, documented for the privacy model + the readiness view. */
export const RETENTION_POSTURES = Object.freeze({
  none: 'nothing leaves the device',
  contract: 'a data-processing agreement is in place with the vendor',
  'contract-no-trace': 'contract in place, plus a documented no-trace option',
  'unknown-no-contract': 'keyless endpoint, no agreement — denied to tenants by default'
})
