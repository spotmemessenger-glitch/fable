/**
 * Colour tokens — the view CSS names its colours instead of spelling them.
 *
 * Section 1 of 05-DESIGN-SYSTEM.md says every colour has exactly one job.
 * That only holds if the job is written down: a raw `#fff` in a view file
 * carries no job, so nothing tells a later reader whether it is the surface
 * the page is painted on or the lettering on a blue badge — and those two
 * diverge the moment a dark theme is ever added as the P3 extension the
 * design system describes.
 *
 * This fence pins three things:
 *
 *   1. the consolidated view files carry NO raw hex — colours come from tokens;
 *   2. every token they reference is actually DEFINED (a typo'd var() is
 *      silently transparent in CSS, which is the worst possible failure);
 *   3. the tokens extracted on 2026-08-06 still hold the exact literals they
 *      replaced — the palette is LOCKED, so this consolidation must remain a
 *      rename and never become a restyle.
 *
 * chat.css and moments.css are knowingly NOT yet consolidated: they are being
 * rewritten in PR #130, and tokenising them in parallel would only manufacture
 * a merge conflict. The exclusion list is asserted to be EXACTLY those two, so
 * it cannot quietly grow into a hole big enough to hide a regression.
 *
 *   node test/design-tokens-fence.test.js
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const read = (...p) => readFileSync(join(SRC, ...p), 'utf8')

/* Strip comments before any check. This file's own subject matter is colour
 * literals, and the view files explain their palettes in prose — a comment
 * that NAMES #fff must not register as a declaration using it. */
const decomment = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const HEX = /#[0-9a-fA-F]{3,8}\b/g

/* Rewritten under PR #130 — consolidated once that lands, not before. */
const DEFERRED = ['chat.css', 'moments.css']

const viewFiles = readdirSync(join(SRC, 'views')).filter((f) => f.endsWith('.css')).sort()
const consolidated = viewFiles.filter((f) => !DEFERRED.includes(f))

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

console.log('\n========================================')
console.log('  Colour tokens — no raw hex in the views')
console.log('========================================')

/* ---- 1. no raw hex ---------------------------------------------------- */

for (const f of consolidated) {
  const hits = decomment(read('views', f)).match(HEX) || []
  check(`${f} declares no raw hex (${hits.length ? hits.join(' ') : 'clean'})`, hits.length === 0)
}

/* ---- 2. the exclusion list is exactly the files PR #130 rewrites ------- */

check('the deferred list is EXACTLY chat.css and moments.css',
  DEFERRED.length === 2 &&
  DEFERRED.every((f) => viewFiles.includes(f)))

/* ---- 3. every var(--x) the views use is really defined ----------------- */

const tokens = decomment(read('tokens.css'))
const declared = new Set(
  [...tokens.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]),
)

/* Only FALLBACK-LESS references are checked. `var(--x, <fallback>)` is
 * legitimate defensive CSS — it renders the fallback and nothing is lost.
 * `var(--x)` naming an undefined property is invalid at computed-value time:
 * an inherited property like `color` silently inherits instead, which is how
 * .requn and .reqhint shipped at full body ink rather than muted. */
const referenced = new Map()
for (const f of consolidated) {
  for (const m of decomment(read('views', f)).matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], f)
  }
}
const missing = [...referenced].filter(([t]) => !declared.has(t))
check(`every fallback-less token the views reference is defined${missing.length ? ` — missing: ${missing.map(([t, f]) => `${t} (${f})`).join(', ')}` : ''}`,
  missing.length === 0)

/* ---- 4. the extracted tokens still hold the literals they replaced ----- */

/* Each entry is the exact value the raw hex had before consolidation. If one
 * of these ever differs, the "locked palette, rename only" promise is broken
 * and the diff that broke it is the one to look at. */
const EXTRACTED = {
  '--onfill': '#fff',
  '--ink-press': '#000',
  '--arch': '#3aa981',
  '--bt-scope-core': '#10203a',
  '--bt-scope-mid': '#0b1526',
  '--bt-scope-edge': '#081020',
  '--bt-blip': '#5eead4',
  '--vcard-top': '#fbfcff',
  '--vcard-bottom': '#f5f7fb',
}

for (const [tok, want] of Object.entries(EXTRACTED)) {
  const m = tokens.match(new RegExp(`${tok}\\s*:\\s*([^;]+);`, 'i'))
  const got = m && m[1].trim()
  check(`${tok} is still ${want}${got && got !== want ? ` — found ${got}` : ''}`, got === want)
}

/* --onfill and --surface are both white TODAY. They are separate tokens
 * precisely because that coincidence is not a guarantee, so the fence proves
 * the views actually distinguish them rather than treating either as spare. */
const consolidatedSrc = consolidated.map((f) => decomment(read('views', f))).join('\n')
check('white-on-a-fill uses --onfill (foreground), not --surface',
  /color:\s*var\(--onfill\)/.test(consolidatedSrc))
check('painted surfaces still use --surface, not --onfill',
  /background:\s*var\(--surface\)/.test(consolidatedSrc))
check('--onfill is never used as a background',
  !/background(-color)?:\s*var\(--onfill\)/.test(consolidatedSrc))
check('--surface is never used as a text colour',
  !/(^|[^-])color:\s*var\(--surface\)/m.test(consolidatedSrc))

console.log('\n========================================')
console.log(`  ${pass}/${pass + fail} passed`)
console.log('========================================\n')

if (fail) process.exit(1)
