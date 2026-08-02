/**
 * Creative Studio op-doc — the non-destructive document model.
 *
 * Pins: strict boundaries (bad names, non-JSON params, oversize), undo/redo
 * as document slicing with redo-tail truncation, deterministic serialization
 * (stable key order — identical edits must be identical bytes for draft
 * dedupe and goldens), strict parsing (wrong kind/version/ops refused —
 * never a silent half-render), and history isolation (mutating a params
 * object after addOp cannot rewrite committed history).
 *
 *   node test/studio-opdoc.test.js
 */
import {
  createEditDoc, parseEditDoc, stableStringify, assertJsonPure,
  OPDOC_KIND, OPDOC_VERSION, MAX_OPS
} from '../src/lib/studio/opdoc.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

const SRC = { w: 100, h: 80, ref: 'blob:photo-1' }
const op = (name, params = {}) => ({ op: name, v: 1, params })

check('a document without a source is refused', () => throws(() => createEditDoc({}), /source/))
check('a source without integer dims is refused', () =>
  throws(() => createEditDoc({ source: { w: 1.5, h: 2, ref: 'x' } }), /integer/))

check('addOp validates the name shape', () => {
  const doc = createEditDoc({ source: SRC })
  return throws(() => doc.addOp({ op: 'Bad Name!', v: 1 }), /bad op name/)
})

check('addOp requires an integer version', () => {
  const doc = createEditDoc({ source: SRC })
  return throws(() => doc.addOp({ op: 'exposure', v: 0 }), /v >= 1/)
})

check('NaN in params is refused — a draft must serialize losslessly', () => {
  const doc = createEditDoc({ source: SRC })
  return throws(() => doc.addOp(op('exposure', { ev: NaN })), /non-finite/)
})

check('a function in params is refused', () => {
  const doc = createEditDoc({ source: SRC })
  return throws(() => doc.addOp(op('exposure', { ev: () => 1 })), /unsupported function/)
})

check('assertJsonPure allows the full JSON value set', () => {
  assertJsonPure({ a: [1, 'x', null, true, { b: [] }] })
  return true
})

check('undo/redo is cursor slicing', () => {
  const doc = createEditDoc({ source: SRC })
  doc.addOp(op('exposure', { ev: 1 }))
  doc.addOp(op('contrast', { amount: 0.5 }))
  if (doc.opCount() !== 2 || !doc.canUndo() || doc.canRedo()) return false
  doc.undo()
  if (doc.opCount() !== 1 || !doc.canRedo()) return false
  doc.redo()
  return doc.opCount() === 2 && doc.activeOps()[1].op === 'contrast'
})

check('adding after undo TRUNCATES the redo tail — no branched history', () => {
  const doc = createEditDoc({ source: SRC })
  doc.addOp(op('exposure', { ev: 1 }))
  doc.addOp(op('contrast', { amount: 0.5 }))
  doc.undo()
  doc.addOp(op('saturation', { amount: 0.2 }))
  return doc.opCount() === 2 && !doc.canRedo() && doc.activeOps()[1].op === 'saturation'
})

check('serialize captures the ACTIVE slice, not the undone tail', () => {
  const doc = createEditDoc({ source: SRC })
  doc.addOp(op('exposure', { ev: 1 }))
  doc.addOp(op('contrast', { amount: 0.5 }))
  doc.undo()
  const parsed = JSON.parse(doc.serialize())
  return parsed.ops.length === 1 && parsed.ops[0].op === 'exposure'
})

check('committed history is isolated from later params mutation', () => {
  const doc = createEditDoc({ source: SRC })
  const params = { ev: 1 }
  doc.addOp(op('exposure', params))
  params.ev = 3
  return doc.activeOps()[0].params.ev === 1
})

check('serialization is deterministic: key order cannot vary', () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } })
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 })
  return a === b && a === '{"a":{"c":3,"d":2},"b":1}'
})

check('same edits → same serialized bytes', () => {
  const mk = () => {
    const d = createEditDoc({ source: SRC })
    d.addOp(op('exposure', { ev: 0.5 }))
    d.addOp(op('vignette', { amount: 0.4, radius: 0.5, softness: 0.3 }))
    return d.serialize()
  }
  const first = mk()
  const second = mk()
  return first === second
})

check('round-trip: parse(serialize(doc)) preserves ops and source', () => {
  const doc = createEditDoc({ source: SRC })
  doc.addOp(op('exposure', { ev: 0.5 }))
  doc.addAsset({ id: 'bg1', ref: 'blob:bg' })
  const back = parseEditDoc(doc.serialize())
  return back.opCount() === 1 && back.source().w === 100 &&
    back.assets()[0].id === 'bg1' && back.serialize() === doc.serialize()
})

check('parse refuses non-JSON', () => throws(() => parseEditDoc('not json'), /not JSON/))
check('parse refuses the wrong kind', () =>
  throws(() => parseEditDoc(JSON.stringify({ kind: 'x', v: 1, source: SRC, ops: [] })), /wrong kind/))
check('parse refuses a FUTURE version rather than half-rendering it', () =>
  throws(() => parseEditDoc(JSON.stringify({ kind: OPDOC_KIND, v: OPDOC_VERSION + 1, source: SRC, ops: [] })), /unsupported version/))
check('parse refuses an oversize document', () => {
  const huge = JSON.stringify({ kind: OPDOC_KIND, v: 1, source: SRC, ops: [], pad: 'x'.repeat(2_100_000) })
  return throws(() => parseEditDoc(huge), /too large/)
})

check('the op count cap holds', () => {
  const doc = createEditDoc({ source: SRC })
  for (let i = 0; i < MAX_OPS; i++) doc.addOp(op('exposure', { ev: 0 }))
  return throws(() => doc.addOp(op('exposure', { ev: 0 })), /more than/)
})

check('duplicate asset ids are refused', () => {
  const doc = createEditDoc({ source: SRC })
  doc.addAsset({ id: 'a', ref: 'r1' })
  return throws(() => doc.addAsset({ id: 'a', ref: 'r2' }), /duplicate asset/)
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio op-doc — non-destructive core')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
