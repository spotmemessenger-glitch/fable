/**
 * X3DH — proven against the REPRODUCIBLE 004a vectors, not against itself.
 *
 * The values below are not chosen; they are what
 * `spotme/docs/adr/004a-e2e-v3-vectors.mjs` prints, which in turn is what the
 * shipped derivation must produce. A ratchet or handshake tested only against
 * its own output is tested against its own misunderstanding — the DH order, the
 * HKDF salt, the label bytes all produce self-consistent nonsense if they are
 * wrong together. So this pins the exact shared secret and root key from the
 * spec, and separately proves initiator and responder CONVERGE (the property
 * that actually carries a conversation).
 *
 *   node test/x3dh.test.js
 */
import {
  dh, importX25519Public, rootKeyFromSharedSecret,
  x3dhInitiator, x3dhResponder, spkSignedBytes, verifyBundleSpk, toB64,
} from '../src/lib/crypto/x3dh.js'
import { generateSigningIdentity, exportSigningPublicKeyB64, signBytes } from '../src/lib/crypto/signing-identity.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/* The fixed private keys from 004a-e2e-v3-vectors.mjs — repeating bytes so they
 * can never be mistaken for real ones. Imported as non-extractable X25519
 * CryptoKeys via the PKCS8 prefix the vector generator uses. */
const PKCS8 = fromHex('302e020100300506032b656e04220420')
function fromHex (h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b }
const raw = (byte) => new Uint8Array(32).fill(byte)

async function priv (byte) {
  const pkcs8 = new Uint8Array(PKCS8.length + 32)
  pkcs8.set(PKCS8, 0); pkcs8.set(raw(byte), PKCS8.length)
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'])
}
// Public key derived from a fixed private key, as raw bytes → CryptoKey.
async function pub (byte) {
  // Derive the public half by importing the private key and exporting is not
  // possible for non-extractable keys, so use the KNOWN public bytes from the
  // vector output (computed once, pinned here alongside the private byte).
  return importX25519Public(fromHex(PUBHEX[byte]))
}
const PUBHEX = {
  0x11: '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13', // alice_ik
  0x22: '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20', // alice_ek
  0x33: '7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14', // bob_ik
  0x44: 'ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b', // bob_spk
  0x55: '38ab664bd86f77d7e66bdd9ae0792913a94fd8b33a1260027e4b46c1f4884c67', // bob_opk
}

/* --- expected values, straight from 004a §2/§3 ------------------------------ */
const EXPECT = {
  dh1: 'b21afd23cc289c5c693adc6d9c7198657e590320fa4dd7a0aaf606e441a2ea46',
  dh2: '1fdc192faa0212a9aae7bb4f41b580227fd5ad3e5d777faae230dfe973f3e805',
  dh3: 'd31a1338a14cf92083e61f66bf842151cf156318bcddc07e42443937c05dd640',
  dh4: '25bed864771ea4f3d83d9fdaa0ebe218d9feca2ba8f9b4940d069e505ff91d31',
  root: 'a3ed97dda551a5c3f96a52f6e57c0ad9aab98d74e1ce3a4e43154302c4a78ac2',
}
const SS = EXPECT.dh1 + EXPECT.dh2 + EXPECT.dh3 + EXPECT.dh4

/* --- 1. the four DH reproduce the spec bytes -------------------------------- */

await checkAsync('DH1 = DH(IK_A, SPK_B) matches 004a', async () =>
  hex(await dh(await priv(0x11), await pub(0x44))) === EXPECT.dh1)
await checkAsync('DH2 = DH(EK_A, IK_B) matches 004a', async () =>
  hex(await dh(await priv(0x22), await pub(0x33))) === EXPECT.dh2)
await checkAsync('DH3 = DH(EK_A, SPK_B) matches 004a', async () =>
  hex(await dh(await priv(0x22), await pub(0x44))) === EXPECT.dh3)
await checkAsync('DH4 = DH(EK_A, OPK_B) matches 004a', async () =>
  hex(await dh(await priv(0x22), await pub(0x55))) === EXPECT.dh4)

/* --- 2. the full initiator handshake reproduces SS and the root key --------- */

await checkAsync('THE VECTOR: initiator SS and root key match 004a exactly', async () => {
  const out = await x3dhInitiator({
    identityPriv: await priv(0x11),
    ephemeralPriv: await priv(0x22),
    peerIkPub: await pub(0x33),
    peerSpkPub: await pub(0x44),
    peerOpkPub: await pub(0x55),
  })
  return hex(out.sharedSecret) === SS && hex(out.rootKey) === EXPECT.root && out.usedOpk === true
})

await checkAsync('root key derivation in isolation matches, from the pinned SS', async () =>
  hex(await rootKeyFromSharedSecret(fromHex(SS))) === EXPECT.root)

/* --- 3. initiator and responder CONVERGE — the property that carries a chat -- */

await checkAsync('CONVERGENCE: responder reproduces the initiator root key (with OPK)', async () => {
  const init = await x3dhInitiator({
    identityPriv: await priv(0x11), ephemeralPriv: await priv(0x22),
    peerIkPub: await pub(0x33), peerSpkPub: await pub(0x44), peerOpkPub: await pub(0x55),
  })
  const resp = await x3dhResponder({
    identityPriv: await priv(0x33), spkPriv: await priv(0x44), opkPriv: await priv(0x55),
    peerIkPub: await pub(0x11), peerEkPub: await pub(0x22),
  })
  return hex(init.rootKey) === hex(resp.rootKey) && hex(init.sharedSecret) === hex(resp.sharedSecret)
})

await checkAsync('CONVERGENCE holds with NO one-time prekey — weaker, still agreed', async () => {
  const init = await x3dhInitiator({
    identityPriv: await priv(0x11), ephemeralPriv: await priv(0x22),
    peerIkPub: await pub(0x33), peerSpkPub: await pub(0x44), peerOpkPub: null,
  })
  const resp = await x3dhResponder({
    identityPriv: await priv(0x33), spkPriv: await priv(0x44), opkPriv: null,
    peerIkPub: await pub(0x11), peerEkPub: await pub(0x22),
  })
  return hex(init.rootKey) === hex(resp.rootKey) && init.usedOpk === false &&
    init.sharedSecret.length === 96 // three DH, no DH4
})

await checkAsync('the no-OPK root DIFFERS from the with-OPK root — DH4 actually contributes', async () => {
  const withOpk = await x3dhInitiator({
    identityPriv: await priv(0x11), ephemeralPriv: await priv(0x22),
    peerIkPub: await pub(0x33), peerSpkPub: await pub(0x44), peerOpkPub: await pub(0x55),
  })
  const without = await x3dhInitiator({
    identityPriv: await priv(0x11), ephemeralPriv: await priv(0x22),
    peerIkPub: await pub(0x33), peerSpkPub: await pub(0x44), peerOpkPub: null,
  })
  return hex(withOpk.rootKey) !== hex(without.rootKey)
})

/* --- 4. signed-prekey verification ------------------------------------------ */

await checkAsync('spkSignedBytes is IK||SPK, 64 bytes, order-sensitive', async () => {
  const ik = raw(0xaa); const spk = raw(0xbb)
  const bytes = spkSignedBytes(ik, spk)
  const swapped = spkSignedBytes(spk, ik)
  return bytes.length === 64 && hex(bytes.subarray(0, 32)) === hex(ik) &&
    hex(bytes.subarray(32)) === hex(spk) && hex(bytes) !== hex(swapped)
})

await checkAsync('a bundle signed by the device signing key VERIFIES', async () => {
  const signer = await generateSigningIdentity()
  signer.publicKeyB64 = await exportSigningPublicKeyB64(signer)
  const ik = raw(0x11); const spk = raw(0x44)
  const sig = await signBytes(signer, spkSignedBytes(ik, spk))
  return verifyBundleSpk({
    ikB64: toB64(ik), spkB64: toB64(spk), sigB64: sig,
    signingKey: { publicKeyB64: signer.publicKeyB64, algo: signer.algo },
  })
})

await checkAsync('a bundle whose SPK was swapped does NOT verify — substitution is caught', async () => {
  const signer = await generateSigningIdentity()
  signer.publicKeyB64 = await exportSigningPublicKeyB64(signer)
  const ik = raw(0x11); const spk = raw(0x44); const attackerSpk = raw(0x99)
  const sig = await signBytes(signer, spkSignedBytes(ik, spk))
  // The fetcher was served a DIFFERENT spk than the one that was signed.
  return (await verifyBundleSpk({
    ikB64: toB64(ik), spkB64: toB64(attackerSpk), sigB64: sig,
    signingKey: { publicKeyB64: signer.publicKeyB64, algo: signer.algo },
  })) === false
})

await checkAsync('a bundle signed by the WRONG key does not verify', async () => {
  const signer = await generateSigningIdentity()
  const attacker = await generateSigningIdentity()
  attacker.publicKeyB64 = await exportSigningPublicKeyB64(attacker)
  const ik = raw(0x11); const spk = raw(0x44)
  const sig = await signBytes(signer, spkSignedBytes(ik, spk))
  return (await verifyBundleSpk({
    ikB64: toB64(ik), spkB64: toB64(spk), sigB64: sig,
    signingKey: { publicKeyB64: attacker.publicKeyB64, algo: attacker.algo },
  })) === false
})

console.log('\n========================================')
console.log('  X3DH — agreed against the 004a vectors, not against itself')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
