/**
 * Vendors the webfonts Spot Me ships, from Google Fonts into public/fonts/,
 * and regenerates src/fonts.css to match.
 *
 * WHY THE FONTS ARE VENDORED AT ALL. Loading them from fonts.googleapis.com
 * put two extra hosts on the critical path — the browser had to fetch a
 * stylesheet from one before it could discover the font URLs on a second —
 * and told Google the IP of every person who opened the app, every load. A
 * private messenger should not leak its readers as a side effect of having a
 * typeface.
 *
 * WHY THE FILES ARE DEDUPED. Google serves these families as VARIABLE fonts:
 * every weight of a given family+subset is byte-for-byte the same file, and
 * only the `font-weight` in each @font-face differs. Downloading one file per
 * weight stores the same bytes 4–5 times and, worse, makes the browser fetch
 * them separately. Deduping by content hash took 26 files to 6.
 *
 * WHY THE WEIGHTS STAY DISCRETE. These are variable fonts, so a single face
 * declared `font-weight: 200 800` would be tempting — and would silently
 * RESTYLE the app. The design system uses 640 and 650 (see 05-DESIGN-SYSTEM.md
 * §2); against discrete faces CSS font-matching snaps those to 700, while a
 * range face would render them at a true, visibly lighter 640. The palette and
 * the type scale are LOCKED, so this vendoring reproduces exactly what Google
 * served — same faces, same weights, same unicode-ranges — and changes only
 * where the bytes come from.
 *
 * EVERY SUBSET IS KEPT. This app translates and transliterates; dropping
 * cyrillic-ext or vietnamese would degrade precisely the readers who need
 * them. The unicode-range split means nobody downloads a script they never
 * type.
 *
 *   node scripts/fetch-fonts.mjs
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..')
const FONT_DIR = join(WEB, 'public', 'fonts')
const OUT_CSS = join(WEB, 'src', 'fonts.css')

/* The families this app ships. Adding one here is the only supported way to
 * add a face — edit this list and re-run.
 *
 * `subsets` restricts which unicode-range blocks are kept. The Noto families
 * ship latin and latin-ext blocks of their own, and keeping them would vendor
 * a second, worse Latin face that can never render: within a family the
 * browser picks by unicode-range, but ACROSS families the stack order decides,
 * and Sora is always ahead. Keeping only the script each font is here for is
 * what stops this directory quadrupling in size for no rendered pixel.
 *
 * Weights cost almost nothing to add. These are variable fonts, so every
 * weight of a family and subset is the same file — more weights means more
 * @font-face declarations pointing at bytes already on disk. The Indic faces
 * therefore carry the full set the UI actually uses (400 body, 500/600/700
 * labels, names and emphasis) rather than a guess. 800 is the wordmark only,
 * which is Latin, so the Indic faces stop at 700. */
const LATIN_WEIGHTS = [400, 500, 600, 700, 800]
const UI_WEIGHTS = [400, 500, 600, 700]

/* One Noto family per script in LANGS (src/lib/translate.js), where "Indian
 * languages are first-class". Without these, a reader whose system lacks the
 * script sees tofu — and the language picker renders every native name at
 * once, so it is the app's own UI that breaks, not just message content.
 *
 *   Devanagari  Hindi, Marathi, Konkani      Bengali    Bengali, Assamese
 *   Kannada     Kannada, Tulu                Gurmukhi   Punjabi
 *   Tamil / Telugu / Malayalam / Odia / Gujarati — one language each
 *
 * Urdu (ur) is Arabic script, not Indic, and wants Nastaliq rather than a
 * naskh Noto Sans to be read comfortably. It is deliberately NOT covered
 * here — doing it badly would look like it was handled. */
const FAMILIES = [
  { family: 'Sora', weights: LATIN_WEIGHTS },
  { family: 'Plus Jakarta Sans', weights: UI_WEIGHTS },
  { family: 'Noto Sans Devanagari', weights: UI_WEIGHTS, subsets: ['devanagari'] },
  { family: 'Noto Sans Tamil', weights: UI_WEIGHTS, subsets: ['tamil'] },
  { family: 'Noto Sans Telugu', weights: UI_WEIGHTS, subsets: ['telugu'] },
  { family: 'Noto Sans Bengali', weights: UI_WEIGHTS, subsets: ['bengali'] },
  { family: 'Noto Sans Kannada', weights: UI_WEIGHTS, subsets: ['kannada'] },
  { family: 'Noto Sans Malayalam', weights: UI_WEIGHTS, subsets: ['malayalam'] },
  { family: 'Noto Sans Oriya', weights: UI_WEIGHTS, subsets: ['oriya'] },
  { family: 'Noto Sans Gujarati', weights: UI_WEIGHTS, subsets: ['gujarati'] },
  { family: 'Noto Sans Gurmukhi', weights: UI_WEIGHTS, subsets: ['gurmukhi'] },
]

/* Google serves woff2 only to browsers it recognises; with Node's default
 * agent string it returns truetype, which is ~3x the bytes. */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36'

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/* One request per family, so a family's subsets can be filtered independently
 * and a failure names the family that caused it. */
const blocks = []
for (const { family, weights, subsets } of FAMILIES) {
  const spec = `${family.replace(/ /g, '+')}:wght@${weights.join(';')}`
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${spec}&display=swap`, {
    headers: { 'User-Agent': UA },
  }).then((r) => {
    if (!r.ok) throw new Error(`Google Fonts returned ${r.status} for ${family}`)
    return r.text()
  })

  /* Each @font-face is preceded by a /* subset *\/ comment naming its range. */
  const found = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{(.*?)\}/gs)]
  if (!found.length) throw new Error(`no @font-face blocks parsed for ${family} — did the API change?`)

  const kept = subsets ? found.filter(([, s]) => subsets.includes(s)) : found
  if (!kept.length) {
    throw new Error(
      `${family}: none of the requested subsets [${subsets}] are served — ` +
      `available: ${[...new Set(found.map(([, s]) => s))].join(', ')}`)
  }
  blocks.push(...kept)
}

const field = (body, re, what) => {
  const m = body.match(re)
  if (!m) throw new Error(`@font-face is missing ${what}`)
  return m[1].trim()
}

await rm(FONT_DIR, { recursive: true, force: true })
await mkdir(FONT_DIR, { recursive: true })

const byHash = new Map()   // content hash -> filename on disk
const faces = []

for (const [, subset, body] of blocks) {
  const family = field(body, /font-family:\s*'([^']+)'/, 'font-family')
  const weight = field(body, /font-weight:\s*(\d+)/, 'font-weight')
  const style = field(body, /font-style:\s*(\w+)/, 'font-style')
  const url = field(body, /url\((https:\/\/[^)]+\.woff2)\)/, 'a woff2 url')
  const range = field(body, /unicode-range:\s*([^;]+);/, 'unicode-range')

  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.subarray(0, 4).toString() !== 'wOF2') {
    throw new Error(`${url} is not a woff2 file`)
  }

  const hash = createHash('sha256').update(bytes).digest('hex')
  let file = byHash.get(hash)
  if (!file) {
    /* Named for what it IS — family and subset — not for the weight, because
     * one variable file backs every weight of that family and subset. */
    file = `${slug(family)}-${subset}.woff2`
    await writeFile(join(FONT_DIR, file), bytes)
    byHash.set(hash, file)
  }
  faces.push({ subset, family, style, weight, file, range })
}

const header = `/* Spot Me — self-hosted webfonts. GENERATED, DO NOT HAND-EDIT.
 *
 * Regenerate with:  node scripts/fetch-fonts.mjs
 * That script carries the reasoning; the short version is that these bytes
 * are exactly what Google Fonts served, vendored so the critical path holds
 * no third-party host and no reader's IP leaves the origin to load a
 * typeface. Weights stay discrete on purpose — a variable range face would
 * re-render the design system's 640/650 weights and the type scale is LOCKED.
 *
 * ${faces.length} faces over ${byHash.size} files: every weight of a family and subset is
 * the same variable file, so they are stored once and shared.
 */
`

const body = faces.map(({ subset, family, style, weight, file, range }) => `
/* ${subset} */
@font-face {
  font-family: '${family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url('/fonts/${file}') format('woff2');
  unicode-range: ${range};
}
`).join('')

await writeFile(OUT_CSS, header + body)

console.log(`${faces.length} faces -> ${byHash.size} files in public/fonts/`)
console.log(`wrote ${OUT_CSS.replace(WEB + '/', '')}`)
