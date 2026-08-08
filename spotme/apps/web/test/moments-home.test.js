/**
 * M7 — Posts is the HOME of a served account; nobody else moves an inch.
 *
 * The promise this pins: a cold open lands on #/posts ONLY because the server
 * said so — either the live probe this session or its remembered answer from
 * a previous one (`settings.momentsHome`, a cache of the server's statement,
 * never a switch of its own). A never-served account cannot acquire the hint,
 * so its cold open is byte-for-byte the line that has always been here. And a
 * deeplink — a thread, `#/posts?m=…`, any route that is not a bare bar tab —
 * always wins over the default.
 *
 *   node test/moments-home.test.js
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(HERE, '..', ...p), 'utf8')

/* Strip comments first — these fences assert what the CODE does, and prose
 * naming a forbidden thing must not register as the thing itself. */
const decomment = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const main = decomment(read('src', 'main.js'))

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

console.log('\n========================================')
console.log('  M7 — cold open lands Home = Posts')
console.log('========================================')

check('the home tab derives from the stored server answer, falling back to Chats',
  /homeTab = \(\) =>[^\n]*momentsHome \? '#\/posts' : '#\/chat'/.test(main))

check('the hint is written ONLY from the probe result — never a literal true',
  /setSettings\(\{ momentsHome: on \}\)/.test(main) &&
  !/momentsHome:\s*true/.test(main))

check('a resetting device never lands by hint',
  /homeTab = \(\) => \(!RESETTING/.test(main))

check('only bare bar tabs count as a remembered tab the cold open may override',
  /const BAR_TABS = new Set\(NAV_ITEMS\.map/.test(main) &&
  /BAR_TABS\.has\(window\.location\.hash\)/.test(main) &&
  // the FULL hash is tested, so `#/posts?m=…` and every thread route miss the
  // set and pass through untouched — deeplinks always win
  !/BAR_TABS\.has\(routePath/.test(main))

check('the probe moves a sitting cold open TO Posts only when the server says served',
  /if \(on && coldOpenTab !== '#\/posts'\)/.test(main))

check('the probe bounces OFF Posts only a landing the hint itself chose',
  /else if \(!on && hintLed\)/.test(main))

check('navigating anywhere yourself ends the probe’s licence to move the screen',
  /window\.location\.hash !== coldOpenTab\) \{ coldOpenTab = null; hintLed = false \}/.test(main))

check('the no-hint cold open still writes the tab from homeTab, not a constant',
  /coldOpenTab = homeTab\(\)/.test(main) &&
  /window\.location\.hash = coldOpenTab/.test(main))

check('finishing onboarding lands on homeTab — a served account interrupted by re-declaration returns to Posts',
  /navigate\(homeTab\(\)\)/.test(main))

check('adopting a different account forgets the previous one’s moments answer, cache and hint both',
  /resetMomentsAvailability\(\)/.test(main) &&
  /momentsHome: false/.test(main))

console.log('\n========================================')
console.log(`  ${pass}/${pass + fail} passed`)
console.log('========================================\n')

if (fail) process.exit(1)
