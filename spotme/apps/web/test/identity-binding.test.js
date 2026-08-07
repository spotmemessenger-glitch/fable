/**
 * Proves a signed binding says what it appears to say — and that a signature
 * alone was never enough.
 *
 * THE ATTACK THIS FILE IS BUILT AROUND. Mallory generates her own signing key,
 * takes Alice's PUBLISHED agreement key — public, the server hands it out — and
 * signs the claim "this agreement key is mine". The signature is completely
 * valid: it is her own key over her own statement, and nothing about a signature
 * makes a statement true. Without a second check she now holds a cryptographic
 * document asserting she owns a key she has never possessed.
 *
 * The proof of possession is what refuses it, and section 3 runs that attack end
 * to end rather than describing it.
 *
 * THE SECOND HALF OF THE SAME ATTACK is the relay: Mallory forwards the
 * verifier's challenge to Alice, who CAN answer it — it names her key. If Alice
 * answers, Mallory's forgery is complete. So Alice must refuse to prove a claim
 * she did not make, and section 4 is that refusal. It is the only place in the
 * protocol where the security property is a device being unhelpful.
 *
 * Real WebCrypto throughout, on both curve families, no mocks.
 *
 *   node test/identity-binding.test.js
 */
import { readFileSync } from 'node:fs'
import {
  bindingBytes, claimProblem, signBinding, verifyBindingSignature,
  RESULT, requireLiveAuthentication, BLOCKING_TRUST, CLAIM_FIELDS,
  makePopChallenge, answerPopChallenge, verifyPopAnswer, verifyLiveBinding,
  BIND_ERR, MAX_CLOCK_SKEW_MS, NONCE_BYTES,
} from '../src/lib/crypto/identity-binding.js'
import {
  generateSigningIdentity, exportSigningPublicKeyB64, ED25519, ECDSA_P256,
} from '../src/lib/crypto/signing-identity.js'
import { generateIdentity, exportPublicKeyB64 } from '../src/lib/crypto/e2e-v2.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

const NOW = 1_750_000_000_000

/** What a verifier that HAS checked its trust store passes in. Live
 *  authentication fails closed without it — see section 8. */
const TRUSTED = Object.freeze({ state: 'Pinned', revoked: false })

/** A whole device: a signing identity and an agreement identity, both real. */
async function device (accountId, { signingAlgo = ED25519, agreementAlgo = 'X25519' } = {}) {
  const signing = await generateSigningIdentity({ algo: signingAlgo })
  const agreement = await generateIdentity({ algo: agreementAlgo })
  return {
    accountId,
    deviceId: `${accountId}-device-1`,
    signing,
    signingKeyB64: await exportSigningPublicKeyB64(signing),
    agreement,
    agreementKeyB64: await exportPublicKeyB64(agreement),
    agreementAlgo,
  }
}

/** What a device publishes about itself. */
const bindFor = (d, at = NOW) => signBinding(d.signing, d.signingKeyB64, {
  agreementAlgo: d.agreementAlgo,
  agreementKeyB64: d.agreementKeyB64,
  accountId: d.accountId,
  deviceId: d.deviceId,
  issuedAt: at,
})

/** One full verification, as a verifier would drive it. */
async function fullCheck (claim, sig, answerer, expect) {
  const { challenge, privateKey } = await makePopChallenge({ agreementAlgo: claim.agreementAlgo })
  const answer = await answerPopChallenge({
    agreement: answerer.agreement,
    agreementKeyB64: answerer.agreementKeyB64,
    signingKeyB64: answerer.signingKeyB64,
    claim,
    challenge,
  })
  const out = await verifyLiveBinding({
    claim, sig, challenge, challengePrivateKey: privateKey, mac: answer.mac,
    expect: { at: NOW, trust: TRUSTED, ...expect },
  })
  return { answer, out }
}

/* ------------------------------------------------- 1. the whole round trip -- */

// The two algorithms are INDEPENDENT axes — a device can have Ed25519 signing
// with P-256 agreement, or the reverse, depending on what its WebView shipped.
const COMBOS = [
  { signingAlgo: ED25519, agreementAlgo: 'X25519' },
  { signingAlgo: ECDSA_P256, agreementAlgo: 'P-256' },
  { signingAlgo: ED25519, agreementAlgo: 'P-256' },
  { signingAlgo: ECDSA_P256, agreementAlgo: 'X25519' },
]

for (const combo of COMBOS) {
  await checkAsync(`${combo.signingAlgo} signing over ${combo.agreementAlgo} agreement verifies end to end`, async () => {
    const alice = await device('alice', combo)
    const { claim, sig } = await bindFor(alice)
    const { answer, out } = await fullCheck(claim, sig, alice, {
      accountId: 'alice', agreementKeyB64: alice.agreementKeyB64, signingKeyB64: alice.signingKeyB64,
    })
    return answer.ok === true && out.ok === true
  })
}

const alice = await device('alice')
const bob = await device('bob')
const mallory = await device('mallory')
const signed = await bindFor(alice)

await checkAsync('a challenge nonce is the full length and is not reused', async () => {
  const a = await makePopChallenge({ agreementAlgo: 'X25519' })
  const b = await makePopChallenge({ agreementAlgo: 'X25519' })
  return atob(a.challenge.nonceB64).length === NONCE_BYTES &&
    a.challenge.nonceB64 !== b.challenge.nonceB64 &&
    a.challenge.publicKeyB64 !== b.challenge.publicKeyB64
})

/* --------------------------------------- 2. every field is really signed --- */

{
  const other = await device('other')
  // If a field were documented as bound but left out of the transcript, nothing
  // else in this suite would notice. So: change ONE field, expect refusal.
  const mutations = {
    signingAlgo: other.signing.algo === alice.signing.algo ? ECDSA_P256 : other.signing.algo,
    signingKeyB64: other.signingKeyB64,
    agreementAlgo: 'P-256',
    agreementKeyB64: other.agreementKeyB64,
    accountId: 'somebody-else',
    deviceId: 'a-different-device',
    issuedAt: NOW + 1,
  }

  let allRefused = true
  const stillSame = []
  for (const [field, value] of Object.entries(mutations)) {
    if (signed.claim[field] === value) { stillSame.push(field); continue }
    const tampered = { ...signed.claim, [field]: value }
    if ((await verifyBindingSignature(tampered, signed.sig)).signed) allRefused = false
  }
  check(`EVERY FIELD IS BOUND: changing any one of the ${Object.keys(mutations).length} refuses the signature`, allRefused)
  check('…and every mutation really did change its field', stillSame.length === 0)

  await checkAsync('the untampered claim still verifies, so the above is not vacuous',
    async () => (await verifyBindingSignature(signed.claim, signed.sig)).signed)

  await checkAsync('a claim with a field removed does not encode at all', async () => {
    for (const f of Object.keys(mutations)) {
      const gone = { ...signed.claim }
      delete gone[f]
      if (claimProblem(gone) === null) return false
      try { bindingBytes(gone); return false } catch { /* expected */ }
    }
    return true
  })
}

/* ------------------------ 3. THE FORGERY: a signature is not possession ---- */

{
  // Mallory signs, with her own real signing key, a claim naming ALICE's
  // published agreement key. Nothing stops her building this.
  const forged = await signBinding(mallory.signing, mallory.signingKeyB64, {
    agreementAlgo: alice.agreementAlgo,
    agreementKeyB64: alice.agreementKeyB64,       // <- not hers
    accountId: 'mallory',
    deviceId: 'mallory-device-1',
    issuedAt: NOW,
  })

  await checkAsync('the forged binding\'s SIGNATURE is perfectly valid — that is the problem',
    async () => (await verifyBindingSignature(forged.claim, forged.sig)).signed)

  await checkAsync('THE POP REFUSES IT: Mallory cannot answer for a key she does not hold', async () => {
    const { challenge, privateKey } = await makePopChallenge({ agreementAlgo: forged.claim.agreementAlgo })
    // She answers with the only agreement key she has.
    const mac = await answerPopChallenge({
      agreement: mallory.agreement,
      agreementKeyB64: alice.agreementKeyB64,        // she LIES about which key she holds
      signingKeyB64: mallory.signingKeyB64,
      claim: forged.claim,
      challenge,
    })
    // Her own guard does not stop her — she controls her client. The verifier does.
    const out = await verifyLiveBinding({
      claim: forged.claim, sig: forged.sig, challenge, challengePrivateKey: privateKey,
      mac: mac.mac || 'AAAA', expect: { at: NOW, trust: TRUSTED },
    })
    return out.ok === false && out.error.code === BIND_ERR.BAD_POP
  })

  await checkAsync('…and Alice, who does hold it, produces a MAC that is valid for HER claim only', async () => {
    const { challenge, privateKey } = await makePopChallenge({ agreementAlgo: 'X25519' })
    const hers = await answerPopChallenge({
      agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
      signingKeyB64: alice.signingKeyB64, claim: signed.claim, challenge,
    })
    const forHer = await verifyPopAnswer({ claim: signed.claim, challenge, challengePrivateKey: privateKey, mac: hers.mac })
    // The same MAC, offered for Mallory's claim, is worthless.
    const forHim = await verifyPopAnswer({ claim: forged.claim, challenge, challengePrivateKey: privateKey, mac: hers.mac })
    return forHer === true && forHim === false
  })
}

/* -------------------------------------------- 4. THE RELAY IS REFUSED ------ */

{
  const forged = await signBinding(mallory.signing, mallory.signingKeyB64, {
    agreementAlgo: alice.agreementAlgo,
    agreementKeyB64: alice.agreementKeyB64,
    accountId: 'mallory',
    deviceId: 'mallory-device-1',
    issuedAt: NOW,
  })
  const { challenge } = await makePopChallenge({ agreementAlgo: 'X25519' })

  await checkAsync('ALICE REFUSES to prove a claim signed by somebody else', async () => {
    const out = await answerPopChallenge({
      agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
      signingKeyB64: alice.signingKeyB64,
      claim: forged.claim,                       // names Mallory's signing key
      challenge,
    })
    return out.ok === false && out.error.code === BIND_ERR.NOT_MY_CLAIM
  })

  await checkAsync('…and refuses a claim naming an agreement key that is not hers either', async () => {
    const notHers = { ...signed.claim, agreementKeyB64: bob.agreementKeyB64 }
    const out = await answerPopChallenge({
      agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
      signingKeyB64: alice.signingKeyB64, claim: notHers, challenge,
    })
    return out.ok === false && out.error.code === BIND_ERR.NOT_MY_CLAIM
  })

  await checkAsync('a challenge on the wrong curve is refused rather than attempted', async () => {
    const wrongCurve = await makePopChallenge({ agreementAlgo: 'P-256' })
    const out = await answerPopChallenge({
      agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
      signingKeyB64: alice.signingKeyB64, claim: signed.claim, challenge: wrongCurve.challenge,
    })
    return out.ok === false && out.error.code === BIND_ERR.ALGO_MISMATCH
  })
}

/* ------------------------------------------------------- 5. replay ------- */

await checkAsync('A CAPTURED MAC DOES NOT REPLAY against a fresh challenge', async () => {
  const first = await makePopChallenge({ agreementAlgo: 'X25519' })
  const answer = await answerPopChallenge({
    agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
    signingKeyB64: alice.signingKeyB64, claim: signed.claim, challenge: first.challenge,
  })
  // A second verifier asks again. Same claim, same signature, new nonce and key.
  const second = await makePopChallenge({ agreementAlgo: 'X25519' })
  const out = await verifyLiveBinding({
    claim: signed.claim, sig: signed.sig, challenge: second.challenge,
    challengePrivateKey: second.privateKey, mac: answer.mac, expect: { at: NOW, trust: TRUSTED },
  })
  return out.ok === false && out.error.code === BIND_ERR.BAD_POP
})

await checkAsync('…even when only the NONCE changed and the challenge key did not', async () => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const first = await makePopChallenge({ agreementAlgo: 'X25519', nonce })
  const answer = await answerPopChallenge({
    agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
    signingKeyB64: alice.signingKeyB64, claim: signed.claim, challenge: first.challenge,
  })
  const swapped = { ...first.challenge, nonceB64: btoa(String.fromCharCode(...new Uint8Array(NONCE_BYTES))) }
  return (await verifyPopAnswer({
    claim: signed.claim, challenge: swapped, challengePrivateKey: first.privateKey, mac: answer.mac,
  })) === false
})

await checkAsync('A VALID PROOF DOES NOT EXCUSE A BAD SIGNATURE — the two checks are independent', async () => {
  /* Found by mutation testing: deleting the signature check from
   * `verifyLiveBinding` left every assertion in this file green, because
   * nothing here had ever paired a GOOD proof of possession with a BAD
   * signature. That combination is not exotic — it is what Alice's own device
   * produces if anything alters the claim after she signed it, and accepting it
   * would mean the account id, device id and timestamp are decorative. */
  const later = signed                                   // signed at NOW
  const earlier = await bindFor(alice, NOW - 1000)       // same device, different claim
  const { challenge, privateKey } = await makePopChallenge({ agreementAlgo: 'X25519' })
  const answer = await answerPopChallenge({
    agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
    signingKeyB64: alice.signingKeyB64, claim: later.claim, challenge,
  })
  const out = await verifyLiveBinding({
    claim: later.claim, sig: earlier.sig,                // Alice's signature, wrong claim
    challenge, challengePrivateKey: privateKey, mac: answer.mac, expect: { at: NOW, trust: TRUSTED },
  })
  // The proof really is good — otherwise this would pass for the wrong reason.
  const proofIsGood = await verifyPopAnswer({ claim: later.claim, challenge, challengePrivateKey: privateKey, mac: answer.mac })
  return proofIsGood === true && out.ok === false && out.error.code === BIND_ERR.BAD_SIGNATURE
})

await checkAsync('…and a signature from ANOTHER identity is refused even with a good proof', async () => {
  const forged = { ...signed.claim, signingKeyB64: bob.signingKeyB64, signingAlgo: bob.signing.algo }
  const { challenge, privateKey } = await makePopChallenge({ agreementAlgo: 'X25519' })
  // Alice would refuse this claim, so the MAC is computed directly — an attacker
  // is not bound by our client's guard, and the verifier must stand alone.
  const key = await answerPopChallenge({
    agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
    signingKeyB64: bob.signingKeyB64, claim: forged, challenge,
  })
  const out = await verifyLiveBinding({
    claim: forged, sig: signed.sig, challenge, challengePrivateKey: privateKey,
    mac: key.mac, expect: { at: NOW, trust: TRUSTED },
  })
  return key.ok === true && out.ok === false && out.error.code === BIND_ERR.BAD_SIGNATURE
})

await checkAsync('THE NAMES ARE NOT VARIANTS: a replayed binding passes the signature check and fails the live one',
  async () => {
    const stale = (await verifyBindingSignature(signed.claim, signed.sig)).signed
    const second = await makePopChallenge({ agreementAlgo: 'X25519' })
    const live = await verifyLiveBinding({
      claim: signed.claim, sig: signed.sig, challenge: second.challenge,
      challengePrivateKey: second.privateKey, mac: 'AAAA', expect: { at: NOW, trust: TRUSTED },
    })
    return stale === true && live.ok === false && live.error.code === BIND_ERR.BAD_POP
  })

/* ------------------------------------ 6. expectations, and their ordering -- */

{
  const wrong = async (expect) => {
    const { out } = await fullCheck(signed.claim, signed.sig, alice, expect)
    return out.error?.code
  }

  await checkAsync('a binding for another account is refused by name',
    async () => (await wrong({ accountId: 'bob' })) === BIND_ERR.WRONG_ACCOUNT)
  await checkAsync('…for another agreement key',
    async () => (await wrong({ agreementKeyB64: bob.agreementKeyB64 })) === BIND_ERR.WRONG_AGREEMENT_KEY)
  await checkAsync('…and signed by another identity — the pinned-identity check',
    async () => (await wrong({ signingKeyB64: bob.signingKeyB64 })) === BIND_ERR.WRONG_SIGNING_KEY)

  await checkAsync('a future-dated binding is refused; skew is tolerated', async () => {
    const future = await bindFor(alice, NOW + MAX_CLOCK_SKEW_MS + 1000)
    const bad = await fullCheck(future.claim, future.sig, alice, {})
    const skewed = await bindFor(alice, NOW + MAX_CLOCK_SKEW_MS - 1000)
    const ok = await fullCheck(skewed.claim, skewed.sig, alice, {})
    return bad.out.error?.code === BIND_ERR.FUTURE_DATED && ok.out.ok === true
  })

  await checkAsync('an OLD binding is accepted — freshness comes from the nonce, not the date', async () => {
    const old = await bindFor(alice, NOW - 365 * 24 * 3600_000)
    return (await fullCheck(old.claim, old.sig, alice, {})).out.ok === true
  })

  await checkAsync('THE ORDER: a wrong-account claim reports the account, not a crypto failure', async () => {
    // Corrupt the signature AND the account. The cheap, unambiguous check must
    // win, or a caller debugging a mismatch is sent to the wrong problem.
    const out = await verifyLiveBinding({
      claim: { ...signed.claim, accountId: 'someone' }, sig: 'AAAA',
      challenge: null, challengePrivateKey: null, mac: null,
      expect: { at: NOW, trust: TRUSTED, accountId: 'alice' },
    })
    return out.error?.code === BIND_ERR.WRONG_ACCOUNT
  })

  await checkAsync('a verifier that supplies no clock is refused rather than defaulted', async () => {
    const out = await verifyLiveBinding({ claim: signed.claim, sig: signed.sig, expect: {} })
    return out.ok === false && out.error.code === BIND_ERR.MALFORMED
  })
}

/* -------------------------------------------------- 7. total on rubbish --- */

await checkAsync('claimProblem names the first thing wrong and never throws', () => {
  const cases = [null, undefined, 'string', 42, {}, { ...signed.claim, issuedAt: 'soon' },
    { ...signed.claim, signingAlgo: 'RSA' }, { ...signed.claim, agreementAlgo: 'curve25519' },
    { ...signed.claim, accountId: '' }]
  return cases.every((c) => typeof claimProblem(c) === 'string') && claimProblem(signed.claim) === null
})

await checkAsync('verifyLiveBinding never throws, whatever it is handed', async () => {
  const cases = [
    {}, { claim: null }, { claim: signed.claim }, { claim: signed.claim, sig: 'AAAA', expect: { at: NOW } },
    { claim: signed.claim, sig: signed.sig, expect: { at: NOW, trust: TRUSTED } },
    { claim: signed.claim, sig: signed.sig, challenge: {}, mac: 'x', expect: { at: NOW, trust: TRUSTED } },
  ]
  for (const c of cases) {
    let out
    try { out = await verifyLiveBinding(c) } catch { return false }
    if (out.ok !== false || typeof out.error?.code !== 'string') return false
  }
  return true
})

await checkAsync('verifyPopAnswer never throws and never says true on rubbish', async () => {
  const cases = [
    {}, { claim: signed.claim }, { claim: signed.claim, challenge: {}, mac: 'x' },
    { claim: signed.claim, challenge: { algo: 'X25519', publicKeyB64: '!!', nonceB64: '!!' }, mac: 'x' },
    { claim: null, challenge: null, mac: null },
  ]
  for (const c of cases) {
    let out
    try { out = await verifyPopAnswer(c) } catch { return false }
    if (out !== false) return false
  }
  return true
})

await checkAsync('answerPopChallenge never throws and reports a code', async () => {
  const cases = [{}, { claim: signed.claim }, { agreement: alice.agreement, claim: null }]
  for (const c of cases) {
    let out
    try { out = await answerPopChallenge(c) } catch { return false }
    if (out.ok !== false || typeof out.error?.code !== 'string') return false
  }
  return true
})


/* ========== 8. HISTORICAL IS NOT LIVE, AND THE TYPE SYSTEM SAYS SO ========= */

{
  /* An earlier version distinguished these only by NAME, and returned a bare
   * boolean from the weaker one. A bare boolean fits anywhere a boolean is
   * expected, so nothing structural stopped a historical signature check being
   * spent as current authentication. These assertions are that hole, closed. */

  await checkAsync('a historical check is TAGGED as historical, not returned bare', async () => {
    const h = await verifyBindingSignature(signed.claim, signed.sig)
    return h.kind === RESULT.HISTORICAL && h.signed === true && typeof h !== 'boolean'
  })

  await checkAsync('THE NEGATIVE TEST: a VALID historical result is REFUSED where live auth is required',
    async () => {
      const h = await verifyBindingSignature(signed.claim, signed.sig)
      if (h.signed !== true) return false          // it really is a good signature
      try { requireLiveAuthentication(h); return false } catch { return true }
    })

  check('…and so is a bare true, which is what the old API would have handed over', (() => {
    for (const junk of [true, 1, 'ok', {}, null, undefined, { ok: true }]) {
      try { requireLiveAuthentication(junk); return false } catch { /* expected */ }
    }
    return true
  })())

  await checkAsync('a successful LIVE result passes the gate', async () => {
    const { out } = await fullCheck(signed.claim, signed.sig, alice, {})
    return out.kind === RESULT.LIVE && requireLiveAuthentication(out) === out
  })

  await checkAsync('…and a FAILED live result is refused even though it is correctly tagged', async () => {
    const { out } = await fullCheck(signed.claim, signed.sig, alice, { accountId: 'somebody-else' })
    if (out.kind !== RESULT.LIVE || out.ok !== false) return false
    try { requireLiveAuthentication(out); return false } catch { return true }
  })
}

/* ========== 9. CRYPTOGRAPHIC VALIDITY IS NOT TRUST FRESHNESS ============== */

{
  const liveWith = async (trust) => {
    const { challenge, privateKey } = await makePopChallenge({ agreementAlgo: 'X25519' })
    const answer = await answerPopChallenge({
      agreement: alice.agreement, agreementKeyB64: alice.agreementKeyB64,
      signingKeyB64: alice.signingKeyB64, claim: signed.claim, challenge,
    })
    return verifyLiveBinding({
      claim: signed.claim, sig: signed.sig, challenge, challengePrivateKey: privateKey,
      mac: answer.mac, expect: { at: NOW, ...(trust === undefined ? {} : { trust }) },
    })
  }

  await checkAsync('THE POINT: perfect cryptography with UNKNOWN trust is NOT authentication', async () => {
    const out = await liveWith(undefined)
    return out.ok === false && out.error.code === 'TRUST_UNKNOWN' &&
      // and the evidence says why it is not a crypto failure
      out.evidence.signatureValid === true && out.evidence.possessionProved === true &&
      out.evidence.trustChecked === false
  })

  await checkAsync('a REVOKED identity fails even with a perfect signature and proof', async () => {
    const out = await liveWith({ state: 'Verified', revoked: true })
    return out.ok === false && out.error.code === 'REVOKED' &&
      out.evidence.signatureValid === true && out.evidence.possessionProved === true
  })

  await checkAsync('every blocking trust state fails, and none of them is a crypto error', async () => {
    for (const state of BLOCKING_TRUST) {
      const out = await liveWith({ state, revoked: false })
      if (out.ok !== false || out.error.code !== 'TRUST_BLOCKING') return false
      if (out.evidence.signatureValid !== true) return false
    }
    return true
  })

  await checkAsync('a trusted, unrevoked identity authenticates', async () => {
    const out = await liveWith(TRUSTED)
    return out.ok === true && out.evidence.trustChecked === true &&
      out.evidence.revoked === false && out.evidence.trustState === 'Pinned'
  })

  await checkAsync('the evidence records WHICH challenge the proof was bound to', async () => {
    const out = await liveWith(TRUSTED)
    return typeof out.evidence.challengeNonceB64 === 'string' &&
      out.evidence.challengeNonceB64.length > 0 && out.evidence.checkedAt === NOW
  })

  await checkAsync('the SIGNATURE remains valid regardless — that is the separation', async () => {
    // The same claim whose live authentication just failed for revocation still
    // has a correct signature. Both statements are true; only one is authority.
    const h = await verifyBindingSignature(signed.claim, signed.sig)
    const live = await liveWith({ state: 'Verified', revoked: true })
    return h.signed === true && live.ok === false
  })

  check('BLOCKING_TRUST matches identity-pin\'s own blocking states', (() => {
    const src = readFileSync(new URL('../src/lib/crypto/identity-pin.js', import.meta.url), 'utf8')
    // isBlocking is the definition; this list mirrors it by value on purpose.
    const m = src.match(/isBlocking\s*=\s*\(rec\)\s*=>[^\n]*\n?[^\n]*/)
    return Boolean(m) && BLOCKING_TRUST.every((st) => m[0].includes(st.toUpperCase()) || m[0].includes(st))
  })())
}

/* ========== 10. THE ADR AND THE CODE AGREE ON THE FIELD ORDER ============= */

{
  /* REVISION 4. The claim's field order is part of the wire format: two peers
   * that disagreed would produce different bytes and every signature would fail
   * closed. That is the right failure, and it is only safe if the order lives in
   * exactly one place and the document that specifies it cannot drift from the
   * code that implements it. This test is that mechanism. */
  const adr = readFileSync(
    new URL('../../../docs/adr/006-signing-identity-and-key-binding.md', import.meta.url), 'utf8')
  const block = adr.match(/<!-- CLAIM_FIELDS:BEGIN -->([\s\S]*?)<!-- CLAIM_FIELDS:END -->/)
  check('ADR-006 carries a machine-readable claim-field block', Boolean(block))
  const documented = block ? [...block[1].matchAll(/^\s*\d+\.\s*`([A-Za-z0-9_]+)`/gm)].map((m) => m[1]) : []
  check('THE DRIFT GUARD: the ADR\'s field order is exactly the code\'s',
    JSON.stringify(documented) === JSON.stringify([...CLAIM_FIELDS]))
  check('…and it is the full set, not a prefix that happens to match',
    documented.length === CLAIM_FIELDS.length && documented.length === 7)
}

console.log('\n========================================')
console.log('  identity binding — a signature is not possession')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
