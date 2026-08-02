/**
 * Creative Studio FENCE — the proof the module ships dark and disconnected.
 *
 * (a) No source file outside lib/studio/ imports it; db.js may contain the
 *     wipe-list DATABASE NAME as a string and nothing else studio-related.
 * (b) The studio never mentions views/ — it is a platform library with no UI
 *     surface, and a views import in either direction is a fence breach.
 * (c) Every default flag is false (assertShippedDark), pinned here as well
 *     as in the flags suite so this file alone catches a lit default.
 * (d) createStudio() with the master off is INERT: throwing fakes for every
 *     injectable stand in for "no canvas, no DB, no timers, no fetch", and
 *     every capability method throws StudioDisabledError.
 * (e) When a production build exists (dist/), it contains no studio module
 *     strings except the wipe-list DB name — tree-shaking keeps the dark
 *     bundle byte-identical. Skipped honestly when dist/ is absent, because
 *     `npm test` must not require a build; the pre-merge gate runs the build
 *     first and then THIS file asserts against it.
 *
 *   node test/studio-fence.test.js
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const ROOT = new URL('..', import.meta.url).pathname

function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const srcFiles = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js'))
const studioFiles = srcFiles.filter((f) => f.includes('/lib/studio/'))
const outsideFiles = srcFiles.filter((f) => !f.includes('/lib/studio/'))

/* ------------------------------------------------------------- (a) fence */

check('(a) NO src file outside lib/studio imports the studio', () => {
  const offenders = outsideFiles.filter((f) => {
    const text = readFileSync(f, 'utf8')
    return /from\s+['"][^'"]*\/studio\//.test(text) || /import\s*\(\s*['"][^'"]*\/studio\//.test(text) ||
      /from\s+['"][^'"]*lib\/studio/.test(text)
  })
  if (offenders.length) console.log('    offenders:', offenders.join(', '))
  return offenders.length === 0
})

check('(a) db.js carries ONLY the DB-name string — no studio import, no API use', () => {
  const text = readFileSync(join(ROOT, 'src/lib/db.js'), 'utf8')
  const hasName = text.includes("'spotme-studio-drafts'")
  const mentions = text.split('\n').filter((l) => /studio/i.test(l))
  // Every studio-mentioning line must be a comment or the dropDatabase name.
  const clean = mentions.every((l) =>
    l.includes("dropDatabase('spotme-studio-drafts')") || /^\s*(\/\*|\*|\/\/)/.test(l))
  const noImport = !/import[^\n]*studio/.test(text)
  return hasName && clean && noImport
})

check('(a) api files other than studio-ai.js stay studio-free', () => {
  // "AI Studio" (Google's console) legitimately appears in translate.js
  // prose; the fence is about THIS module's markers, not the word.
  const apiFiles = walk(join(ROOT, 'api')).filter((f) => f.endsWith('.js') && !f.endsWith('studio-ai.js'))
  return apiFiles.every((f) => {
    const text = readFileSync(f, 'utf8')
    return !/studio-ai|lib\/studio|spotme-studio|STUDIO_AI_/.test(text)
  })
})

/* ----------------------------------------------------------- (b) no views */

check('(b) the studio never mentions views/ in any form', () =>
  studioFiles.every((f) => {
    const text = readFileSync(f, 'utf8')
    return !/views\//.test(text) && !/from\s+['"]\.\.\/\.\.\/views/.test(text)
  }))

check('(b) the studio imports NOTHING outside lib/studio (fully injected)', () =>
  studioFiles.every((f) => {
    const text = readFileSync(f, 'utf8')
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    return imports.every((s) => s.startsWith('./'))
  }))

/* ------------------------------------------------------------- (c) flags */

const { DEFAULT_FLAGS, assertShippedDark, resolveFlags, createStudio, StudioDisabledError } =
  await import('../src/lib/studio/index.js')

check('(c) assertShippedDark passes against the shipped defaults', () =>
  assertShippedDark(DEFAULT_FLAGS) === true)

check('(c) the flag FILE also declares only false literals (belt and braces)', () => {
  const text = readFileSync(join(ROOT, 'src/lib/studio/flags.js'), 'utf8')
  const block = text.slice(text.indexOf('DEFAULT_FLAGS'), text.indexOf('FLAG_PARENT'))
  return !/:\s*true/.test(block) && (block.match(/:\s*false/g) || []).length === Object.keys(DEFAULT_FLAGS).length
})

/* ---------------------------------------------------------- (d) inertness */

check('(d) createStudio with the master off touches NOTHING injected', () => {
  const boom = (what) => new Proxy(function () { throw new Error(`${what} used while dark`) }, {
    get () { throw new Error(`${what} used while dark`) },
    apply () { throw new Error(`${what} used while dark`) }
  })
  const studio = createStudio({
    flags: {},
    clock: boom('clock'),
    idb: boom('idb'),
    makeCanvas: boom('canvas'),
    fetchImpl: boom('fetch'),
    getAuthHeaders: boom('auth')
  })
  return studio.enabled === false && studio.flags.CREATIVE_STUDIO_ENABLED === false
})

check('(d) every capability of the inert studio throws StudioDisabledError', () => {
  const studio = createStudio({ flags: {} })
  const calls = [
    () => studio.editor.createDoc({ source: { w: 1, h: 1, ref: 'x' } }),
    () => studio.editor.render(null, []),
    () => studio.looks.ids(),
    () => studio.removal.segmenter.segment(null, {}),
    () => studio.composer.validate({}),
    () => studio.composer.renderVideo({}),
    () => studio.collage.render('four_grid', []),
    () => studio.templates.instantiate('story_clean', ['x']),
    () => studio.drafts.save({}),
    () => studio.cloud.inpaint({})
  ]
  return calls.every((call) => {
    try {
      call()
      return false
    } catch (e) {
      return e instanceof StudioDisabledError
    }
  })
})

check('(d) even a lit child under a dark master stays inert', () => {
  const studio = createStudio({ flags: { STUDIO_EDITOR_ENABLED: true } })
  try {
    studio.editor.createDoc({ source: { w: 1, h: 1, ref: 'x' } })
    return false
  } catch (e) {
    return e instanceof StudioDisabledError
  }
})

check('(d) a lit master with dark children still gates each capability', () => {
  const studio = createStudio({ flags: { CREATIVE_STUDIO_ENABLED: true } })
  try {
    studio.looks.ids()
    return false
  } catch (e) {
    return e instanceof StudioDisabledError && studio.enabled === true
  }
})

check('(d) a dark capability under a lit master never runs its work — review board F-5', () => {
  // Master lit, EVERY child dark: exactly the shape of a staged rollback,
  // where one misbehaving feature is flipped off while the rest stay on.
  const studio = createStudio({ flags: { CREATIVE_STUDIO_ENABLED: true } })
  // A Proxy whose getter THROWS the moment anything reads a property off it —
  // this is what "the caller's arguments were never touched" actually means:
  // not just "the op-doc didn't render", but the gate never even inspected
  // what was handed to it before refusing.
  const untouchable = (label) => new Proxy({}, {
    get () { throw new Error(`${label}: argument was read while the feature is dark`) }
  })
  const calls = [
    // Sync capability: if gate evaluated eagerly, createEditDoc would already
    // have run (and thrown on the untouchable arg) before the gate's own
    // check — proving eager-vs-thunk is which error surfaces, if either does.
    () => studio.editor.createDoc(untouchable('editor.createDoc')),
    () => studio.editor.render(untouchable('editor.render'), untouchable('ops'), {}),
    // Async capability: this is the case with real teeth — an eagerly
    // evaluated renderVideo call starts a real (possibly long) render whose
    // promise nobody awaits, and it does so BEFORE the throw reaches the
    // caller. A thunk means the render function body never runs at all.
    () => studio.composer.renderVideo(untouchable('composer.renderVideo'), {})
  ]
  return calls.every((call) => {
    try { call(); return false } catch (e) { return e instanceof StudioDisabledError }
  })
})

check('(d) resolveFlags cannot be coaxed into lighting an unknown flag', () => {
  try {
    resolveFlags({ CREATIVE_STUDIO_ENABLED: true, EXTRA: true })
    return false
  } catch {
    return true
  }
})

/* --------------------------------------------------------- (e) dist audit */

// (e) is deliberately NOT registered via check() when dist/ is absent. A
// recorded PASS for an assertion that never ran is a false shape: it reads,
// in the summary line, exactly like "verified dark" when nothing was
// verified at all. The pre-merge gate always has a dist/ (CI runs Build
// before Test), so this only skips locally — loudly, and without inflating
// the pass count (review board F-12).
const dist = join(ROOT, 'dist')
if (!existsSync(dist)) {
  console.log('  SKIP  (e) dist/ contains no studio strings — dist/ absent, run `npm run build` first for the full fence (pre-merge gate always does)')
} else {
  check('(e) dist/ contains no studio strings except the wipe-list DB name', () => {
    const markers = [
      'spotme-studio-opdoc', 'CREATIVE_STUDIO_ENABLED', 'StudioDisabledError',
      'studio-cloud', 'STUDIO_CLOUD_AI_ENABLED', 'inpaintTelea', 'spotme-studio-timeline'
    ]
    const files = walk(dist).filter((f) => /\.(js|css|html|map)$/.test(f))
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const marker of markers) {
        if (text.includes(marker)) {
          console.log(`    breach: ${marker} in ${f}`)
          return false
        }
      }
    }
    return true
  })
}

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio fence — dark, disconnected, inert')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
