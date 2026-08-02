/**
 * Privacy posture, PII classification, redaction, and safe telemetry (design §12).
 *
 * The property under test is the honest one: on-device preserves E2E, cloud does
 * not, and the platform must SAY so, tighten the provider set for sensitive text,
 * redact PII before a third-party call, and never let plaintext or a secret into
 * a log. All pure — no network, no key.
 *
 *   node test/translation-privacy.test.js
 */
import {
  PRIVACY_MODES, MODE_POSTURES, posturesForMode, isPostureAllowed, privacyPolicyForMode,
  isE2EPreserved, plaintextLeavesDevice, privacyNotice, classifyText, hasPII, redact,
  reinsert, safeLogFields, SAFE_LOG_FIELDS, RETENTION_POSTURES
} from '../src/lib/translation/privacy.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/* -------------------------------------------------- 1. modes → postures ---- */

check('the three modes tighten monotonically: strict ⊂ sensitive ⊂ standard', () =>
  posturesForMode('strict').length === 1 &&
  posturesForMode('sensitive').length === 2 &&
  posturesForMode('standard').length === 3 &&
  posturesForMode('strict').every((p) => posturesForMode('sensitive').includes(p)) &&
  posturesForMode('sensitive').every((p) => posturesForMode('standard').includes(p)))

check('strict is on-device only — the E2E property is preserved', () =>
  MODE_POSTURES.strict.length === 1 && MODE_POSTURES.strict[0] === 'on-device' &&
  isPostureAllowed('on-device', 'strict') === true &&
  isPostureAllowed('cloud-contract', 'strict') === false)

check('sensitive admits a contracted cloud but never a keyless one', () =>
  isPostureAllowed('cloud-contract', 'sensitive') === true &&
  isPostureAllowed('cloud-keyless', 'sensitive') === false)

check('an unknown mode falls back to standard, not to something looser', () =>
  posturesForMode('whatever').length === 3 && PRIVACY_MODES.includes('standard'))

/* --------------------------------------------- 2. mode → router privacyPolicy */

check('privacyPolicyForMode produces a router-shaped (posture, tenantId) gate', () => {
  const strict = privacyPolicyForMode('strict')
  const standard = privacyPolicyForMode('standard')
  return strict('on-device', null) === true && strict('cloud-contract', null) === false &&
    standard('cloud-keyless', null) === true &&
    // an enterprise tenant keeps the keyless denial even in standard (no DPA)
    standard('cloud-keyless', 'acme') === false
})

/* --------------------------------------------- 3. the honest E2E statement -- */

check('E2E survives only on-device; cloud means plaintext left the device', () =>
  isE2EPreserved('on-device') === true && isE2EPreserved('cloud-contract') === false &&
  plaintextLeavesDevice('on-device') === false && plaintextLeavesDevice('cloud-keyless') === true)

check('the privacy notice is explicit that a cloud translation was NOT E2E', () =>
  /end-to-end privacy preserved/.test(privacyNotice('on-device')) &&
  /NOT end-to-end private/.test(privacyNotice('cloud-contract')))

/* --------------------------------------------------- 4. PII classification -- */

check('email, phone, card and ip are detected; plain chat is not', () => {
  const a = classifyText('mail me at foo.bar@example.com please')
  const b = classifyText('call +91 98765 43210 tonight')
  const c = classifyText('card 4111 1111 1111 1111 expiry soon')
  const d = classifyText('naan innaiku varen da')
  return a.pii && a.kinds.includes('email') &&
    b.pii && b.kinds.includes('phone') &&
    c.pii && c.kinds.includes('card') &&
    d.pii === false && hasPII(d.text || 'naan varen') === false
})

check('a 16-digit card is not also double-counted as a phone number', () => {
  const c = classifyText('4111 1111 1111 1111')
  return c.kinds.includes('card') && !c.kinds.includes('phone')
})

/* --------------------------------------------------------- 5. redaction ---- */

check('redaction replaces PII with translation-inert placeholders, reversibly', () => {
  const r = redact('email foo@bar.com and card 4111 1111 1111 1111 now')
  const noEmail = !/foo@bar\.com/.test(r.text)
  const noCard = !/4111 1111 1111 1111/.test(r.text)
  const restored = reinsert(r.text, r.map)
  return r.redacted && noEmail && noCard &&
    /foo@bar\.com/.test(restored) && /4111 1111 1111 1111/.test(restored) &&
    r.kinds.includes('email') && r.kinds.includes('card')
})

check('redacting text with no PII changes nothing and flags redacted:false', () => {
  const r = redact('just an ordinary sentence about lunch')
  return r.redacted === false && r.text === 'just an ordinary sentence about lunch' &&
    Object.keys(r.map).length === 0
})

/* ------------------------------------------------------- 6. safe telemetry -- */

check('safeLogFields keeps only whitelisted, non-content fields', () => {
  const safe = safeLogFields({
    provider: 'sarvam', pair: 'ta|en', latencyMs: 320, confidence: 0.95,
    // everything below MUST be stripped — it is content or a secret
    text: 'naan varen', q: 'secret message', english: 'I will come',
    apiKey: 'sk-XXXX', script: 'நான் வருவேன்'
  })
  return safe.provider === 'sarvam' && safe.pair === 'ta|en' && safe.latencyMs === 320 &&
    !('text' in safe) && !('q' in safe) && !('english' in safe) && !('apiKey' in safe) &&
    // "script" was message content (spaces/long), so it was rejected too
    !('script' in safe)
})

check('safeLogFields keeps a short ISO-15924 script CODE but rejects content in that field', () => {
  const code = safeLogFields({ script: 'Taml' })
  const content = safeLogFields({ script: 'வணக்கம் நண்பரே' })
  return code.script === 'Taml' && !('script' in content)
})

check('the whitelist names no content field, and retention postures are documented', () =>
  !SAFE_LOG_FIELDS.includes('text') && !SAFE_LOG_FIELDS.includes('q') &&
  !SAFE_LOG_FIELDS.includes('english') &&
  typeof RETENTION_POSTURES['unknown-no-contract'] === 'string')

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — privacy, PII, redaction, safe telemetry')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
