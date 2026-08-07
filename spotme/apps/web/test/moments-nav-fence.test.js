/**
 * M6 — the Posts tab exists, and the production bottom bar is UNTOUCHED.
 *
 * The promise this pins: with Moments dark (which is production), the bar a
 * user sees must be exactly what it was before this change — four items,
 * Posts absent. The tab is not hidden with CSS or rendered-then-removed; it is
 * FILTERED OUT of the item list, because a hidden-but-present tab is one
 * stylesheet bug away from shipping a surface the server will 404 anyway.
 *
 * And the gate is the SERVER's: the item carries `flag: 'moments'`, and the
 * flag is only ever added to the enabled set by asking the backend
 * (`momentsAvailable()`), never by a local constant a build could flip.
 *
 *   node test/moments-nav-fence.test.js
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(HERE, '..', ...p), 'utf8')

/* Strip comments before any structural check. These fences assert what the
 * CODE does; prose that merely NAMES a forbidden thing (this file's own
 * explanations, or a comment saying "the server refuses likeCount") must not
 * register as the thing itself. That false positive is how a fence starts
 * failing for reasons unrelated to the behaviour it guards. */
const decomment = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const main = decomment(read('src', 'main.js'))
const view = decomment(read('src', 'views', 'moments.js'))
const api = decomment(read('src', 'lib', 'moments-api.js'))
const video = decomment(read('src', 'lib', 'video.js'))

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

console.log('\n========================================')
console.log('  M6 — Posts tab, and the untouched bar')
console.log('========================================')

check('the Posts tab exists and is flagged',
  /path:\s*'#\/posts'[^}]*flag:\s*'moments'/s.test(main))

check('Stories is NOT a bottom-bar item any more (it is the feed ring row)',
  !/path:\s*'#\/stories'\s*,\s*label:/.test(main))

check('#/stories still ROUTES — old links keep working',
  /'#\/stories':\s*stories/.test(main))

check('the bar FILTERS flagged items rather than hiding them in CSS',
  /navItems\s*\(\)\s*{[^}]*NAV_ITEMS\.filter\(/s.test(main) &&
  /navItems\(\)\.map\(/.test(main))

check('a flagged tab is enabled ONLY by asking the server',
  /momentsAvailable\(\)/.test(main) &&
  // no local constant that could switch it on at build time
  !/MOMENTS_ENABLED\s*=\s*true/.test(main))

check('the enabled set starts EMPTY, so the first paint is the production bar',
  /const enabledFlags = new Set\(\)/.test(main))

check('the bar is 4 items, exactly ONE flagged — production shows the other 3',
  (() => {
    const items = main.slice(main.indexOf('const NAV_ITEMS'), main.indexOf('const ACTIVE_TAB'))
    const paths = [...items.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
    const flagged = [...items.matchAll(/flag:\s*'([^']+)'/g)].length
    return paths.length === 4 && flagged === 1 &&
      ['#/discovery', '#/chat', '#/notifications'].every((p) => paths.includes(p))
  })())

console.log('\n========================================')
console.log('  Moments surface — the built rules (M4)')
console.log('========================================')

check('NO engagement counters are read or rendered',
  !/likeCount|viewCount|shareCount|reactionCount/.test(view))

check('the view never asks for a `private` feed tier',
  !/'private'/.test(view.slice(view.indexOf('const FEED_MODES'), view.indexOf('export function render'))))

check('the client rounds location to the coarse grid before sending',
  /round3/.test(api) && /Math\.round\(Number\(n\) \* 1000\) \/ 1000/.test(api))

check('a 404 is treated as "surface absent", never as a bug to retry',
  /MomentsDisabledError/.test(api) && /res\.status === 404/.test(api))

check('403 is kept DISTINCT from 404 — age refusal is not a missing feature',
  /MomentsForbiddenError/.test(api) && /res\.status === 403/.test(api))

/* The observer moved into lib/video.js so the feed and the reels viewer share
 * ONE implementation instead of hand-rolling the same logic twice. The
 * behaviour this fence guards is unchanged — it just has to look in both
 * files now: the shared factory owns the IntersectionObserver, and the view
 * still preloads its neighbours without ever playing them. */
check('reels: only the active pane plays, neighbours are preloaded not played',
  /IntersectionObserver/.test(video) && /watchInView/.test(view) &&
  /ensureSrc\(i \+ 1, 'metadata'\)/.test(view))

check('the in-view observer is defined ONCE and shared, never re-rolled per surface',
  (video.match(/new IntersectionObserver/g) || []).length === 1 &&
  !/new IntersectionObserver/.test(view))

/* The bug this pins: a <video> that is not inline-eligible when play() is
 * called is handed to the iOS native fullscreen player, which takes over the
 * screen and never comes back to our viewer. Both spellings, every element —
 * the elements are built by one factory precisely so this cannot drift. */
check('every video is inline on iOS — both playsinline spellings, set once centrally',
  /setAttribute\('playsinline'/.test(video) &&
  /setAttribute\('webkit-playsinline'/.test(video) &&
  /playsInline = true/.test(video) &&
  !/document\.createElement\('video'\)/.test(view))

/* The raw coarse cell (`g11.933:79.808`) is an internal grid id AND a rounded
 * coordinate. It reached users on every located post; it must never render. */
check('the internal coarseCell id is never printed to a reader',
  !/text:.*coarseCell/.test(view) && /coarseCell \? 'Nearby'/.test(view))

console.log('\n========================================')
console.log(`  ${pass}/${pass + fail} passed`)
console.log('========================================\n')

if (fail) process.exit(1)
