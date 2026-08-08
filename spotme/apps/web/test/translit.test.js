/**
 * Locks down the on-device transliteration engine.
 *
 * This engine is pure, synchronous and now sits on the composer's critical
 * path (the 文A preview paints from it on the same frame as the keystroke), so
 * every one of its defects is visible to the user instantly and with the app's
 * highest-confidence styling. Three real ones are pinned here:
 *
 *   1. CASE — the rule walk read the ORIGINAL case while the dictionary
 *      lowercased. Mobile keyboards autocapitalise the first letter of every
 *      sentence, so `Enga` matched the `E` key (ஏ, long ē) instead of `e` (எ).
 *   2. PUNCTUATION — splitting on whitespace alone handed `vanakkam!` to the
 *      dictionary, which missed, and the rules path spelled it with the wrong
 *      nasal. A single `!` defeated all 23 dictionary entries.
 *   3. VOWEL AFTER VOWEL — `poi` emitted a standalone இ mid-word (பொஇ), which
 *      is the same class of bug as writing க இ for "ki".
 *
 * Tested against ../../core/translit.js — the SOURCE. web/vendor/spotme-core
 * is regenerated from it by the `prebuild` hook, so the source is the only
 * copy worth asserting on.
 */
import engine from '../../../core/translit.js'

const { transliterate, isSupported, supportedScripts } = engine

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch { results[name] = false }
}
const is = (input, lang, want) => {
  const got = transliterate(input, lang)
  if (got !== want) {
    console.log(`      ${lang}  "${input}"  got ${got}  want ${want}`)
    return false
  }
  return true
}

/* 1 — CASE. Autocapitalisation must not change which letter comes out. */
check('THE BUG: a sentence-case first letter picks the same key as lowercase', () =>
  is('Enga', 'ta', transliterate('enga', 'ta')) &&
  is('Namaskar', 'hi', transliterate('namaskar', 'hi')))

check('sentence case resolves to the SHORT vowel, not the long one', () =>
  is('Enga', 'ta', 'எங') && is('Namaskar', 'hi', 'नमस्कर्'))

check('ALL CAPS still finds the dictionary', () =>
  is('VANAKKAM', 'ta', 'வணக்கம்') && is('KAISE', 'hi', 'कैसे'))

check('a deliberate mid-word capital is still a scheme escape', () =>
  is('paNam', 'ta', 'பணம்') && transliterate('panam', 'ta') === 'பநம்')

/* 2 — PUNCTUATION. The dictionary is where accuracy is bought cheaply; a
 *     trailing mark must not throw it away. */
check('THE BUG: trailing punctuation no longer defeats the dictionary', () =>
  is('vanakkam!', 'ta', 'வணக்கம்!') &&
  is('vanakkam?', 'ta', 'வணக்கம்?') &&
  is('namaste.', 'hi', 'नमस्ते.'))

check('punctuation on both edges survives in place', () =>
  is('(vanakkam)', 'ta', '(வணக்கம்)') && is('"sari",', 'ta', '"சரி",'))

check('a punctuation-only or emoji-only token is passed through untouched', () =>
  is('!!!', 'ta', '!!!') && is('👍', 'ta', '👍') && is('...', 'hi', '...'))

check('emoji beside a word still leave the word converted', () =>
  is('vanakkam 👍', 'ta', 'வணக்கம் 👍'))

/* 3 — VOWEL AFTER VOWEL. A standalone vowel letter must never appear in the
 *     middle of a word; the glide consonant is what Indic spelling uses. */
const STANDALONE_MIDWORD = /[அ-ஔअ-औ](?<=[\s\S][\s\S])/u

check('THE BUG: poi is பொய், not பொஇ', () => is('poi', 'ta', 'பொய்'))

check('the glide carries a following consonant correctly', () =>
  is('seiya', 'ta', 'ஸெய்ய') && is('naai', 'ta', 'நாய்'))

check('no standalone vowel letter is ever emitted mid-word', () =>
  ['poi', 'seiya', 'naai', 'meena', 'bhaai', 'kai', 'oru'].every((w) => {
    for (const lang of ['ta', 'hi']) {
      const out = transliterate(w, lang)
      // An independent vowel letter is only legal at position 0.
      if (STANDALONE_MIDWORD.test(out)) {
        console.log(`      ${lang}  "${w}" -> ${out}  (standalone vowel mid-word)`)
        return false
      }
    }
    return true
  }))

check('the long-vowel spelling people actually type now resolves', () =>
  is('meena', 'hi', 'मीन') && is('veedu', 'ta', 'வேடு'))

/* 4 — no regressions in what already worked. */
check('the dictionary entries still win', () =>
  is('vanakkam', 'ta', 'வணக்கம்') && is('nandri', 'ta', 'நன்றி') &&
  is('namaste', 'hi', 'नमस्ते') && is('dhanyavaad', 'hi', 'धन्यवाद'))

check('the abugida rules still hold (sign, not letter; virama at the end)', () =>
  is('ki', 'ta', 'கி') && is('ka', 'ta', 'க') && is('k', 'ta', 'க்') &&
  is('kka', 'ta', 'க்க'))

check('digraphs still beat their prefixes', () =>
  is('pazham', 'ta', 'பழம்') && is('kai', 'ta', 'கை'))

check('whitespace and multi-word spacing survive exactly', () =>
  is('kaise ho', 'hi', 'कैसे हो') && is('a  b', 'ta', 'அ  ப்'))

/* 5 — degenerate input must not throw or corrupt. */
check('non-string and empty input return an empty string', () =>
  transliterate(null, 'ta') === '' && transliterate(undefined, 'ta') === '' &&
  transliterate(123, 'ta') === '' && transliterate('', 'ta') === '')

check('an unsupported script still throws rather than lying', () => {
  try { transliterate('nenu', 'te'); return false } catch { return true }
})

check('surrogate pairs are never split', () =>
  is('ok 👍', 'ta', 'ஒக் 👍') && is('k👍k', 'ta', 'க்👍க்'))

check('the supported set is still exactly Tamil and Devanagari', () =>
  isSupported('ta') && isSupported('hi') && !isSupported('te') &&
  supportedScripts().length === 2)

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  transliteration — on-device engine')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
