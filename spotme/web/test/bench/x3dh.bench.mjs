/**
 * X3DH benchmarks — Roadmap V2 §8 (environment, raw, median AND tail). Run on
 * Node's WebCrypto, the same primitive the browser uses, so the numbers isolate
 * the handshake's own cost. A real device's IndexedDB and network add on top
 * and are measured on hardware in the Phase 6 pass.
 *
 *   node test/bench/x3dh.bench.mjs
 */
import { cpus, totalmem } from 'node:os'
import { x3dhInitiator, x3dhResponder } from '../../src/lib/crypto/x3dh.js'

const PKCS8 = fromHex('302e020100300506032b656e04220420')
function fromHex (h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b }
async function priv (byte) {
  const pkcs8 = new Uint8Array(PKCS8.length + 32); pkcs8.set(PKCS8, 0); pkcs8.set(new Uint8Array(32).fill(byte), PKCS8.length)
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'])
}
const PUBHEX = {
  0x11: '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
  0x22: '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20',
  0x33: '7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14',
  0x44: 'ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b',
  0x55: '38ab664bd86f77d7e66bdd9ae0792913a94fd8b33a1260027e4b46c1f4884c67',
}
const pub = (byte) => crypto.subtle.importKey('raw', fromHex(PUBHEX[byte]), { name: 'X25519' }, false, [])

const stats = (samples) => {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return { n: s.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] }
}
const fmt = (x) => `${x.toFixed(3)}ms`
const row = (name, st) =>
  console.log(`${name.padEnd(34)} n=${String(st.n).padStart(4)}  median=${fmt(st.median)}  p95=${fmt(st.p95)}  p99=${fmt(st.p99)}  max=${fmt(st.max)}`)

console.log('X3DH handshake benchmark')
console.log(`env: node ${process.version} · ${cpus()[0]?.model || 'cpu?'} ×${cpus().length} · ${(totalmem() / 2 ** 30).toFixed(1)}GiB · WebCrypto X25519`)
console.log('')

const ik = await priv(0x11); const ek = await priv(0x22)
const bIk = await pub(0x33); const bSpk = await pub(0x44); const bOpk = await pub(0x55)

// INITIATOR: four DH + HKDF (with OPK) — the cost Alice pays to open a session.
{
  const samples = []
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now()
    await x3dhInitiator({ identityPriv: ik, ephemeralPriv: ek, peerIkPub: bIk, peerSpkPub: bSpk, peerOpkPub: bOpk })
    samples.push(performance.now() - t0)
  }
  row('initiator (4 DH + HKDF)', stats(samples))
}

// INITIATOR without OPK — three DH.
{
  const samples = []
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now()
    await x3dhInitiator({ identityPriv: ik, ephemeralPriv: ek, peerIkPub: bIk, peerSpkPub: bSpk, peerOpkPub: null })
    samples.push(performance.now() - t0)
  }
  row('initiator no-OPK (3 DH + HKDF)', stats(samples))
}

// RESPONDER: the matching cost Bob pays on receipt of the prologue.
{
  const sIk = await priv(0x33); const sSpk = await priv(0x44); const sOpk = await priv(0x55)
  const aIk = await pub(0x11); const aEk = await pub(0x22)
  const samples = []
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now()
    await x3dhResponder({ identityPriv: sIk, spkPriv: sSpk, opkPriv: sOpk, peerIkPub: aIk, peerEkPub: aEk })
    samples.push(performance.now() - t0)
  }
  row('responder (4 DH + HKDF)', stats(samples))
}

console.log('\nnote: a real device adds a bundle fetch (one round trip) and an IndexedDB')
console.log('read for the private keys; both are measured in the Phase 6 hardware pass.')
