/**
 * Proves plain English is never handed to the transliteration chain.
 *
 * The failure this locks down is a real one, screenshotted by the user: a
 * message typed in English was DELIVERED TO THE OTHER PERSON as Kannada.
 *
 *   sent:      "Type something in Kannada in English and send me"
 *   delivered: "It's been so many days since I saw you, how are you?"
 *
 * The chain asks an LLM what language a message is in, and an LLM reading a
 * sentence that contains the word "Kannada" is easily persuaded to see Kannada.
 * So English is now settled deterministically, before the LLM is consulted.
 *
 * The opposite error matters just as much: romanized Tamil/Kannada MUST still
 * be transliterated, or the feature is gone. Both directions are asserted.
 */
import { englishScore, isPlainEnglish, wordCount } from '../src/lib/english.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch { results[name] = false }
}

/* 1 — the exact message that broke, and its neighbour from the same chat. */
check('THE BUG: the screenshotted English message is left alone', () =>
  isPlainEnglish('Type something in Kannada in English and send me') === true)

check('English survives a proper noun it does not know', () =>
  isPlainEnglish('Click that and select more and add to Home Screen') === true)

check('ordinary English sentences are English', () =>
  isPlainEnglish('are you coming to the party tonight') === true &&
  isPlainEnglish('I will call you after the meeting') === true)

/* 2 — the other direction. If these ever return true the feature is dead:
 *     romanized Indic would stop being transliterated at all. */
check('THE REGRESSION GUARD: romanized Tamil is NOT English', () =>
  isPlainEnglish('Seri aparam ena panra en pondati') === false)

check('romanized Tamil phrases stay untouched by the guard', () =>
  isPlainEnglish('enga vetuku variya') === false &&
  isPlainEnglish('naan innum varala da') === false)

check('romanized Hindi is not English', () =>
  isPlainEnglish('tum kahan ho abhi bolo') === false)

/* 3 — "en", "na", "va" and friends are common romanized Indic words. If they
 *     ever enter the English list, Tamil starts scoring as English. */
check('Indic-colliding short tokens are not counted as English', () =>
  englishScore('en na va di la ne') === 0)

/* 4 — the three-word floor. One "ok" is 100% English by ratio and must still
 *     not trigger, because short messages are exactly where detection fails. */
check('a one-word message never counts as sure English', () =>
  isPlainEnglish('ok') === false && wordCount('ok') === 1)

check('two words are still too few to be sure', () =>
  isPlainEnglish('thank you') === false)

/* 5 — degenerate input must not throw. */
check('empty and non-Latin input score zero rather than throwing', () =>
  englishScore('') === 0 && englishScore(null) === 0 && englishScore('வணக்கம்') === 0)

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  transliteration — English guard')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
