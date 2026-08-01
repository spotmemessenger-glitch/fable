/**
 * Double Ratchet benchmarks — Roadmap V2 §8 (environment, median AND tail). On
 * Node's WebCrypto with the SHIPPED random-IV seams, so the numbers are the
 * real per-message cost. The skipped-key derivation cost is measured
 * separately because it is the one an attacker controls (bounded at
 * MAX_SKIP_PER_CHAIN).
 *
 *   node test/bench/ratchet.bench.mjs
 */
import { cpus, totalmem } from 'node:os'
import { initInitiator, initResponder, encrypt, decrypt } from '../../src/lib/crypto/ratchet.js'

const SDEV = new Uint8Array(16).fill(0xa1); const RDEV = new Uint8Array(16).fill(0xb2)
const ROOM = 'dm_0123456789abcdef'
const SHARED = new Uint8Array(32).fill(0x42)
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
async function kp (byte) {
  const pkcs8 = new Uint8Array(PKCS8.length + 32); pkcs8.set(PKCS8, 0); pkcs8.set(new Uint8Array(32).fill(byte), PKCS8.length)
  const { createPrivateKey, createPublicKey } = await import('node:crypto')
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'])
  const spki = createPublicKey(createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' })
  const pub = new Uint8Array(spki.subarray(spki.length - 32))
  return { privateKey, publicKey: await crypto.subtle.importKey('raw', pub, { name: 'X25519' }, false, []), pub }
}
const stats = (s) => { s = [...s].sort((a, b) => a - b); const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]; return { n: s.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] } }
const fmt = (x) => `${x.toFixed(3)}ms`
const row = (name, st) => console.log(`${name.padEnd(40)} n=${String(st.n).padStart(4)}  median=${fmt(st.median)}  p95=${fmt(st.p95)}  p99=${fmt(st.p99)}  max=${fmt(st.max)}`)

console.log('Double Ratchet benchmark')
console.log(`env: node ${process.version} · ${cpus()[0]?.model || 'cpu?'} ×${cpus().length} · ${(totalmem() / 2 ** 30).toFixed(1)}GiB · WebCrypto, random-IV seams`)
console.log('')

const bobPre = await kp(0x33)

// STEADY-STATE ENCRYPT — a message on an established sending chain (one HKDF + AES-GCM).
{
  let s = await initInitiator({ sharedSecret: SHARED, peerRatchetPub: bobPre.pub, sdev: SDEV, rdev: RDEV })
  const samples = []
  for (let i = 0; i < 1000; i++) { const t0 = performance.now(); const o = await encrypt(s, 'a short chat message', ROOM); s = o.session; samples.push(performance.now() - t0) }
  row('encrypt (steady-state, 1 msg)', stats(samples))
}

// STEADY-STATE DECRYPT — in-order receive on an established chain.
{
  let a = await initInitiator({ sharedSecret: SHARED, peerRatchetPub: bobPre.pub, sdev: SDEV, rdev: RDEV })
  let b = await initResponder({ sharedSecret: SHARED, selfRatchetKeyPair: bobPre, sdev: RDEV, rdev: SDEV })
  const samples = []
  for (let i = 0; i < 1000; i++) { const o = await encrypt(a, `m${i}`, ROOM); a = o.session; const t0 = performance.now(); const g = await decrypt(b, o.payload, ROOM); b = g.session; samples.push(performance.now() - t0) }
  row('decrypt (steady-state, in order)', stats(samples))
}

// DH-RATCHET DECRYPT — a message under a new peer ratchet key (two DH + HKDF + AES-GCM).
{
  const samples = []
  for (let i = 0; i < 300; i++) {
    let a = await initInitiator({ sharedSecret: SHARED, peerRatchetPub: bobPre.pub, sdev: SDEV, rdev: RDEV })
    let b = await initResponder({ sharedSecret: SHARED, selfRatchetKeyPair: bobPre, sdev: RDEV, rdev: SDEV })
    let o = await encrypt(a, 'a1', ROOM); a = o.session
    let g = await decrypt(b, o.payload, ROOM); b = g.session
    let r = await encrypt(b, 'b1', ROOM); b = r.session
    const t0 = performance.now(); await decrypt(a, r.payload, ROOM); samples.push(performance.now() - t0) // alice DH-steps
  }
  row('decrypt (DH-ratchet step)', stats(samples))
}

// SKIPPED-KEY COST — the attacker-influenced path, at a realistic gap of 50.
{
  const samples = []
  for (let i = 0; i < 200; i++) {
    let a = await initInitiator({ sharedSecret: SHARED, peerRatchetPub: bobPre.pub, sdev: SDEV, rdev: RDEV })
    let b = await initResponder({ sharedSecret: SHARED, selfRatchetKeyPair: bobPre, sdev: RDEV, rdev: SDEV })
    let last
    for (let j = 0; j < 50; j++) { const o = await encrypt(a, `g${j}`, ROOM); a = o.session; last = o.payload }
    const t0 = performance.now(); await decrypt(b, last, ROOM); samples.push(performance.now() - t0) // derives 50 skipped keys
  }
  row('decrypt (50 skipped keys derived)', stats(samples))
}

console.log('\nnote: skipped-key cost scales linearly and is bounded at MAX_SKIP_PER_CHAIN=1000')
console.log('(004a §5) — a header claiming further is refused, so the worst case is 1000 HKDFs.')
