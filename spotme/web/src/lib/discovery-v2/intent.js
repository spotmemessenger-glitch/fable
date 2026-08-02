/**
 * Discovery V2 — structured query-intent interface (NO LLM).
 *
 * SCOPE, stated up front: this is an INTERFACE and a deterministic baseline
 * parser, not an assistant. There is no model call here, no network, no
 * conversational anything. It defines the stable shape a future intent
 * provider (rule-based, on-device, or otherwise) would fill in, and ships a
 * transparent keyword parser as the default so the seam is exercised rather
 * than merely declared.
 *
 * WHY A SEAM NOW. Search and ranking already speak a normalised query
 * ({text, category, filters}). Query-intent's only job is to turn a free-text
 * string into MORE of that same structured query — never into a place, a
 * recommendation, or a personalised result. It reads the text and nothing about
 * the person; there is no profile input and no personalisation.
 */
import { PLACE_CATEGORIES } from './contracts.js'

/**
 * The intent-provider contract. A provider is
 * `{ name, parse(text) → { category?, filters?, cleanedText? } }`. Synchronous,
 * pure, no I/O — deliberately, so intent can never become a latency or privacy
 * surface. Async/model-backed providers are explicitly out of scope here.
 *
 * @param {object} provider
 * @returns {boolean}
 */
export function isValidIntentProvider (provider) {
  return Boolean(provider) && typeof provider === 'object' &&
    typeof provider.name === 'string' && provider.name.trim().length > 0 &&
    typeof provider.parse === 'function'
}

// Transparent keyword → category map. A reviewer can read exactly what maps to
// what; there is no hidden classifier.
const CATEGORY_HINTS = Object.freeze({
  food: ['restaurant', 'food', 'eat', 'dinner', 'lunch', 'breakfast'],
  drink: ['bar', 'pub', 'drinks', 'brewery', 'wine'],
  cafe: ['cafe', 'coffee', 'espresso', 'tea'],
  shopping: ['shop', 'store', 'mall', 'market', 'grocery'],
  nightlife: ['club', 'nightlife', 'dance', 'dj'],
  outdoors: ['park', 'trail', 'hike', 'beach', 'outdoor'],
  culture: ['museum', 'gallery', 'theatre', 'theater', 'cinema', 'art'],
  services: ['atm', 'bank', 'pharmacy', 'clinic', 'salon', 'repair'],
  lodging: ['hotel', 'hostel', 'stay', 'lodging'],
  transport: ['station', 'metro', 'bus', 'taxi', 'airport']
})

const OPEN_NOW_HINTS = ['open now', 'open', 'right now']

/**
 * The default, deterministic intent parser. Pure keyword matching:
 *   - first category whose hint appears wins;
 *   - "open now"-style phrases set filters.openNow;
 *   - the matched hint words are stripped to leave a cleaner free-text query.
 *
 * @param {string} text
 * @returns {{category:string|null, filters:object, cleanedText:string}}
 */
export function baselineParse (text) {
  const raw = typeof text === 'string' ? text : ''
  const lower = raw.toLowerCase()
  let category = null
  for (const cat of Object.keys(CATEGORY_HINTS)) {
    if (!PLACE_CATEGORIES.includes(cat)) continue
    if (CATEGORY_HINTS[cat].some((w) => lower.includes(w))) { category = cat; break }
  }
  const filters = {}
  if (OPEN_NOW_HINTS.some((w) => lower.includes(w))) filters.openNow = true

  return { category, filters, cleanedText: raw.trim() }
}

/** The built-in provider wrapping the baseline parser. */
export const baselineIntentProvider = Object.freeze({
  name: 'baseline-keyword',
  parse: baselineParse
})

/**
 * Turn free text into structured intent using a provider (default: baseline).
 * Merges onto a base query WITHOUT overriding an explicit category the caller
 * already set — user intent stated directly always wins over inference.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.provider]
 * @param {object} [opts.baseQuery]  an existing normalised-ish query to enrich
 * @returns {{text:string, category:string|null, filters:object}}
 */
export function deriveIntent (text, opts = {}) {
  const provider = isValidIntentProvider(opts.provider) ? opts.provider : baselineIntentProvider
  const base = opts.baseQuery || {}
  let parsed
  try {
    parsed = provider.parse(text) || {}
  } catch {
    parsed = {} // a misbehaving provider degrades to "no enrichment", never throws up
  }
  const category = base.category ?? (PLACE_CATEGORIES.includes(parsed.category) ? parsed.category : null)
  const filters = { ...(parsed.filters || {}), ...(base.filters || {}) }
  const outText = typeof parsed.cleanedText === 'string' ? parsed.cleanedText : (base.text ?? (text || ''))
  return { text: outText, category, filters }
}
