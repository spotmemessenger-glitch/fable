/**
 * Spot Me — context-aware translation (design §8). Short Indic chat is the
 * traffic this app carries, and it is exactly the traffic where a word's meaning
 * depends on WHO is speaking and WHAT was just said: "varen" is a promise to come
 * only if you know the previous turn asked "are you coming?". The engine today
 * translates each message cold. This module assembles a BOUNDED, privacy-aware
 * context to disambiguate — and, critically, produces the fingerprint that keeps
 * one conversation's context out of another's cache (cache.js isolation).
 *
 * BOUNDED IS THE WHOLE POINT. An unbounded history is a privacy hazard (it ships
 * more plaintext to a provider than the current message needs) and a cost hazard
 * (more tokens, every call). The window is capped in BOTH turns and characters,
 * newest kept, oldest dropped — never "the whole thread".
 *
 * SIX INPUTS the design names:
 *   speaker labels        — who said each turn, so person markers resolve
 *   previous-turn hint    — the last turn's language, a strong prior
 *   glossary/proper-nouns — terms to keep verbatim (names, brands, project words)
 *   per-conversation prefs— a pinned source/target/formality for the thread
 *   truncation rules      — newest-first within the char budget
 *   privacy-aware select  — PII in the context tightens the provider set
 */
import { hash64 } from './cache.js'
import { classifyText, normalizeMode } from './privacy.js'

/** Context window defaults — bounded in turns AND characters. */
export const CONTEXT_DEFAULTS = Object.freeze({
  maxTurns: 6, // at most six prior turns ever
  maxChars: 800 // and at most ~800 chars of them, newest first
})

/**
 * A bounded conversation window. `add()` appends a turn and drops the oldest once
 * the turn cap is exceeded; the char cap is applied at build time (a single long
 * turn should not be silently discarded on the way in, only truncated on the way
 * out). A turn is `{ speaker, text, lang? }`.
 */
export function createContextWindow (opts = {}) {
  const cfg = { ...CONTEXT_DEFAULTS, ...opts }
  const turns = []
  return {
    add (turn) {
      if (!turn || typeof turn.text !== 'string') return this
      turns.push({ speaker: String(turn.speaker || 'unknown'), text: turn.text, lang: turn.lang || null })
      while (turns.length > cfg.maxTurns) turns.shift()
      return this
    },
    turns () { return turns.map((t) => ({ ...t })) },
    get size () { return turns.length },
    clear () { turns.length = 0; return this },
    _cfg: cfg
  }
}

/**
 * Newest-first truncation within a character budget. Returns the suffix of turns
 * (in original order) whose combined text fits `maxChars`, always keeping at
 * least the single most recent turn even if it alone exceeds the budget (in which
 * case its text is clipped). Deterministic; no allocation surprises.
 */
export function truncateTurns (turns, maxChars = CONTEXT_DEFAULTS.maxChars) {
  const list = Array.isArray(turns) ? turns : []
  if (!list.length) return []
  const kept = []
  let budget = Math.max(0, maxChars)
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]
    const len = String(t.text || '').length
    if (kept.length === 0 && len > budget) {
      kept.unshift({ ...t, text: String(t.text).slice(0, budget), truncated: true })
      break
    }
    if (len > budget) break
    budget -= len
    kept.unshift({ ...t })
  }
  return kept
}

/** Which glossary terms actually appear in the text (case-insensitive, whole-ish). */
export function glossaryHits (text, glossary = []) {
  const s = String(text || '')
  const hits = []
  for (const term of glossary) {
    const t = String(term || '').trim()
    if (t && s.toLowerCase().includes(t.toLowerCase())) hits.push(t)
  }
  return hits
}

/**
 * Assemble the context for translating `text` against a window + options.
 * Returns a plain, serialisable object PLUS a `fingerprint` for the cache key.
 * `privacyMode` is computed privacy-aware: PII in the current text or the recent
 * context raises the floor to `sensitive`, and a per-conversation `privacyMode`
 * pref can force `strict` — the mode only ever tightens here, never loosens.
 *
 * @param {string} text                          the message being translated
 * @param {object} window                        a createContextWindow() instance (or {turns()})
 * @param {{glossary?: string[], prefs?: object, maxChars?: number}} [opts]
 */
export function buildContext (text, window, opts = {}) {
  const cfg = window && window._cfg ? window._cfg : CONTEXT_DEFAULTS
  const allTurns = window && typeof window.turns === 'function' ? window.turns() : []
  const recent = truncateTurns(allTurns, opts.maxChars || cfg.maxChars)
  const speakers = [...new Set(recent.map((t) => t.speaker))]
  const previousTurn = allTurns.length ? allTurns[allTurns.length - 1] : null
  const previousLang = previousTurn ? previousTurn.lang : null
  const glossary = Array.isArray(opts.glossary) ? opts.glossary : []
  const glossaryTerms = glossaryHits(text, glossary)
  const prefs = opts.prefs || {}

  // Privacy-aware: does the current message OR the retained context carry PII?
  const currentPII = classifyText(text)
  const contextPII = recent.some((t) => classifyText(t.text).pii)
  let privacyMode = normalizeMode(prefs.privacyMode)
  if ((currentPII.pii || contextPII) && privacyMode === 'standard') privacyMode = 'sensitive'

  const context = {
    speakers,
    recentTurns: recent,
    previousLang,
    glossary: glossaryTerms,
    prefs: { sourceLang: prefs.sourceLang || null, targetLang: prefs.targetLang || null, formality: prefs.formality || null },
    privacyMode,
    hasPII: currentPII.pii || contextPII,
    turnCount: recent.length
  }
  context.fingerprint = contextFingerprint(context)
  return context
}

/**
 * A stable fingerprint of a context, for the cache key. It folds in the shape of
 * the conversation — speakers, glossary, prefs, previous language, and a hash of
 * the recent turn TEXT — so two conversations with different histories fingerprint
 * differently and cannot share a cache entry. It is a hash, so no raw context
 * text is exposed; and it is deterministic, so the same context always keys the
 * same way. An empty context fingerprints to a fixed `none` sentinel, so a
 * context-free translation still caches (against other context-free ones only).
 */
export function contextFingerprint (context = {}) {
  const recent = Array.isArray(context.recentTurns) ? context.recentTurns : []
  if (!recent.length && !(context.glossary || []).length &&
      !context.previousLang && !context.prefs?.sourceLang && !context.prefs?.targetLang) {
    // No disambiguating context at all — a shared, safe sentinel.
    return `none|${context.privacyMode || 'standard'}`
  }
  const material = JSON.stringify({
    s: context.speakers || [],
    p: context.previousLang || null,
    g: context.glossary || [],
    f: context.prefs || {},
    m: context.privacyMode || 'standard',
    t: recent.map((r) => `${r.speaker}:${r.text}`)
  })
  return hash64(material)
}
