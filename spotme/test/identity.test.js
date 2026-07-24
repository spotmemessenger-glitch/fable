/**
 * Identity + recovery — the "I lost my phone" path.
 *
 * The scenario under test is the real one: a user's device is gone, along with
 * every byte of local data. All they have is 24 words written on paper. They
 * must get back their identity AND their conversations.
 *
 *   node test/identity.test.js
 */
const assert = require('assert')
const b4a = require('b4a')
const {
  generateMnemonic,
  validateMnemonic,
  normaliseMnemonic,
  fromMnemonic,
  deviceKeyPair,
  authoriseDevice,
  verifyDevice,
  sealBundle,
  openBundle
} = require('../core/identity')

const results = {}
const check = (name, fn) => {
  try {
    fn()
    results[name] = true
  } catch (err) {
    results[name] = false
    console.error(`  x ${name}: ${err.message}`)
  }
}

// ------------------------------------------------------------------ phrase
const mnemonic = generateMnemonic()
console.log('generated phrase:', mnemonic.split(' ').length, 'words')

check('phraseIs24Words', () => {
  assert.strictEqual(mnemonic.split(' ').length, 24, 'Keet uses 24; so do we')
})

check('phraseValidates', () => {
  assert.ok(validateMnemonic(mnemonic))
})

check('typoIsRejected', () => {
  // Swapping one word breaks the BIP39 checksum — the user is told immediately
  // rather than silently landing in an empty, wrong account.
  const words = mnemonic.split(' ')
  words[0] = words[0] === 'abandon' ? 'ability' : 'abandon'
  assert.strictEqual(validateMnemonic(words.join(' ')), false)
})

check('sloppyTypingStillWorks', () => {
  // Real users add capitals and double spaces. A correct phrase must not be
  // rejected for cosmetics.
  const sloppy = '  ' + mnemonic.toUpperCase().replace(/ /g, '  ') + '  '
  assert.ok(validateMnemonic(sloppy))
  assert.strictEqual(normaliseMnemonic(sloppy), mnemonic)
})

// ---------------------------------------------------------------- identity
const original = fromMnemonic(mnemonic)

check('identityIsDeterministic', () => {
  // THE recovery property: same phrase, different device, same identity.
  const recovered = fromMnemonic(mnemonic)
  assert.strictEqual(recovered.id, original.id)
  assert.ok(b4a.equals(recovered.vaultKey, original.vaultKey))
})

check('differentPhraseDifferentIdentity', () => {
  const other = fromMnemonic(generateMnemonic())
  assert.notStrictEqual(other.id, original.id)
})

check('passphraseForksIdentity', () => {
  // BIP39's 25th word: same 24 words, entirely separate account.
  const withPass = fromMnemonic(mnemonic, { passphrase: 'hunter2' })
  assert.notStrictEqual(withPass.id, original.id)
})

check('identityAndVaultKeysAreUnrelated', () => {
  // Domain separation: compromising one purpose must not expose the other.
  assert.ok(!b4a.equals(original.vaultKey, original.publicKey))
})

// ------------------------------------------------------------------ device
check('deviceKeysAreNeverDerived', () => {
  // Two devices from ONE phrase must get DIFFERENT writer cores, or the second
  // one forks the first. This is the single most important assertion here.
  const a = deviceKeyPair()
  const b = deviceKeyPair()
  assert.ok(!b4a.equals(a.publicKey, b.publicKey))
})

check('deviceAuthorisationVerifies', () => {
  const device = deviceKeyPair()
  const auth = authoriseDevice(original, device)
  assert.ok(verifyDevice(auth), 'a genuine authorisation must verify')
})

check('forgedAuthorisationFails', () => {
  // An attacker claims their device belongs to the victim's identity.
  const attacker = fromMnemonic(generateMnemonic())
  const device = deviceKeyPair()
  const forged = authoriseDevice(attacker, device)
  forged.identity = original.id // swap in the victim's public identity
  assert.strictEqual(verifyDevice(forged), false)
})

// ------------------------------------------------------------------ bundle
const bundle = {
  rooms: [
    { key: 'a'.repeat(64), encryptionKey: 'b'.repeat(64), name: 'Family' },
    { key: 'c'.repeat(64), encryptionKey: 'd'.repeat(64), name: 'Work' }
  ],
  profile: { name: 'Yuv', lang: 'ta' }
}
const sealed = sealBundle(original.vaultKey, bundle)

check('sealedBundleLeaksNothing', () => {
  // The relay node stores this blob. It must reveal no room key and no name.
  const blob = JSON.stringify(sealed)
  assert.ok(!blob.includes('Family'))
  assert.ok(!blob.includes('Yuv'))
  assert.ok(!blob.includes('a'.repeat(64)))
})

check('recoveryReturnsTheConversations', () => {
  // The full journey: 24 words on paper -> identity -> open the blob -> rooms.
  const recovered = fromMnemonic(mnemonic)
  const opened = openBundle(recovered.vaultKey, sealed)
  assert.strictEqual(opened.rooms.length, 2)
  assert.strictEqual(opened.rooms[0].name, 'Family')
  assert.strictEqual(opened.profile.name, 'Yuv')
})

check('wrongPhraseCannotOpenBundle', () => {
  const stranger = fromMnemonic(generateMnemonic())
  assert.throws(() => openBundle(stranger.vaultKey, sealed))
})

check('tamperedBundleFailsLoudly', () => {
  // Authenticated encryption: a flipped byte must throw, never decrypt to junk.
  const tampered = { ...sealed }
  const bytes = b4a.from(tampered.ciphertext, 'hex')
  bytes[0] ^= 0xff
  tampered.ciphertext = b4a.toString(bytes, 'hex')
  assert.throws(() => openBundle(original.vaultKey, tampered))
})

// ------------------------------------------------------------------ report
console.log('\n================ RESULT ================')
for (const [name, passed] of Object.entries(results)) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
}
const ok = Object.values(results).every(Boolean)
const count = Object.values(results).filter(Boolean).length
console.log(`\n${count}/${Object.keys(results).length}`)
console.log('verdict :', ok
  ? 'RECOVERY WORKS - 24 words restore identity and conversations'
  : 'SOMETHING FAILED')
console.log('========================================')
process.exit(ok ? 0 : 1)
