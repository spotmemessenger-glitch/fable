/**
 * Call-quality primitives — VAD, adaptive jitter buffer + PLC policy,
 * degradation ladder hysteresis, diarization, capture constraints
 * (ADR-011b; mission item 4). All pure, all deterministic.
 *
 *   node test/live-voice-quality.test.js
 */
import { createVad } from '../src/lib/live-voice/quality/vad.js'
import { createJitterBuffer } from '../src/lib/live-voice/quality/jitter-buffer.js'
import { createDegradationLadder, DEGRADATION_TIERS, TIER_ORDER } from '../src/lib/live-voice/quality/degradation-ladder.js'
import { createDiarizer } from '../src/lib/live-voice/quality/diarization.js'
import { LIVE_VOICE_AUDIO_CONSTRAINTS, applyLiveVoiceConstraints } from '../src/lib/live-voice/quality/constraints.js'

const results = {}
const check = (name, pass) => { results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ================================ VAD ================================ */
{
  const vad = createVad({ openThreshold: 0.5, closeThreshold: 0.3, openFrames: 2, hangoverMs: 100, frameMs: 20 })
  const events = []
  const feed = (energies) => { for (const e of energies) { const ev = vad.push({ energy: e }); if (ev) events.push(ev) } }
  feed([0.1, 0.6])                    // one hot frame — not enough (debounce)
  check('one hot frame does not open (debounce)', events.length === 0 && vad.open === false)
  feed([0.7])                         // second consecutive hot frame → open
  check('two consecutive hot frames open a segment', events[0]?.type === 'open')
  feed([0.6, 0.35, 0.32, 0.6])        // dips above closeThreshold keep it open
  check('short dips above closeThreshold do not close', events.length === 1)
  feed([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]) // 120ms silence > 100ms hangover → close
  check('silence past the hangover closes with reason', events[1]?.type === 'close' && events[1].reason === 'silence')
  check('close reports a positive duration', events[1].durationMs > 0)
}
{
  const vad = createVad({ openThreshold: 0.5, openFrames: 1, hangoverMs: 10_000, maxSegmentMs: 200, frameMs: 20 })
  let closed = null
  for (let i = 0; i < 30 && !closed; i++) { const ev = vad.push({ energy: 0.9 }); if (ev?.type === 'close') closed = ev }
  check('a monologue force-closes at maxSegmentMs', closed?.reason === 'max-segment')
}
{
  const vad = createVad({ openThreshold: 0.5, openFrames: 1 })
  vad.push({ energy: 0.9, t: 0 })
  const ev = vad.flush()
  check('flush closes an open segment', ev?.reason === 'flush' && vad.segments === 1)
  check('flush on a closed vad is a no-op', vad.flush() === null)
}

/* ============================ jitter buffer ============================ */
{
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, targetMs: 100, chunkMs: 50 })
  jb.push({ seq: 0, chunk: 'AAA' })
  jb.push({ seq: 1, chunk: 'BBB' })
  check('nothing pops before the depth elapses', jb.pop() === null)
  now = 100
  const p0 = jb.pop()
  check('first chunk pops exactly at depth', p0?.chunk === 'AAA' && p0.seq === 0)
  check('second chunk waits its slot', jb.pop() === null)
  now = 150
  check('second chunk pops on schedule', jb.pop()?.chunk === 'BBB')
}
{
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, targetMs: 100, chunkMs: 50 })
  jb.push({ seq: 1, chunk: 'B' })   // out of order
  jb.push({ seq: 0, chunk: 'A' })
  now = 200
  const a = jb.pop(); const b = jb.pop()
  check('out-of-order arrivals play in sequence order', a?.seq === 0 && b?.seq === 1)
  check('duplicate seq refused', jb.push({ seq: 1, chunk: 'B2' }) === false)
}
{
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, targetMs: 100, chunkMs: 50, plc: 'skip' })
  jb.push({ seq: 0, chunk: 'A' })
  jb.push({ seq: 2, chunk: 'C' })   // seq 1 lost
  now = 100; jb.pop()
  now = 150
  const gap = jb.pop()
  check('a confirmed gap yields a SKIP concealment record', gap?.concealment?.policy === 'skip' && gap.concealment.seq === 1)
  const c = jb.pop()
  check('after skip, the next real chunk plays', c?.seq === 2 && c.chunk === 'C')
  check('loss grew the adaptive depth', jb.depthMs > 100)
  check('stats count the loss + concealment', jb.stats.lost === 1 && jb.stats.concealed === 1)
}
{
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, targetMs: 100, chunkMs: 50, plc: 'stretch' })
  jb.push({ seq: 0, chunk: 'A' })
  jb.push({ seq: 2, chunk: 'C' })
  now = 100; jb.pop()
  now = 150
  const gap = jb.pop()
  check('stretch policy stretches time instead of skipping', gap?.concealment?.policy === 'stretch' && gap.concealment.stretchedMs === 50)
  check('stretch pushes the NEXT chunk later', jb.pop() === null)
  now = 250
  check('the next chunk plays after the stretched window', jb.pop()?.seq === 2)
}
{
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, targetMs: 100, minMs: 60, chunkMs: 10, cleanWindow: 4, shrinkStepMs: 20 })
  for (let s = 0; s < 12; s++) jb.push({ seq: s, chunk: `c${s}` })
  now = 100
  for (let s = 0; s < 12; s++) { now += 10; jb.drain() }
  check('sustained clean delivery shrinks the depth (bounded at min)', jb.depthMs < 100 && jb.depthMs >= 60)
  jb.hardReset()
  check('hardReset restores target depth + clears stats', jb.depthMs === 100 && jb.stats.pushed === 0)
}

/* ========================== degradation ladder ========================== */
{
  let now = 0
  const clock = { now: () => now }
  const moves = []
  const ladder = createDegradationLadder({ clock, demoteAfter: 2, windowMs: 1000, promoteAfterMs: 500, onChange: (m) => moves.push(m) })
  check('ladder starts FULL, voice allowed', ladder.tier === DEGRADATION_TIERS.FULL && ladder.allows().voice === true)
  ladder.recordBreach('slow')
  check('one breach inside the window does NOT demote (hysteresis)', ladder.tier === DEGRADATION_TIERS.FULL)
  now = 100
  ladder.recordBreach('slow-again')
  check('second breach demotes to captions-only', ladder.tier === DEGRADATION_TIERS.CAPTIONS_ONLY && moves[0].direction === 'demote')
  check('captions-only forbids voice, keeps translated captions + original', (() => { const a = ladder.allows(); return !a.voice && a.translatedCaptions && a.originalAudio })())
  now = 200; ladder.recordBreach('worse'); now = 250; ladder.recordBreach('worse')
  check('further breaches demote to original-only (the floor)', ladder.tier === DEGRADATION_TIERS.ORIGINAL_ONLY && ladder.atBottom)
  check('original-only STILL allows original audio — never silence', ladder.allows().originalAudio === true)
  ladder.recordBreach('even-worse')
  check('breaches at the bottom do not underflow', ladder.tier === DEGRADATION_TIERS.ORIGINAL_ONLY)
  now = 300; ladder.recordClean()
  check('a clean pass does not promote before promoteAfterMs (hysteresis)', ladder.tier === DEGRADATION_TIERS.ORIGINAL_ONLY)
  now = 900; ladder.recordClean()
  check('sustained clean promotes ONE tier', ladder.tier === DEGRADATION_TIERS.CAPTIONS_ONLY)
  now = 1500; ladder.recordClean()
  check('further sustained clean recovers FULL', ladder.tier === DEGRADATION_TIERS.FULL)
  now = 1600
  ladder.recordBreach('cap-hit')
  const forced = ladder.forceBottom('kill-switch')
  check('forceBottom drops straight to the floor with the reason', ladder.tier === DEGRADATION_TIERS.ORIGINAL_ONLY && forced.reason === 'kill-switch')
  check('tier order is the mission ladder', JSON.stringify(TIER_ORDER) === JSON.stringify(['full', 'captions-only', 'original-only']))
  check('every move was announced via onChange', moves.length >= 5 && moves.every((m) => m.from && m.to && m.reason))
}
{
  // Flapping guard: alternating breach/clean must not oscillate tiers.
  let now = 0
  const clock = { now: () => now }
  const ladder = createDegradationLadder({ clock, demoteAfter: 2, windowMs: 1000, promoteAfterMs: 2000 })
  ladder.recordBreach(); now += 50; ladder.recordBreach() // demote
  let flaps = 0
  const start = ladder.tier
  for (let i = 0; i < 20; i++) { now += 100; ladder.recordClean(); now += 100; ladder.recordBreach() }
  if (ladder.tier !== start) flaps += 0 // tier may sink further, but…
  const promotions = ladder.moves().filter((m) => m.direction === 'promote').length
  check('breach-tainted health never promotes (no flapping)', promotions === 0 && flaps === 0)
}

/* ============================= diarization ============================= */
{
  const d = createDiarizer({ emaAlpha: 1, activeThreshold: 0.2, dominanceMargin: 0.1, holdMs: 100 })
  let r = d.push('A', { energy: 0.8, t: 0 })
  check('a lone speaker takes the floor', r.floor === 'A' && r.changed === true)
  r = d.push('B', { energy: 0.3, t: 20 })
  check('a quieter second stream does not steal the floor', r.floor === 'A' && r.changed === false)
  r = d.push('B', { energy: 0.95, t: 40 })
  check('a clearly-louder challenger takes the floor (cross-talk)', r.floor === 'B')
  d.push('B', { energy: 0.0, t: 60 })
  r = d.push('B', { energy: 0.0, t: 200 })
  check('after hold expires with silence the floor releases/moves', r.floor !== 'B')
  check('turn history recorded (bounded)', d.turns().length >= 2 && d.turns().length <= 128)
  let threw = false
  try { d.push(null, { energy: 1 }) } catch { threw = true }
  check('a frame without a streamId throws', threw)
}

/* ======================= capture constraints (config) ======================= */
check('constraints enable EC+NS+AGC, mono, 48kHz — configuration, not DSP', (
  LIVE_VOICE_AUDIO_CONSTRAINTS.echoCancellation === true &&
  LIVE_VOICE_AUDIO_CONSTRAINTS.noiseSuppression === true &&
  LIVE_VOICE_AUDIO_CONSTRAINTS.autoGainControl === true &&
  LIVE_VOICE_AUDIO_CONSTRAINTS.channelCount === 1 &&
  LIVE_VOICE_AUDIO_CONSTRAINTS.sampleRate === 48000
))
await checkAsync('applyLiveVoiceConstraints applies to a clone track (injected)', async () => {
  let applied = null
  const track = { applyConstraints: async (c) => { applied = c } }
  const r = await applyLiveVoiceConstraints(track)
  return r.applied === true && applied.noiseSuppression === true
})
await checkAsync('applyLiveVoiceConstraints degrades gracefully when unsupported', async () => {
  const r = await applyLiveVoiceConstraints({})
  return r.applied === false && /unsupported/.test(r.reason)
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  call-quality primitives — VAD / jitter+PLC / ladder / diarizer')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
