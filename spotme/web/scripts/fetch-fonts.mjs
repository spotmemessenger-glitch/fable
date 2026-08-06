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

/* The families and weights index.html used to request. Keep in sync with the
 * weights the design system actually uses; adding one here is the only
 * supported way to add a face. */
const REQUEST =
  'family=Sora:wght@400;500;600;700;800' +
  '&family=Plus+Jakarta+Sans:wght@400;500;600;700' +
  '&display=swap'

/* Google serves woff2 only to browsers it recognises; with Node's default
 * agent string it returns truetype, which is ~3x the bytes. */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36'

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const css = await fetch(`https://fonts.googleapis.com/css2?${REQUEST}`, {
  headers: { 'User-Agent': UA },
}).then((r) => {
  if (!r.ok) throw new Error(`Google Fonts returned ${r.status}`)
  return r.text()
})

/* Each @font-face is preceded by a /* subset *\/ comment naming its range. */
const blocks = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{(.*?)\}/gs)]
if (!blocks.length) throw new Error('no @font-face blocks parsed — did the API change?')

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
