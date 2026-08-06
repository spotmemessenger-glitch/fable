/**
 * The share deeplink: `#/posts?m=<id>` must open THAT post.
 *
 * Two halves, and both matter:
 *   1. the hash parser is exercised for real (not asserted as source text), so
 *      the route survives a query string instead of falling through to the
 *      default screen — which is precisely what made every shared link open
 *      the wrong view;
 *   2. source-level fences on the wiring the parser alone cannot prove: that
 *      the router routes on the PATH, that the view receives the parameters,
 *      and that a post that cannot be found says so rather than silently
 *      showing an ordinary feed.
 *
 *   node test/share-deeplink.test.js
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitHash } from '../src/lib/hash-route.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(join(HERE, '..', ...p), 'utf8')
const decomment = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

console.log('\nshare deeplink — #/posts?m=<id> opens that post\n')

/* ---------------------------------------------------------- the parser */

const bare = splitHash('#/posts')
check('a bare route still parses to itself', bare.path === '#/posts')
check('a bare route carries no parameters', bare.params.get('m') === null)

const shared = splitHash('#/posts?m=mo-abc123')
check('a shared link routes on the PATH, not the whole hash', shared.path === '#/posts')
check('the post id is recovered from the query', shared.params.get('m') === 'mo-abc123')

// The share button builds its URL with encodeURIComponent, so the parser has
// to give back the DECODED id or the lookup silently never matches.
const encoded = splitHash('#/posts?m=' + encodeURIComponent('mo-a b/c'))
check('an encoded id round-trips back to its original value', encoded.params.get('m') === 'mo-a b/c')

const multi = splitHash('#/posts?m=mo-1&from=share')
check('extra parameters do not disturb the route', multi.path === '#/posts')
check('extra parameters are readable', multi.params.get('from') === 'share')

check('a hash with no leading route is handled', splitHash('').path === '')
check('a non-string hash does not throw', splitHash(undefined).path === '')

/* ------------------------------------------------------- the wiring */

const main = decomment(read('src', 'main.js'))
const view = decomment(read('src', 'views', 'moments.js'))

check(
  'the router resolves its view from the parsed PATH',
  /const\s*\{\s*path\s*,\s*params\s*\}\s*=\s*splitHash\(hash\)/.test(main) &&
  /ROUTES\[path\]/.test(main)
)
check(
  'the active tab is chosen by path, so a shared link still lights Posts',
  /updateNav\(path in ROUTES/.test(main)
)
check(
  'the view is handed the parsed parameters',
  /view\.render\(viewContainer,\s*ctx,\s*params\)/.test(main)
)
check(
  'the moments view accepts the parameters',
  /export function render \(root, ctx, params\)/.test(view)
)
check(
  'the requested post id is read from the parameters',
  /params\?\.get\?\.\('m'\)/.test(view)
)
check(
  'cards carry their id, so the shared post can be located in the DOM',
  /'data-moment-id':\s*m\.id/.test(view)
)
check(
  'a post that is not on the first page is paged toward, not given up on',
  /focusPagesTried\s*<\s*FOCUS_MAX_PAGES/.test(view)
)
check(
  'a post that cannot be found says so rather than showing a silent feed',
  /isn’t in your feed|isn't in your feed/.test(view)
)
check(
  'the focus is consumed once, so paging afterwards does not re-yank the view',
  /focusId = null/.test(view)
)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
