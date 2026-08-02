/**
 * Spot Me — the N-way who-hears-what matrix. WS3 design §6, ADR-011b.
 *
 * For every speaker in a multilingual call: WHO hears WHAT, in WHICH
 * language, at WHAT cost. The two rules that make group translation
 * affordable and correct, straight from §6.3:
 *
 *   ONE STT PASS PER SPEAKER — audio is the same regardless of who listens;
 *   the transcript is computed once and shared by every fan-out leg.
 *   ONE MT+TTS LEG PER DISTINCT LISTEN-LANGUAGE among listeners ≠ speaker —
 *   a 5-person call where everyone wants English costs ONE translation, not
 *   four. Listeners whose language equals the speaker's SOURCE language get
 *   captions of the original only (nothing to translate); the speaker
 *   themselves gets nothing added (§6.2: "it's their own voice").
 *
 * This module is PURE DATA LOGIC — the real session fan-out (live-session.js
 * group mode) executes what this computes. The GROUP MEDIA transport (an SFU
 * / the LTMS media plane) is a declared dependency on the future group-call
 * infrastructure (roadmap Priority 5) and is NOT faked here: this matrix +
 * the group session logic are real and tested; moving actual group audio is
 * blocked on P5 and says so in the docs.
 *
 * The concurrency bound of §14.3 — active speakers × distinct target
 * languages is THE cost driver — falls out of `planCall()` for free, so cost
 * caps have a number to check before a single provider call is spent.
 */

/**
 * A participant: `{ id, listenLang, speakLang?, voiceId?, consented? }`.
 * `listenLang` is what they want to hear/read (defaults profile lang, §6.1);
 * `speakLang` is a sticky hint, revisable per utterance by STT detection.
 */
export function normalizeParticipant (p) {
  if (!p || typeof p.id !== 'string' || !p.id) throw new Error('fanout: participant id required')
  if (typeof p.listenLang !== 'string' || !p.listenLang) throw new Error(`fanout: ${p.id}: listenLang required`)
  return {
    id: p.id,
    listenLang: p.listenLang,
    speakLang: p.speakLang || 'auto',
    voiceId: p.voiceId || null,
    consented: p.consented === true
  }
}

/**
 * The fan-out for ONE utterance by `speakerId` in `sourceLang`.
 *
 * Returns:
 * {
 *   speakerId, sourceLang,
 *   sttPasses: 1,                            // always — shared per speaker
 *   legs: [ { targetLang, listeners: [id] } ],   // MT+TTS per DISTINCT lang
 *   captionOnly: [ { listeners, lang } ],    // same-language listeners: original captions
 *   excluded: [speakerId]                    // the speaker hears nothing added
 * }
 */
export function fanoutForUtterance (participants, speakerId, sourceLang) {
  const list = (participants || []).map(normalizeParticipant)
  const speaker = list.find((p) => p.id === speakerId)
  if (!speaker) throw new Error(`fanout: unknown speaker "${speakerId}"`)
  const src = sourceLang || speaker.speakLang
  if (!src || src === 'auto') throw new Error('fanout: sourceLang must be resolved before fan-out (STT detects it)')

  const byLang = new Map() // targetLang -> [listenerIds]
  const sameLang = []
  for (const p of list) {
    if (p.id === speakerId) continue
    if (p.listenLang === src) { sameLang.push(p.id); continue }
    const arr = byLang.get(p.listenLang) || []
    arr.push(p.id)
    byLang.set(p.listenLang, arr)
  }

  return {
    speakerId,
    sourceLang: src,
    sttPasses: 1,
    legs: [...byLang.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([targetLang, listeners]) => ({ targetLang, listeners: listeners.sort() })),
    captionOnly: sameLang.length ? [{ listeners: sameLang.sort(), lang: src }] : [],
    excluded: [speakerId]
  }
}

/**
 * The WHOLE call's who-hears-what matrix: one row per (speaker, listener),
 * stating exactly what that listener receives for that speaker's speech.
 * `mode` is 'voice' (translated audio + captions), 'captions' (original
 * language matches — captions only), or 'self' (nothing added).
 */
export function whoHearsWhatMatrix (participants) {
  const list = (participants || []).map(normalizeParticipant)
  const rows = []
  for (const s of list) {
    const src = s.speakLang === 'auto' ? s.listenLang : s.speakLang // resting assumption; STT revises live
    for (const l of list) {
      if (l.id === s.id) { rows.push({ speaker: s.id, listener: l.id, mode: 'self', lang: null }); continue }
      if (l.listenLang === src) { rows.push({ speaker: s.id, listener: l.id, mode: 'captions', lang: src }); continue }
      rows.push({ speaker: s.id, listener: l.id, mode: 'voice', lang: l.listenLang, voice: s.voiceId ? 'clone' : 'generic' })
    }
  }
  return rows
}

/**
 * Plan the call: per-speaker fan-outs + the §14.3 concurrency/cost bound.
 * `activeSpeakers` defaults to all (worst case — the number caps must hold).
 */
export function planCall (participants, { activeSpeakers = null } = {}) {
  const list = (participants || []).map(normalizeParticipant)
  const speakers = activeSpeakers || list.map((p) => p.id)
  const perSpeaker = []
  let totalLegs = 0
  for (const id of speakers) {
    const s = list.find((p) => p.id === id)
    if (!s) throw new Error(`fanout: unknown active speaker "${id}"`)
    const src = s.speakLang === 'auto' ? s.listenLang : s.speakLang
    const f = fanoutForUtterance(list, id, src)
    perSpeaker.push(f)
    totalLegs += f.legs.length
  }
  return {
    perSpeaker,
    sttPasses: perSpeaker.length,
    mtTtsLegs: totalLegs,
    concurrencyBound: perSpeaker.length * Math.max(1, ...perSpeaker.map((f) => f.legs.length), 1),
    costDriver: `${perSpeaker.length} active speakers x distinct target languages = ${totalLegs} MT+TTS legs`
  }
}
