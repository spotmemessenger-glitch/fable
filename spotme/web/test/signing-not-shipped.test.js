/**
 * Proves the A7 foundation is BUILT but NOT WIRED IN — no signing key is
 * generated on any device, and none can be published.
 *
 * WHY A TEST AND NOT A PROMISE IN A PULL REQUEST. Minting a signing key on a
 * real device is one-way. The moment one exists and is published it becomes the
 * anchor peers pin, and replacing it later is a visible trust event for every
 * conversation it touched — not a silent upgrade, and not something to discover
 * was switched on by an import added in passing. The owner has not authorised
 * that step. A statement in a PR description cannot enforce it; a failing build
 * can.
 *
 * SO THIS TEST IS SUPPOSED TO BE DELETED, eventually. When the owner authorises
 * generation, the right move is to change section 1 deliberately, in a change
 * whose whole subject is that authorisation. What it prevents is the OTHER
 * route: an unrelated feature adding an import, nobody noticing, and keys
 * quietly existing in the field.
 *
 * SECTION 2 IS THE COUNTERWEIGHT. "Not wired in" must not become "not looked
 * at" — unexercised crypto is worse than no crypto, because it looks finished.
 * So the same test that proves the modules are unreachable from the app also
 * proves they are reachable from the suite.
 *
 *   node test/signing-not-shipped.test.js
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')

/** The A7 modules themselves. They may import each other; nothing else may. */
const A7 = [
  'src/lib/crypto/signing-identity.js',
  'src/lib/crypto/identity-binding.js',
  // Phase 2 (Roadmap V2): the storage half. Inside the fence — it may import
  // the foundation; the app still may not reach key material through it.
  'src/lib/crypto/signing-key-store.js',
  // Phase 2B: the publication half. Inside the fence, SWITCHED OFF — the flag
  // default is asserted below, and no app module may import it at all.
  'src/lib/crypto/signing-key-publication.js',
]

function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full)
  }
  return out
}

const srcFiles = walk(SRC).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))
const testFiles = walk(TEST).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))

/* ------------------------------------------ 1. nothing in the app uses it -- */

{
  check('the two A7 modules are actually present, so section 1 is not vacuous',
    A7.every((p) => srcFiles.some((f) => f.path === p)))

  /* Other FENCED crypto foundation is not "the app". The e2e_v3 modules
   * legitimately consume the signing foundation — X3DH verifies a fetched
   * signed-prekey against the peer's signing key — and they are themselves
   * unreachable from the product, proven by `e2e-v3-not-shipped.test.js`. So
   * they are excluded from this fence's app scan: the two fences compose, and
   * one fenced module using another is not a leak into shipped code. */
  const OTHER_FENCED = ['src/lib/crypto/x3dh.js', 'src/lib/crypto/ratchet.js']
  const appFiles = srcFiles.filter((f) => !A7.includes(f.path) && !OTHER_FENCED.includes(f.path))
  const importers = appFiles.filter((f) =>
    /from\s+['"][^'"]*(signing-identity|identity-binding)\.js['"]/.test(f.body) ||
    /import\s*\(\s*['"][^'"]*(signing-identity|identity-binding)\.js['"]/.test(f.body))

  check(`NOT WIRED IN: none of the ${appFiles.length} other app modules import the signing foundation`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

  // The one act that cannot be undone, called out by name — an import is the
  // usual route in, but a re-export or a dynamic lookup would not be.
  const generators = appFiles.filter((f) => /\bgenerateSigningIdentity\s*\(/.test(f.body))
  check('NO KEY IS GENERATED: nothing in the app names generateSigningIdentity',
    generators.length === 0)
  if (generators.length) console.log('    named by:', generators.map((f) => f.path).join(', '))

  // And the other one: publishing. There is no endpoint for it, and no client
  // for an endpoint that does not exist.
  const publishers = appFiles.filter((f) =>
    /signingKey|signing_key|\/keys\/signing|signingPublicKey/.test(f.body))
  check('NOTHING IS PUBLISHED: no app module posts or reads a signing key',
    publishers.length === 0)
  if (publishers.length) console.log('    referenced by:', publishers.map((f) => f.path).join(', '))

  /* THE ONE PERMITTED CRACK IN THE FENCE, made exact. `wipeDevice` must clear
   * the signing store's module cache (delete the bytes AND forget the live
   * handle), so db.js may import the STORE — for that one function. Anything
   * wider is the fence failing: an app module that can LOAD the identity can
   * put key material on a code path nobody reviewed for it. */
  const storeUsers = appFiles.filter((f) => f.body.includes('signing-key-store'))
  check('the store is referenced by EXACTLY the wipe path and nothing else',
    storeUsers.length === 1 && storeUsers[0].path === 'src/lib/db.js')
  const wipe = appFiles.find((f) => f.path === 'src/lib/db.js')
  check('…and the wipe path touches ONLY forgetSigningIdentity — never load or rotate',
    Boolean(wipe) && wipe.body.includes('forgetSigningIdentity') &&
    !/loadSigningIdentity|rotateSigningIdentity|generateSigningIdentity/.test(wipe.body))

  /* Phase 2B: publication EXISTS now, and the fence tightens rather than
   * loosens. NO app module may import the publication module — there is no
   * permitted crack here, not even db.js — and the flag that would arm it
   * must default to false in the shipped source. The behavioural default is
   * asserted by test/signing-key-publication.test.js importing the real
   * module; this source check catches a flip that hides behind a build-time
   * substitution. */
  const publicationUsers = appFiles.filter((f) => f.body.includes('signing-key-publication'))
  check('PUBLICATION IS NOT WIRED: no app module imports the publication module',
    publicationUsers.length === 0)
  if (publicationUsers.length) console.log('    imported by:', publicationUsers.map((f) => f.path).join(', '))

  const pub = srcFiles.find((f) => f.path === 'src/lib/crypto/signing-key-publication.js')
  check('THE PUBLICATION FLAG IS OFF IN SOURCE: SIGNING_PUBLICATION_ENABLED = false',
    Boolean(pub) && /export const SIGNING_PUBLICATION_ENABLED = false/.test(pub.body))
}

/* ------------------------------------------ 2. …but it is not unexamined -- */

{
  const exercised = (needle) => testFiles.some((f) => f.body.includes(needle))

  check('the suite DOES generate signing keys — an unexercised key format is a document, not a foundation',
    exercised('generateSigningIdentity'))
  check('…and signs bindings with them', exercised('signBinding'))
  check('…and runs the proof of possession', exercised('answerPopChallenge'))
  check('…and drives the full verification', exercised('verifyLiveBinding'))
  check('…and the STORAGE half is exercised too — load, rotate, wipe-forget',
    exercised('loadSigningIdentity') && exercised('rotateSigningIdentity') &&
    exercised('forgetSigningIdentity'))
  check('…and the PUBLICATION half is exercised too — gate, payload, supersession',
    exercised('publishSigningIdentity') && exercised('signSupersession'))

  // Both modules must be imported by a test, or "covered" is an assumption.
  for (const p of A7) {
    const name = p.split('/').pop()
    check(`${name} is imported by at least one test`,
      testFiles.some((f) => f.body.includes(`/${name}`)))
  }
}

/* ---------------------------- 3. the private half has no way out, either -- */

{
  const mods = srcFiles.filter((f) => A7.includes(f.path))
  // exportKey on a PRIVATE key is the only way a non-extractable guarantee gets
  // undone, and 'raw' on a public key is the legitimate use. Anything reaching
  // for pkcs8 or jwk in these modules is reaching for the private half.
  /* CALL SHAPES, NOT BARE WORDS. The first version matched `wrapKey` anywhere
   * and duly failed on signing-identity.js's own header, which promises "no
   * wrapKey, no exportKey, no JWK" — a guard that punishes the documentation of
   * the property it guards is a guard people delete. */
  const leaks = mods.filter((f) =>
    /exportKey\s*\(\s*['"](pkcs8|jwk)['"]/.test(f.body) || /subtle\.wrapKey\s*\(/.test(f.body))
  check('NO EXPORT PATH: neither module can serialise a private key',
    leaks.length === 0)
  if (leaks.length) console.log('    in:', leaks.map((f) => f.path).join(', '))

  check('…and both generate their keys non-extractable',
    mods.every((f) => !/generateKey\s*\([^)]*,\s*true\s*,/.test(f.body)))
}

console.log('\n========================================')
console.log('  signing identity — built, tested, and deliberately not shipped')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
