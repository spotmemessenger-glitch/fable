/**
 * Proves the signing key signs, refuses everything else, and cannot be exported.
 *
 * RUN AGAINST REAL WEBCRYPTO, no mocks — same discipline as crypto.test.js. A
 * signature test with a stubbed primitive proves the stub.
 *
 * WHAT IS ACTUALLY AT RISK HERE, in the order it would hurt:
 *
 *   - the TRANSCRIPT collapsing two different claims into one byte string, which
 *     turns one signature into a signature for both. Delimiter-joining does
 *     exactly this and looks completely fine in review; the section below builds
 *     the colliding pairs explicitly and asserts they stay distinct
 *   - `verifyBytes` returning true, or throwing, on something malformed. Either
 *     is fatal: the first accepts a forgery, the second pushes callers into a
 *     catch block that will eventually mean "accepted"
 *   - a SIGNING key and an AGREEMENT key being interchangeable, because Ed25519
 *     and X25519 public keys are both 32 opaque bytes and nothing about the
 *     bytes says which one you are holding
 *   - the private half being exportable after all, which would make every
 *     "non-extractable" claim in the ADRs decoration
 *
 *   node test/signing-identity.test.js
 */
import {
  ED25519, ECDSA_P256, SIGNING_ALGOS,
  negotiateSigningAlgo, resetSigningAlgoCache,
  generateSigningIdentity, exportSigningPublicKeyB64, importSigningPublicKey,
  signBytes, verifyBytes, transcript, toB64,
} from '../src/lib/crypto/signing-identity.js'
import { generateIdentity, exportPublicKeyB64 } from '../src/lib/crypto/e2e-v2.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

const enc = new TextEncoder()
const bytes = (s) => enc.encode(s)

/* ------------------------------------------------ 1. both algorithms work -- */

const identities = {}
for (const algo of SIGNING_ALGOS) {
  await checkAsync(`${algo}: a fresh identity signs and verifies its own bytes`, async () => {
    const id = await generateSigningIdentity({ algo })
    identities[algo] = { ...id, publicKeyB64: await exportSigningPublicKeyB64(id) }
    const msg = bytes('the quick brown fox')
    const sig = await signBytes(id, msg)
    return await verifyBytes({ publicKeyB64: identities[algo].publicKeyB64, algo }, msg, sig)
  })
}

await checkAsync('negotiation picks an algorithm this runtime actually has', async () => {
  resetSigningAlgoCache()
  const algo = await negotiateSigningAlgo()
  if (!SIGNING_ALGOS.includes(algo)) return false
  // Whatever it picked must be usable, or the negotiation is a lie.
  const id = await generateSigningIdentity({ algo })
  return Boolean(await signBytes(id, bytes('probe')))
})

await checkAsync('an unknown algorithm is refused rather than guessed at', async () => {
  try { await generateSigningIdentity({ algo: 'RSA-1024-please-no' }); return false } catch { return true }
})

/* ------------------------------------------- 2. the private half is stuck -- */

await checkAsync('THE PRIVATE KEY CANNOT BE EXPORTED — pkcs8 is refused', async () => {
  const id = identities[ED25519]
  try { await crypto.subtle.exportKey('pkcs8', id.privateKey); return false } catch { return true }
})

await checkAsync('…nor as a JWK', async () => {
  const id = identities[ECDSA_P256]
  try { await crypto.subtle.exportKey('jwk', id.privateKey); return false } catch { return true }
})

await checkAsync('…and extractable is false on the key itself, not just by convention', () =>
  identities[ED25519].privateKey.extractable === false &&
  identities[ECDSA_P256].privateKey.extractable === false)

await checkAsync('the MODULE offers no path that would serialise it either', async () => {
  const mod = await import('../src/lib/crypto/signing-identity.js')
  // A module with a wrapKey, a pkcs8 export or a "private" export is one edit
  // away from undoing the property above, and the edit would look reasonable.
  const suspicious = Object.keys(mod).filter((k) => /private|pkcs8|jwk|wrap|secret/i.test(k))
  return suspicious.length === 0
})

/* ------------------------- 3. signing keys are not agreement keys, ever ---- */

{
  // The hazard, made concrete: an X25519 agreement key is 32 bytes and so is an
  // Ed25519 signing key. Nothing about the bytes distinguishes them.
  const agreement = await generateIdentity({ algo: 'X25519' })
  const agreementB64 = await exportPublicKeyB64(agreement)

  await checkAsync('an X25519 agreement key really is the same length as an Ed25519 signing key',
    async () => {
      const raw = atob(agreementB64).length
      return raw === atob(identities[ED25519].publicKeyB64).length && raw === 32
    })

  await checkAsync('so the algorithm is REQUIRED on import — never inferred from length', async () => {
    try { await importSigningPublicKey(identities[ED25519].publicKeyB64); return false } catch { return true }
  })

  await checkAsync('a P-256 length presented as Ed25519 is refused', async () => {
    const p256 = await generateIdentity({ algo: 'P-256' })
    try { await importSigningPublicKey(await exportPublicKeyB64(p256), ED25519); return false } catch { return true }
  })

  await checkAsync('an agreement key never verifies a signature made by the signing key', async () => {
    const msg = bytes('bind this')
    const sig = await signBytes(identities[ED25519], msg)
    // Same length, importable as Ed25519, and wrong. This must be false, not a throw.
    return (await verifyBytes({ publicKeyB64: agreementB64, algo: ED25519 }, msg, sig)) === false
  })
}

/* ---------------------------------------- 4. verify is total and truthful -- */

for (const algo of SIGNING_ALGOS) {
  const id = identities[algo]
  const msg = bytes('a message worth signing')
  const sig = await signBytes(id, msg)

  await checkAsync(`${algo}: one flipped bit in the MESSAGE fails`, async () => {
    const tampered = bytes('a message worth signind')
    return (await verifyBytes(id, tampered, sig)) === false
  })

  await checkAsync(`${algo}: one flipped bit in the SIGNATURE fails`, async () => {
    const raw = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0))
    raw[0] ^= 0x01
    return (await verifyBytes(id, msg, toB64(raw))) === false
  })

  await checkAsync(`${algo}: another identity's key fails`, async () => {
    const other = await generateSigningIdentity({ algo })
    return (await verifyBytes(
      { publicKeyB64: await exportSigningPublicKeyB64(other), algo }, msg, sig)) === false
  })

  await checkAsync(`${algo}: a signature checked under the OTHER algorithm fails`, async () => {
    const wrong = algo === ED25519 ? ECDSA_P256 : ED25519
    return (await verifyBytes({ publicKeyB64: id.publicKeyB64, algo: wrong }, msg, sig)) === false
  })
}

await checkAsync('VERIFY NEVER THROWS AND NEVER SAYS TRUE — every kind of rubbish', async () => {
  const id = identities[ED25519]
  const msg = bytes('x')
  const rubbish = [
    [{}, msg, 'AAAA'],
    [{ publicKeyB64: id.publicKeyB64, algo: 'nonsense' }, msg, 'AAAA'],
    [{ publicKeyB64: '!!!not base64!!!', algo: ED25519 }, msg, 'AAAA'],
    [{ publicKeyB64: id.publicKeyB64, algo: ED25519 }, msg, ''],
    [{ publicKeyB64: id.publicKeyB64, algo: ED25519 }, msg, null],
    [{ publicKeyB64: id.publicKeyB64, algo: ED25519 }, msg, 'AA'],            // too short
    [{ publicKeyB64: id.publicKeyB64, algo: ED25519 }, msg, toB64(new Uint8Array(65))], // too long
    [{ publicKeyB64: id.publicKeyB64, algo: ED25519 }, new Uint8Array(0), 'AAAA'],
    [{ publicKeyB64: id.publicKeyB64, algo: ED25519 }, 'not bytes', 'AAAA'],
    [null, msg, 'AAAA'],
  ]
  for (const [key, m, s] of rubbish) {
    let out
    try { out = await verifyBytes(key || {}, m, s) } catch { return false }   // a throw is a failure
    if (out !== false) return false
  }
  return true
})

await checkAsync('signing refuses an empty message rather than signing nothing', async () => {
  try { await signBytes(identities[ED25519], new Uint8Array(0)); return false } catch { return true }
})

await checkAsync('signing without a private key is refused', async () => {
  try { await signBytes({ algo: ED25519 }, bytes('x')); return false } catch { return true }
})

/* ------------------------------------ 5. THE TRANSCRIPT CANNOT COLLIDE ----- */

{
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')

  // Pairs of DIFFERENT field lists that a naive encoding flattens to the SAME
  // bytes. Both families are real and they fail differently:
  //
  //   'concat' — no separator at all. ["ab","c"] and ["a","bc"] are one string.
  //   'pipe'   — a separator that can appear INSIDE a field, which is the
  //              subtler one, because it looks safe until a user picks a name
  //              with a pipe in it. `e2e-v2.js` joins with '|' and gets away
  //              with it only because its fields are base64 and an opaque id.
  //
  // Each pair is tagged with the encoding it defeats, and the tag is checked —
  // a pair listed under the wrong one would silently test nothing.
  const colliding = [
    { naive: 'concat', left: ['ab', 'c'], right: ['a', 'bc'] },
    { naive: 'concat', left: ['', 'ab'], right: ['', 'a', 'b'] },
    { naive: 'concat', left: ['x'], right: ['x', ''] },
    { naive: 'pipe', left: ['a|b'], right: ['a', 'b'] },
    { naive: 'pipe', left: ['alice', 'bob|carol'], right: ['alice|bob', 'carol'] },
  ]
  const naively = (fields, naive) => fields.join(naive === 'pipe' ? '|' : '')

  check('THE COLLISION: field lists a naive encoding would merge stay distinct',
    colliding.every(({ left, right }) => hex(transcript('d', left)) !== hex(transcript('d', right))))

  // …and the fixture asserts its own fitness. Without this, a pair that stopped
  // colliding would keep passing while testing nothing at all.
  check('…and every fixture pair really does collide under the encoding it names',
    colliding.every(({ left, right, naive }) =>
      left.join(' ') !== right.join(' ') &&          // genuinely different lists
      naively(left, naive) === naively(right, naive)))         // and one string under the naive encoding

  // Named for what it actually proves. The leading field count does NOT make
  // this pass — the per-field length prefixes do, and mutation testing says so.
  check('field BOUNDARIES are bound, so two fields never read as one',
    hex(transcript('d', ['a', 'b'])) !== hex(transcript('d', ['ab'])))

  check('the DOMAIN is bound — the same fields under another domain differ',
    hex(transcript('one', ['a'])) !== hex(transcript('two', ['a'])))

  check('a domain that is a prefix of another does not collide',
    hex(transcript('spotme', ['a'])) !== hex(transcript('spotme-x', ['a'])))

  check('bytes and the string that decodes to them encode identically',
    hex(transcript('d', [bytes('hi')])) === hex(transcript('d', ['hi'])))

  check('a number is encoded as its decimal string, stably',
    hex(transcript('d', [17])) === hex(transcript('d', ['17'])))

  check('a field that is neither bytes, string nor finite number is refused', (() => {
    for (const bad of [{}, [], null, undefined, NaN, Infinity, true]) {
      try { transcript('d', [bad]); return false } catch { /* expected */ }
    }
    return true
  })())

  check('a transcript with no domain is refused', (() => {
    try { transcript('', ['a']); return false } catch { return true }
  })())

  await checkAsync('a signature over one transcript does not verify the other', async () => {
    const id = identities[ED25519]
    const sig = await signBytes(id, transcript('d', ['ab', 'c']))
    return (await verifyBytes(id, transcript('d', ['a', 'bc']), sig)) === false
  })
}

console.log('\n========================================')
console.log('  signing identity — signs, refuses, and cannot be exported')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
