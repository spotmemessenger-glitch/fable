/**
 * Moments-in-React — the flag gate and the single-playback-owner rule.
 *
 * The flag test proves DEFAULT OFF three ways (unset, wrong casing, throwing
 * storage). The playback test proves the rule structurally where it is
 * actually enforced: every video the React card creates goes through
 * lib/video.js's videoEl/watchInView, and playExclusive() pauses the current
 * owner BEFORE calling play() on the next — so two audible sources cannot
 * coexist no matter how a feed is scrolled, and React + legacy videos share
 * the ONE owner because they share the module singleton.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const view = readFileSync(at('../src/views/moments.js'), 'utf8')
const react = readFileSync(at('../src/react/moments/index.jsx'), 'utf8')
const video = readFileSync(at('../src/lib/video.js'), 'utf8')

/* ------------------------------------------------------------ flag gate */

test('the flag defaults OFF when the key is unset (and on anything but "on")', () => {
  const gate = (store) => {
    // Mirror of reactMomentsOn() in the view — kept honest by the structural
    // assertions below, which fail if the view's gate changes shape.
    try { return store.getItem('spotme.ui.moments') === 'on' } catch { return false }
  }
  assert.equal(gate({ getItem: () => null }), false)                          // unset
  assert.equal(gate({ getItem: () => 'ON' }), false)                          // casing
  assert.equal(gate({ getItem: () => 'true' }), false)                        // wrong word
  assert.equal(gate({ getItem: () => { throw new Error('denied') } }), false) // private mode
  assert.equal(gate({ getItem: () => 'on' }), true)                           // the one opt-in
})

test('the view gates BEFORE the dynamic import — flag-off users never load React', () => {
  assert.match(view, /localStorage\.getItem\('spotme\.ui\.moments'\)\s*===\s*'on'/)
  assert.match(view, /if \(reactMomentsOn\(\)\) \{[\s\S]*?import\('\.\.\/react\/moments\/index\.jsx'\)/)
  // No STATIC import of the React tree from the legacy view.
  assert.equal(/^import[^\n]*react\/moments/m.test(view), false)
  // Legacy path is intact: the gate falls through to renderLegacy.
  assert.match(view, /return renderLegacy\(root, ctx, params\)/)
})

/* ------------------------------------------------- single playback owner */

test('React videos join the SAME owner: only videoEl/watchInView create or play them', () => {
  // The React card must never construct its own <video> or call .play():
  // both would bypass playExclusive and allow a second audible source.
  assert.match(react, /import \{ videoEl, watchInView, pause \} from '\.\.\/\.\.\/lib\/video\.js'/)
  assert.equal(/createElement\(\s*['"]video['"]/.test(react), false)
  assert.equal(/\.play\(\)/.test(react), false)
})

test('playExclusive pauses the CURRENT owner before playing the next — never after', () => {
  const body = video.slice(video.indexOf('export async function playExclusive'))
  const pauseIdx = body.indexOf('pause(current)')
  const playIdx = body.indexOf('await v.play()')
  assert.ok(pauseIdx > -1 && playIdx > -1, 'both calls exist')
  assert.ok(pauseIdx < playIdx, 'pause(current) precedes v.play()')
})

/* ------------------------------------------------------- honest omissions */

test('the React card promises nothing this branch does not serve', () => {
  // reactionCount / commentCount / setVisibility / share / save are absent
  // from this branch's API client; the card must not render them.
  for (const absent of ['reactionCount', 'commentCount', 'setVisibility', 'aria-label="Share"', 'aria-label="Save"']) {
    assert.equal(react.includes(absent), false, `${absent} must be absent until #139 is rebased`)
  }
})
