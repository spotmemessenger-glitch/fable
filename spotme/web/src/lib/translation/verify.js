/**
 * Spot Me — cross-provider consensus, adjudication, and honest uncertainty
 * (design §6.3–6.5). The engine already does most of this inside
 * `confirmedTranslate()`; this module extracts the SHAPE of it — agreement, a
 * gated judge, and an explicit "we are not sure" — so the platform can reason
 * about confidence as data instead of a buried branch, and so it never invents a
 * number a provider did not earn.
 *
 * THE LADDER, strongest rung first (design §6.3):
 *   agree        two independent engines land on the same words → confirmed
 *   adjudicated  they differ, a judge that read both + the original picked → mid
 *   single       only one engine survived the wrong-script gate → low-but-usable
 *   uncertain    nothing survived, or a disagreement no judge resolved → SAY SO
 *
 * CONFIDENCE IS DERIVED, NOT FABRICATED. The number comes from the VERIFICATION
 * OUTCOME — a measured fact ("did two engines agree?") mapped through the
 * confidence taxonomy — never from thin air and never asserted on a provider that
 * supplied none. When nothing meets the acceptance threshold, the result is
 * explicitly `{ uncertain: true }` with a low band, not a confident-looking guess.
 *
 * ADJUDICATION IS GATED AND COSTED. It is an extra vendor call and a fan-out, so
 * it only runs when the caller passes an adjudicator AND records the reason
 * (cost.js enforces the budget). A judge is an improvement, never a dependency.
 */
import { confidenceFor, classifyConfidence } from './confidence.js'
import { scriptOk as engineScriptOk } from './detect.js'

/** The lowest confidence the platform will serve WITHOUT flagging uncertainty. */
export const ACCEPT_THRESHOLD = 0.50 // the 'single' band floor

/**
 * Normalise two translations to their meaning-bearing characters before
 * comparing — the same idea the engine's private `agree()` encodes: engines
 * differ on a trailing danda, a zero-width joiner, or ஒரு vs ஓர் in ways a reader
 * would never notice, and treating those as disagreement sends everything to a
 * judge for nothing. Reimplemented here (the engine's is not exported) as a pure
 * text utility — no provider logic, no key.
 */
export function normalizeForAgreement (s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s‌‍]+/g, '') // whitespace + zero-width joiners
    .replace(/[.,!?;:'"()।]/g, '') // punctuation incl. the danda ।
}

/** Do two translations agree on meaning-bearing characters? (non-empty). */
export function agree (a, b) {
  const na = normalizeForAgreement(a)
  return na.length > 0 && na === normalizeForAgreement(b)
}

/**
 * Compute consensus over a set of candidate results for one target language.
 * Each candidate is `{ text, engine|provider }`. Wrong-script candidates are
 * dropped FIRST (the engine's own scriptOk, injectable for tests), because a
 * wrong-script answer is not a weak translation — it is not a translation.
 *
 * Returns `{ outcome, text, provider, survivors, disagreement }`:
 *   'agree'    — ≥2 survivors and the top two agree
 *   'single'   — exactly one survivor
 *   'disagree' — ≥2 survivors that do not agree (candidate for adjudication)
 *   'none'     — no survivor passed the script gate
 */
export function consensus (candidates, target, opts = {}) {
  const scriptOk = opts.scriptOk || engineScriptOk
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
  const survivors = list.filter((c) => scriptOk(c.text, target))
  const wrongScript = list.length - survivors.length

  if (survivors.length === 0) {
    return { outcome: 'none', text: null, provider: null, survivors: [], wrongScript, disagreement: false }
  }
  if (survivors.length === 1) {
    const only = survivors[0]
    return { outcome: 'single', text: only.text, provider: only.engine || only.provider || null, survivors, wrongScript, disagreement: false }
  }
  const [a, b] = survivors
  if (agree(a.text, b.text)) {
    return { outcome: 'agree', text: b.text, provider: `${b.engine || b.provider}+${a.engine || a.provider}`, survivors, wrongScript, disagreement: false }
  }
  return { outcome: 'disagree', text: null, provider: null, survivors, wrongScript, disagreement: true }
}

/**
 * Adjudicate a disagreement with an injected judge. The judge is a provider
 * exposing `adjudicate({ text, target, a, b, exclude })`; the pipeline supplies
 * one only when the adjudication flag is ON and the cost governor granted the
 * fan-out. A verdict is accepted only if it passes the SAME wrong-script gate —
 * a judge that answers in the wrong script has guessed, not judged. Returns the
 * winning result or null (fall back to the specialist, never error).
 *
 * @param {{text:string, target:string, a:object, b:object}} req
 * @param {{adjudicator: object, scriptOk?: Function}} deps
 */
export async function adjudicate (req, deps = {}) {
  const judge = deps.adjudicator
  const scriptOk = deps.scriptOk || engineScriptOk
  if (!judge || typeof judge.adjudicate !== 'function') return null
  try {
    const out = await judge.adjudicate({
      text: req.text, target: req.target,
      a: req.a?.text ?? req.a, b: req.b?.text ?? req.b
    })
    const text = String(out?.text || '').trim()
    if (text && scriptOk(text, req.target)) {
      return { text, judge: judge.id || out?.judge || 'judge', pick: out?.pick || '', outcome: 'adjudicated' }
    }
  } catch { /* a failed judge is not a failed request */ }
  return null
}

/**
 * Map a verification outcome to a derived confidence + band. This is the ONLY
 * place a confidence number is minted, and it is minted from the OUTCOME, which
 * is a measured fact — not fabricated per provider.
 */
export function outcomeConfidence (outcome) {
  const kind = outcome === 'agree' ? 'agree'
    : outcome === 'adjudicated' ? 'adjudicated'
      : outcome === 'single' ? 'single'
        : 'none'
  const confidence = confidenceFor(kind)
  return { confidence, band: classifyConfidence(confidence), verified: outcome }
}

/**
 * The explicit "translation uncertain" result. Returned when nothing met the
 * acceptance threshold — no survivor, or an unresolved disagreement. It still
 * carries the best-effort text (so the UI can offer it, clearly flagged) but sets
 * `uncertain: true` and a low band, so the caller NEVER shows it as confirmed.
 * The cache refuses to store it (cache.set guards on `uncertain`).
 */
export function uncertainResult (reason, best = null, extra = {}) {
  const confidence = best ? confidenceFor('fallback') : confidenceFor('none')
  return {
    uncertain: true,
    text: best?.text ?? null,
    provider: best?.provider ?? best?.engine ?? null,
    confidence,
    confidenceBand: classifyConfidence(confidence),
    verified: 'none',
    reason: String(reason || 'no candidate met the confidence threshold'),
    ...extra
  }
}

/**
 * Resolve a set of candidate results into a final verdict, running the ladder:
 * consensus → (optional) adjudication → accept-or-uncertain. Pure orchestration;
 * the network (the judge) is injected and only consulted when `allowAdjudication`
 * is true and an `adjudicator` is supplied. Returns a result object with a
 * DERIVED confidence, or an explicit uncertain result.
 *
 * @param {Array<{text:string, engine?:string, provider?:string}>} candidates
 * @param {string} target
 * @param {{ original?: string, allowAdjudication?: boolean, adjudicator?: object,
 *           scriptOk?: Function, onFanout?: (reason:string)=>boolean }} [opts]
 */
export async function resolve (candidates, target, opts = {}) {
  const con = consensus(candidates, target, opts)

  if (con.outcome === 'agree' || con.outcome === 'single') {
    const conf = outcomeConfidence(con.outcome)
    // 'single' sits exactly at the threshold — usable, but the lowest we serve
    // without a flag; anything below is uncertain by construction.
    return { text: con.text, provider: con.provider, ...conf, uncertain: conf.confidence < ACCEPT_THRESHOLD, survivors: con.survivors.length }
  }

  if (con.outcome === 'disagree') {
    const [a, b] = con.survivors
    if (opts.allowAdjudication && opts.adjudicator) {
      // Fan-out must be permitted AND reasoned (cost.js). onFanout returns false
      // if the budget is spent — in which case we do NOT call the judge.
      const reason = `adjudicate disagreement ${a.engine || a.provider} vs ${b.engine || b.provider} for ${target}`
      const permitted = typeof opts.onFanout === 'function' ? opts.onFanout(reason) : true
      if (permitted) {
        const verdict = await adjudicate({ text: opts.original ?? '', target, a, b }, opts)
        if (verdict) {
          const conf = outcomeConfidence('adjudicated')
          return { text: verdict.text, provider: `${b.engine || b.provider}+${a.engine || a.provider}/${verdict.judge}`, ...conf, uncertain: false, alternative: a.text, survivors: con.survivors.length }
        }
      }
    }
    // Unjudged disagreement: prefer the specialist (first survivor) but SAY it is
    // uncertain and hand back the alternative — never a confident guess.
    return uncertainResult('engines differ, unjudged', { text: a.text, provider: a.engine || a.provider }, { alternative: b.text, survivors: con.survivors.length })
  }

  // outcome 'none' — nothing survived the script gate.
  return uncertainResult(con.wrongScript ? 'all candidates were the wrong script' : 'no candidate produced text', null, { wrongScript: con.wrongScript })
}
