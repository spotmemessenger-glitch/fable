/**
 * Spot Me — identity and recovery.
 *
 * A 24-word BIP39 mnemonic IS the account. There is no username, no password,
 * no server-side record. This matches Keet, which uses a 24-word seed phrase as
 * identity and lets you re-enter it to recover, and it matches how crypto
 * wallets work — which is deliberate, since wallet integration is on the roadmap.
 *
 * ---------------------------------------------------------------------------
 * THE FORK TRAP — the reason this file exists at all
 *
 * The obvious design is wrong: derive your writer core from the seed, and on a
 * new device regenerate it and carry on appending. That FORKS the core. A
 * Hypercore is append-only and signed, so writing block 0 a second time
 * produces two conflicting histories under one public key. Peers reject it and
 * there is no repair.
 *
 * So the seed NEVER derives a writer core. It derives:
 *
 *   root identity key  proves WHO you are. Signs authorisations. Never appends.
 *   vault key          symmetric; encrypts your key-bundle backup.
 *
 * Every device generates its OWN fresh, random writer core and is authorised by
 * the root identity. Recovery means a NEW core proving the SAME root — never a
 * resurrected one. No fork is possible because no writer core is ever derived
 * twice.
 * ------------------------------------------------------------------------- */
const bip39 = require('bip39')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const b4a = require('b4a')

/** 256 bits of entropy → 24 words. Keet uses 24; so do we. */
const MNEMONIC_STRENGTH = 256
const KEY_BYTES = 32
const BUNDLE_VERSION = 1

/** Domain-separation contexts. Two purposes must never share a key. */
const CTX_IDENTITY = 'spotme:identity:v1'
const CTX_VAULT = 'spotme:vault:v1'

/**
 * Derive a 32-byte subkey from the master seed for one specific purpose.
 * Keyed BLAKE2b: the context string is the message, the seed is the key, so
 * distinct contexts yield unrelated keys and leaking one reveals nothing.
 */
function deriveSubkey (masterSeed, context) {
  const out = b4a.alloc(KEY_BYTES)
  sodium.crypto_generichash(out, b4a.from(context), masterSeed)
  return out
}

/** Fresh 24-word phrase. Show once, then treat as radioactive — see notes below. */
function generateMnemonic () {
  return bip39.generateMnemonic(MNEMONIC_STRENGTH)
}

/** Checksummed validation. Catches typos before we derive anything from it. */
function validateMnemonic (mnemonic) {
  return bip39.validateMnemonic(normaliseMnemonic(mnemonic))
}

/**
 * Users retype phrases with stray capitals and doubled spaces. BIP39 checksums
 * are exact, so normalise before validating or a correct phrase reads as wrong.
 */
function normaliseMnemonic (mnemonic) {
  return String(mnemonic).trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Derive the full identity from a mnemonic.
 *
 * Deterministic: the same phrase always yields the same identity, on any device,
 * forever. That is exactly what makes recovery work — and exactly why the phrase
 * must never be transmitted or logged.
 *
 * `passphrase` is the optional BIP39 25th word. It creates a completely separate
 * identity from the same 24 words; forgetting it is unrecoverable.
 */
function fromMnemonic (mnemonic, { passphrase = '' } = {}) {
  const normalised = normaliseMnemonic(mnemonic)
  if (!bip39.validateMnemonic(normalised)) {
    throw new Error('identity: invalid recovery phrase (checksum failed)')
  }

  // 64 bytes; we take the first 32 as the master seed.
  const seed = bip39.mnemonicToSeedSync(normalised, passphrase)
  const masterSeed = b4a.from(seed.subarray(0, KEY_BYTES))

  const identitySeed = deriveSubkey(masterSeed, CTX_IDENTITY)
  const identity = crypto.keyPair(identitySeed)
  const vaultKey = deriveSubkey(masterSeed, CTX_VAULT)

  return {
    publicKey: identity.publicKey,
    secretKey: identity.secretKey,
    vaultKey,
    /** Stable public handle — safe to display and to share. */
    id: b4a.toString(identity.publicKey, 'hex')
  }
}

/**
 * A fresh writer keypair for THIS device.
 *
 * Deliberately random, never derived from the seed. Two devices must never hold
 * the same writer core, and a recovered device must never resurrect an old one —
 * see the fork trap above.
 */
function deviceKeyPair () {
  return crypto.keyPair()
}

/**
 * Sign a device's writer key with the root identity, proving the device belongs
 * to this account. An always-on node (or another of your devices) verifies this
 * before re-adding you as a writer after recovery.
 */
function authoriseDevice (identity, deviceKeyPairOrKey) {
  const key = deviceKeyPairOrKey.publicKey || deviceKeyPairOrKey
  return {
    device: b4a.toString(key, 'hex'),
    identity: identity.id,
    signature: b4a.toString(crypto.sign(key, identity.secretKey), 'hex')
  }
}

function verifyDevice (authorisation) {
  return crypto.verify(
    b4a.from(authorisation.device, 'hex'),
    b4a.from(authorisation.signature, 'hex'),
    b4a.from(authorisation.identity, 'hex')
  )
}

/**
 * Encrypt the key bundle — room keys and encryption keys — under the vault key.
 *
 * This is what makes recovery return your CONVERSATIONS and not just your name.
 * The sealed blob can sit on the always-on relay node, which holds no vault key
 * and therefore cannot read it. XSalsa20-Poly1305 via secretbox: authenticated,
 * so tampering fails loudly rather than silently decrypting to garbage.
 */
function sealBundle (vaultKey, bundle) {
  const plaintext = b4a.from(JSON.stringify({ v: BUNDLE_VERSION, ...bundle }))
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  const ciphertext = b4a.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, vaultKey)

  return {
    v: BUNDLE_VERSION,
    nonce: b4a.toString(nonce, 'hex'),
    ciphertext: b4a.toString(ciphertext, 'hex')
  }
}

function openBundle (vaultKey, sealed) {
  const nonce = b4a.from(sealed.nonce, 'hex')
  const ciphertext = b4a.from(sealed.ciphertext, 'hex')
  const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)

  const ok = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, vaultKey)
  if (!ok) {
    // Wrong phrase, or the blob was tampered with. Indistinguishable by design.
    throw new Error('identity: could not open bundle (wrong phrase or corrupt data)')
  }
  return JSON.parse(b4a.toString(plaintext))
}

/* ---------------------------------------------------------------------------
 * HANDLING RULES — these are not optional
 *
 *  - NEVER log, transmit, or persist the mnemonic in plaintext. It is the whole
 *    account: anyone holding it is the user, permanently and irrevocably.
 *  - The app stores it in the platform secure store (iOS Keychain / Android
 *    Keystore), never in AsyncStorage, never in a Hypercore.
 *  - There is NO reset. Lose the phrase with no logged-in device and the account
 *    is gone. Say this on the onboarding screen in plain words — a user who
 *    discovers it at recovery time has already lost everything.
 *  - Show the phrase exactly once, force a confirmation retype, and warn against
 *    screenshotting it.
 * ------------------------------------------------------------------------- */

module.exports = {
  MNEMONIC_STRENGTH,
  generateMnemonic,
  validateMnemonic,
  normaliseMnemonic,
  fromMnemonic,
  deviceKeyPair,
  authoriseDevice,
  verifyDevice,
  sealBundle,
  openBundle
}
