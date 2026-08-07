/**
 * Deterministic baseline implementations of the AI Gateway ports.
 *
 * These are the honest floor: pure functions, no model calls, no API keys, no
 * network, fully deterministic for a given input. They exist so every port has
 * a working default that a provider adapter must BEAT on quality — never a
 * secret dependency, never a hard requirement. DPAS ch.05/06.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'is', 'it',
  'my', 'me', 'i', 'need', 'want', 'looking', 'can', 'someone', 'please',
  'with', 'this', 'that', 'have', 'has', 'get', 'got', 'do', 'does',
])

/** Verbs/nouns that signal the author is OFFERING rather than needing. */
const OFFER_MARKERS = ['offer', 'offering', 'provide', 'providing', 'sell', 'selling', 'available', 'i can', 'we can', 'for hire', 'services']

function tokenize (text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Deterministic keyword extraction: unique, non-stopword tokens, order-stable. */
function keywords (text) {
  const seen = new Set()
  const out = []
  for (const t of tokenize(text)) {
    if (STOPWORDS.has(t) || t.length < 2) continue
    if (!seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

/** @type {import('./ports.js').IntentPort} */
export const intentBaseline = {
  parse (text) {
    const lower = String(text).toLowerCase()
    const isOffer = OFFER_MARKERS.some((m) => lower.includes(m))
    const kw = keywords(text)
    // Confidence grows with evidence, saturating — deterministic, never 1.0.
    const confidence = Math.min(0.9, 0.3 + kw.length * 0.1)
    return {
      type: isOffer ? 'offer' : 'need',
      category: 'general',
      keywords: kw,
      confidence: Number(confidence.toFixed(4)),
    }
  },
  similarity (a, b) {
    const A = new Set(a?.keywords ?? [])
    const B = new Set(b?.keywords ?? [])
    if (A.size === 0 && B.size === 0) return 0
    let inter = 0
    for (const k of A) if (B.has(k)) inter++
    const union = A.size + B.size - inter
    return union === 0 ? 0 : Number((inter / union).toFixed(4))
  },
}

/** @type {import('./ports.js').SummaryPort} */
export const summaryBaseline = {
  summarize (text, opts = {}) {
    const maxChars = opts.maxChars ?? 160
    const clean = String(text).replace(/\s+/g, ' ').trim()
    if (clean.length <= maxChars) return clean
    // Extractive floor: first sentence if it fits, else a word-boundary cut.
    const firstSentence = clean.split(/(?<=[.!?])\s/)[0]
    if (firstSentence && firstSentence.length <= maxChars) return firstSentence
    const cut = clean.slice(0, maxChars)
    const lastSpace = cut.lastIndexOf(' ')
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
  },
}

/** @type {import('./ports.js').VoicePort} */
export const voiceBaseline = {
  // No model, no keys: an honest no-op that names itself as such. A real STT
  // adapter replaces this; until then it never pretends to have transcribed.
  transcribe () {
    return { text: '', engine: 'baseline-noop', confidence: 0 }
  },
  synthesize (text) {
    return { audio: null, engine: 'baseline-noop', text: String(text) }
  },
}
