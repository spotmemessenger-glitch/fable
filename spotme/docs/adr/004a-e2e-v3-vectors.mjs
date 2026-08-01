/**
 * Regenerates the e2e_v3 test vectors printed in 004a-e2e-v3-envelope-schema.md.
 *
 *   node spotme/docs/adr/004a-e2e-v3-vectors.mjs
 *
 * The point of this file is that the hex in the spec is REPRODUCIBLE rather than
 * asserted. Run it and diff the output against §10; they must agree, and if the
 * labels or the header layout are ever edited, this is what proves the spec was
 * updated with them.
 *
 * DELIBERATELY NOT IN `npm test`. e2e_v3 is PROPOSED and unapproved (ADR-004),
 * and nothing implements it — putting a spec-only artifact in the chain would
 * presume a decision the owner has not made. When v3 is approved and a reference
 * implementation is chosen, this becomes the differential-vector source and
 * moves into the chain then.
 *
 * It covers framing, AAD and the HKDF ladder ONLY. Chain-advance and skipped-key
 * vectors need a reference implementation and are the outstanding work called
 * out in §10 of the spec.
 *
 * Private keys are repeating bytes so they can never be mistaken for real ones.
 */
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto'

const hex = (b) => Buffer.from(b).toString('hex')
const b64 = (b) => Buffer.from(b).toString('base64')

/* --- fixed X25519 keys, chosen as repeating bytes so they are unmistakable -- */
const RAW = {
  alice_ik: Buffer.alloc(32, 0x11),
  alice_ek: Buffer.alloc(32, 0x22),
  bob_ik: Buffer.alloc(32, 0x33),
  bob_spk: Buffer.alloc(32, 0x44),
  bob_opk: Buffer.alloc(32, 0x55)
}

const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')

const priv = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' })
const pubOf = (raw) => createPublicKey(priv(raw))
const pubRaw = (raw) => pubOf(raw).export({ format: 'der', type: 'spki' }).subarray(SPKI.length)

console.log('=== 1. Public keys derived from the fixed private keys ===')
for (const [name, raw] of Object.entries(RAW)) {
  console.log(`${name.padEnd(10)} priv=${hex(raw).slice(0, 16)}...  pub=${hex(pubRaw(raw))}`)
}

/* --- 2. X3DH shared secret ------------------------------------------------ */
// SS = DH(IK_A, SPK_B) || DH(EK_A, IK_B) || DH(EK_A, SPK_B) || DH(EK_A, OPK_B)
const dh = (a, b) => diffieHellman({ privateKey: priv(a), publicKey: pubOf(b) })
const dh1 = dh(RAW.alice_ik, RAW.bob_spk)
const dh2 = dh(RAW.alice_ek, RAW.bob_ik)
const dh3 = dh(RAW.alice_ek, RAW.bob_spk)
const dh4 = dh(RAW.alice_ek, RAW.bob_opk)
const ss = Buffer.concat([dh1, dh2, dh3, dh4])

console.log('\n=== 2. X3DH ===')
console.log('DH1 (IK_A,SPK_B) =', hex(dh1))
console.log('DH2 (EK_A,IK_B)  =', hex(dh2))
console.log('DH3 (EK_A,SPK_B) =', hex(dh3))
console.log('DH4 (EK_A,OPK_B) =', hex(dh4))
console.log('SS (128 bytes)   =', hex(ss))

/* --- 3. HKDF ladder ------------------------------------------------------- */
// Domain-separated labels; salt is 32 zero bytes for the root, per Signal.
const L = {
  root: 'spotme/e2e_v3/root',
  chain: 'spotme/e2e_v3/chain',
  msg: 'spotme/e2e_v3/msg'
}
const hkdf = (ikm, salt, info, len = 32) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len))

const rootKey = hkdf(ss, Buffer.alloc(32), L.root)
console.log('\n=== 3. HKDF ladder ===')
console.log(`label(root)  = "${L.root}"`)
console.log('root key     =', hex(rootKey))

// One DH ratchet step: root' || chain = HKDF(dh_out, salt=root, info=chain)
const dhStep = dh(RAW.alice_ek, RAW.bob_spk)
const ratchet = hkdf(dhStep, rootKey, L.chain, 64)
const rootNext = ratchet.subarray(0, 32)
const chainKey = ratchet.subarray(32)
console.log(`label(chain) = "${L.chain}"`)
console.log('root key\'    =', hex(rootNext))
console.log('chain key    =', hex(chainKey))

// Message key from chain key, and the chain advance.
const msgKey = hkdf(chainKey, Buffer.alloc(32), `${L.msg}/0`)
const chainNext = hkdf(chainKey, Buffer.alloc(32), `${L.chain}/next`)
console.log(`label(msg)   = "${L.msg}/<n>"`)
console.log('msg key n=0  =', hex(msgKey))
console.log('chain key n=1=', hex(chainNext))

/* --- 4. Header serialisation ---------------------------------------------- */
function encodeHeader ({ prologue, dhPub, pn, n, sdev, rdev, ik, ek, spkId, opkId }) {
  const base = Buffer.alloc(1 + 16 + 16 + 32 + 4 + 4)
  let o = 0
  base.writeUInt8(prologue ? 0x01 : 0x00, o); o += 1
  Buffer.from(sdev).copy(base, o); o += 16
  Buffer.from(rdev).copy(base, o); o += 16
  Buffer.from(dhPub).copy(base, o); o += 32
  base.writeUInt32BE(pn, o); o += 4
  base.writeUInt32BE(n, o); o += 4
  if (!prologue) return base
  const pro = Buffer.alloc(32 + 32 + 4 + 4)
  let p = 0
  Buffer.from(ik).copy(pro, p); p += 32
  Buffer.from(ek).copy(pro, p); p += 32
  pro.writeUInt32BE(spkId, p); p += 4
  pro.writeUInt32BE(opkId >>> 0, p)
  return Buffer.concat([base, pro])
}

const SDEV = Buffer.alloc(16, 0xa1)
const RDEV = Buffer.alloc(16, 0xb2)

const hdrSteady = encodeHeader({
  prologue: false, dhPub: pubRaw(RAW.alice_ek), pn: 3, n: 7, sdev: SDEV, rdev: RDEV
})
const hdrPrologue = encodeHeader({
  prologue: true, dhPub: pubRaw(RAW.alice_ek), pn: 0, n: 0, sdev: SDEV, rdev: RDEV,
  ik: pubRaw(RAW.alice_ik), ek: pubRaw(RAW.alice_ek), spkId: 1, opkId: 42
})
const hdrNoOpk = encodeHeader({
  prologue: true, dhPub: pubRaw(RAW.alice_ek), pn: 0, n: 0, sdev: SDEV, rdev: RDEV,
  ik: pubRaw(RAW.alice_ik), ek: pubRaw(RAW.alice_ek), spkId: 1, opkId: 0xffffffff
})

console.log('\n=== 4. Header serialisation ===')
console.log('steady-state  len =', hdrSteady.length, '\n  ', hex(hdrSteady))
console.log('with prologue len =', hdrPrologue.length, '\n  ', hex(hdrPrologue))
console.log('no OPK avail  len =', hdrNoOpk.length, '\n  ', hex(hdrNoOpk))

/* --- 5. AAD --------------------------------------------------------------- */
// AAD = "spotme/e2e_v3" || 0x03 || roomId (utf8) || header
function aad (roomId, header) {
  return Buffer.concat([
    Buffer.from('spotme/e2e_v3', 'utf8'),
    Buffer.from([0x03]),
    Buffer.from(roomId, 'utf8'),
    header
  ])
}
const ROOM = 'dm_0123456789abcdef'
const a = aad(ROOM, hdrSteady)
console.log('\n=== 5. AAD ===')
console.log('roomId      =', ROOM)
console.log('AAD len     =', a.length)
console.log('AAD sha256  =', hex(Buffer.from(hkdfSync('sha256', a, Buffer.alloc(32), Buffer.from('vector'), 32))))
console.log('AAD prefix  =', hex(a.subarray(0, 34)))

/* --- 6. Full payload framing ---------------------------------------------- */
const IV = Buffer.alloc(12, 0x9c)
function frame (header, iv, ct) {
  const len = Buffer.alloc(2); len.writeUInt16BE(header.length)
  return Buffer.concat([Buffer.from([0x53, 0x03]), len, header, iv, ct])
}
const fakeCt = Buffer.alloc(20, 0xee)
const payload = frame(hdrSteady, IV, fakeCt)
console.log('\n=== 6. Payload framing ===')
console.log('MAGIC=0x53 VER=0x03 HDRLEN(u16 BE) HEADER IV(12) CT||TAG')
console.log('total len   =', payload.length)
console.log('payload hex =', hex(payload))
console.log('payload b64 =', b64(payload))
