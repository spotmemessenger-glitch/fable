/**
 * Adaptive transport SELECTION — weighted scoring + hysteresis (ADR-012).
 *
 * Pure logic: no network, no clock. `now` is passed in, so "does it flap?" is a
 * deterministic unit test rather than a soak test. Scaffolding only — the flag
 * is off and none of this is wired into the message path.
 */
import {
  scoreCandidate, scoreAll, createSelector, DEFAULT_WEIGHTS, DEFAULT_HYSTERESIS
} from '../src/lib/transport-supervisor/selection.js'
import { CAPABILITY_MATRIX } from '../src/lib/transport-supervisor/capabilities.js'
import { makeQualitySample } from '../src/lib/transport-supervisor/ITransport.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const cand = (name, extra = {}) => ({ name, capabilities: CAPABILITY_MATRIX[name], ...extra })
/** A pre-scored entry (already sorted best-first by the caller). */
const sc = (name, score) => ({ name, score, disqualified: score == null, reason: null, parts: null })

/* ============================ scoring basics ============================ */

check('a healthy internet transport scores a number in (0,1]', () => {
  const r = scoreCandidate(cand('socketio', {
    quality: makeQualitySample({ latencyMs: 50, lossPct: 0.01, throughputKbps: 5000, connected: true })
  }))
  return typeof r.score === 'number' && r.score > 0 && r.score <= 1 && r.disqualified === false
})

check('default weights sum to 1', () => {
  const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)
  return Math.abs(total - 1) < 1e-9
})

check('socketio out-scores bleMesh on a normal online link', () => {
  const s = scoreCandidate(cand('socketio')).score
  const b = scoreCandidate(cand('bleMesh')).score
  return s > b
})

check('weights need not be pre-normalised — the score stays in [0,1]', () => {
  const r = scoreCandidate(cand('socketio'), {}, { latency: 5, reliability: 5, bandwidth: 5, battery: 5, cost: 5, reachability: 5 })
  return r.score >= 0 && r.score <= 1
})

/* ===================== hard constraints DISQUALIFY ===================== */

check('offline requirement disqualifies online-only transports, keeps the mesh', () => {
  const online = scoreCandidate(cand('socketio'), { needOffline: true })
  const mesh = scoreCandidate(cand('bleMesh'), { needOffline: true })
  return online.disqualified === true && online.score == null && mesh.disqualified === false && mesh.score > 0
})

check('no internet disqualifies internet transports', () => {
  const r = scoreCandidate(cand('socketio'), { noInternet: true })
  return r.disqualified === true && r.score == null
})

check('a payload larger than the frame limit disqualifies the mesh', () => {
  const r = scoreCandidate(cand('bleMesh'), { payloadBytes: 2000 })   // bleMesh maxPayloadBytes = 512
  return r.disqualified === true
})

check('a transport reporting NOT connected is disqualified, not merely penalised', () => {
  const r = scoreCandidate(cand('socketio', { quality: makeQualitySample({ connected: false }) }))
  return r.disqualified === true && r.score == null
})

check('an UNKNOWN (no sample) transport is still selectable', () => {
  const r = scoreCandidate(cand('socketio'))   // no quality sample supplied
  return r.disqualified === false && typeof r.score === 'number'
})

/* ============================ scoreAll order =========================== */

check('scoreAll sorts best-first and puts disqualified last', () => {
  const list = scoreAll([cand('socketio'), cand('bleMesh')], { needOffline: true })
  // Only bleMesh qualifies offline; socketio is disqualified and sinks to the end.
  return list[0].name === 'bleMesh' && list[list.length - 1].name === 'socketio' && list[list.length - 1].score == null
})

/* ============================== hysteresis ============================= */

check('the default hysteresis is margin 0.05 / dwell 8000 / stickiness 0.03', () => {
  return DEFAULT_HYSTERESIS.margin === 0.05 && DEFAULT_HYSTERESIS.dwellMs === 8000 && DEFAULT_HYSTERESIS.stickiness === 0.03
})

check('the first choose() picks the best real transport and reports a switch', () => {
  const sel = createSelector()
  const r = sel.choose([cand('socketio'), cand('bleMesh')], {}, 0)
  return r.selected === 'socketio' && r.switched === true && r.reason === 'initial selection'
})

check('a marginally better challenger does NOT cause a switch (anti-flap)', () => {
  const sel = createSelector({ margin: 0.05, dwellMs: 8000, stickiness: 0.03 })
  sel.chooseScored([sc('a', 0.80), sc('b', 0.70)], 0)          // -> a
  // Dwell elapsed; b now leads by only 0.04, under margin+stickiness (0.08).
  const r = sel.chooseScored([sc('b', 0.84), sc('a', 0.80)], 9000)
  return r.selected === 'a' && r.switched === false
})

check('within the dwell window the incumbent is protected even from a clear winner', () => {
  const sel = createSelector({ margin: 0.05, dwellMs: 8000, stickiness: 0.03 })
  sel.chooseScored([sc('a', 0.80), sc('b', 0.70)], 0)          // -> a at t=0
  const r = sel.chooseScored([sc('b', 0.99), sc('a', 0.80)], 1000)   // t=1000 < dwell
  return r.selected === 'a' && r.switched === false && r.reason === 'within dwell window'
})

check('after dwell, a challenger clearing the margin DOES switch', () => {
  const sel = createSelector({ margin: 0.05, dwellMs: 8000, stickiness: 0.03 })
  sel.chooseScored([sc('a', 0.80), sc('b', 0.70)], 0)          // -> a
  const r = sel.chooseScored([sc('b', 0.90), sc('a', 0.80)], 9000)   // 0.90 >= 0.80+0.03+0.05
  return r.selected === 'b' && r.switched === true
})

check('a disqualified incumbent triggers an IMMEDIATE switch, dwell notwithstanding', () => {
  const sel = createSelector({ margin: 0.05, dwellMs: 8000, stickiness: 0.03 })
  sel.chooseScored([sc('a', 0.80), sc('b', 0.70)], 0)          // -> a at t=0
  // t=500 is INSIDE the dwell window, but a is gone (only b viable) -> switch now.
  const r = sel.chooseScored([sc('b', 0.40), sc('a', null)], 500)
  return r.selected === 'b' && r.switched === true && r.reason === 'incumbent no longer viable'
})

check('no viable transport yields a null selection and clears the incumbent', () => {
  const sel = createSelector()
  sel.chooseScored([sc('a', 0.80)], 0)
  const r = sel.chooseScored([sc('a', null)], 100)
  return r.selected === null && r.switched === true && sel.state().current === null
})

check('reset() forgets the incumbent so the next choose is a fresh initial pick', () => {
  const sel = createSelector()
  sel.chooseScored([sc('a', 0.80), sc('b', 0.70)], 0)
  sel.reset()
  const r = sel.chooseScored([sc('b', 0.70), sc('a', 0.80)], 100)
  return r.reason === 'initial selection' && r.selected === 'b'
})

/* -------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive selection — score + hysteresis')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
if (passed !== names.length) process.exit(1)
