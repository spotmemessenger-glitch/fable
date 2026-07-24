/**
 * Spot Me — transliteration (Latin script -> Indic scripts).
 *
 * Turns `vanakkam` into வணக்கம். Rule-based, pure JavaScript, no model
 * download and no native module — which is why this ships in the first build
 * while translation (ML Kit, ~30 MB per language pair) cannot.
 *
 * Transliteration is NOT translation. It rewrites the same words into another
 * script; the language does not change. `vanakkam` -> வணக்கம் is Tamil either
 * way. The UI must never present one as the other.
 *
 * ---------------------------------------------------------------------------
 * HOW INDIC SCRIPTS WORK, AND WHY THE CODE LOOKS LIKE THIS
 *
 * These are abugidas, not alphabets. A consonant letter carries an inherent
 * short 'a': க IS "ka", not "k". So:
 *
 *   - consonant + 'a'        -> the bare letter        (ka -> க)
 *   - consonant + any vowel  -> letter + a vowel SIGN  (ki -> கி)
 *   - consonant + no vowel   -> letter + virama        (k  -> க்)
 *
 * Getting this wrong is the classic bug: emitting the standalone vowel letter
 * instead of the sign, which produces க இ ("ka i") where கி ("ki") was meant.
 *
 * Matching is longest-first, so 'zh' beats 'z' and 'aa' beats 'a'. A shortest-
 * first matcher silently mangles every digraph in the language.
 * ------------------------------------------------------------------------- */

/* --------------------------------------------------------------- Tamil ---- */
const TAMIL = {
  name: 'Tamil',
  code: 'ta',
  // Independent vowel letters — used word-initially or after another vowel.
  vowels: {
    a: 'அ', aa: 'ஆ', A: 'ஆ', i: 'இ', ii: 'ஈ', I: 'ஈ',
    u: 'உ', uu: 'ஊ', U: 'ஊ', e: 'எ', ee: 'ஏ', E: 'ஏ',
    ai: 'ஐ', o: 'ஒ', oo: 'ஓ', O: 'ஓ', au: 'ஔ'
  },
  // Dependent vowel signs — attach to a preceding consonant.
  signs: {
    a: '', aa: 'ா', A: 'ா', i: 'ி', ii: 'ீ', I: 'ீ',
    u: 'ு', uu: 'ூ', U: 'ூ', e: 'ெ', ee: 'ே', E: 'ே',
    ai: 'ை', o: 'ொ', oo: 'ோ', O: 'ோ', au: 'ௌ'
  },
  consonants: {
    k: 'க', g: 'க', ng: 'ங', ch: 'ச', c: 'ச', s: 'ஸ', j: 'ஜ', nj: 'ஞ',
    T: 'ட', D: 'ட', N: 'ண', th: 'த', dh: 'த', n: 'ந', nh: 'ன',
    p: 'ப', b: 'ப', m: 'ம', y: 'ய', r: 'ர', l: 'ல', v: 'வ', w: 'வ',
    zh: 'ழ', L: 'ள', R: 'ற', sh: 'ஷ', h: 'ஹ',
    t: 'ட', d: 'ட'
  },
  virama: '்'
}

/* ---------------------------------------------------------- Devanagari ---- */
const DEVANAGARI = {
  name: 'Devanagari',
  code: 'hi',
  vowels: {
    a: 'अ', aa: 'आ', A: 'आ', i: 'इ', ii: 'ई', I: 'ई',
    u: 'उ', uu: 'ऊ', U: 'ऊ', e: 'ए', ai: 'ऐ', o: 'ओ', au: 'औ',
    ri: 'ऋ'
  },
  signs: {
    a: '', aa: 'ा', A: 'ा', i: 'ि', ii: 'ी', I: 'ी',
    u: 'ु', uu: 'ू', U: 'ू', e: 'े', ai: 'ै', o: 'ो', au: 'ौ',
    ri: 'ृ'
  },
  consonants: {
    k: 'क', kh: 'ख', g: 'ग', gh: 'घ', ng: 'ङ',
    ch: 'च', chh: 'छ', j: 'ज', jh: 'झ', nj: 'ञ',
    T: 'ट', Th: 'ठ', D: 'ड', Dh: 'ढ', N: 'ण',
    t: 'त', th: 'थ', d: 'द', dh: 'ध', n: 'न',
    p: 'प', ph: 'फ', f: 'फ', b: 'ब', bh: 'भ', m: 'म',
    y: 'य', r: 'र', l: 'ल', v: 'व', w: 'व',
    sh: 'श', Sh: 'ष', s: 'स', h: 'ह'
  },
  virama: '्'
}

const SCRIPTS = {
  ta: TAMIL,
  hi: DEVANAGARI
}

/**
 * High-frequency words whose informal spelling defies the rules.
 *
 * Users type phonetically, not in a transliteration scheme, and informal
 * romanisation is genuinely ambiguous — "na" could be ந or ன. Rules cannot
 * resolve that; the words people actually type every day can simply be looked
 * up. This table is where accuracy is bought cheaply.
 */
const COMMON = {
  ta: {
    vanakkam: 'வணக்கம்',
    nandri: 'நன்றி',
    naan: 'நான்',
    nee: 'நீ',
    enna: 'என்ன',
    eppadi: 'எப்படி',
    irukken: 'இருக்கேன்',
    irukkinga: 'இருக்கீங்க',
    sari: 'சரி',
    illai: 'இல்லை',
    aamaam: 'ஆமாம்',
    nalla: 'நல்ல',
    romba: 'ரொம்ப'
  },
  hi: {
    namaste: 'नमस्ते',
    dhanyavaad: 'धन्यवाद',
    haan: 'हाँ',
    nahin: 'नहीं',
    kya: 'क्या',
    kaise: 'कैसे',
    accha: 'अच्छा',
    theek: 'ठीक',
    bahut: 'बहुत',
    aap: 'आप'
  }
}

/** Longest keys first, so 'zh' is tried before 'z' and 'aa' before 'a'. */
function sortedKeys (table) {
  return Object.keys(table).sort((a, b) => b.length - a.length)
}

const CACHE = new Map()
function keysFor (script) {
  if (!CACHE.has(script.code)) {
    CACHE.set(script.code, {
      consonants: sortedKeys(script.consonants),
      vowels: sortedKeys(script.vowels)
    })
  }
  return CACHE.get(script.code)
}

function matchAt (input, index, keys) {
  for (const key of keys) {
    if (input.startsWith(key, index)) return key
  }
  return null
}

/**
 * Convert one romanised word.
 *
 * Walks left to right: at each position take the longest consonant or vowel
 * match, then decide between a standalone vowel letter, a vowel sign, or a
 * virama, per the abugida rules described at the top of this file.
 */
function convertWord (word, script) {
  const keys = keysFor(script)
  const lower = word.toLowerCase()

  const dictionary = COMMON[script.code]
  if (dictionary && dictionary[lower]) return dictionary[lower]

  let out = ''
  let i = 0
  // True when the previous emission was a consonant still awaiting its vowel.
  let pendingConsonant = false

  while (i < word.length) {
    const consonant = matchAt(word, i, keys.consonants)

    if (consonant) {
      // A bare consonant before the next one needs an explicit virama:
      // "kk" is க் + க, never க + க.
      if (pendingConsonant) out += script.virama
      out += script.consonants[consonant]
      pendingConsonant = true
      i += consonant.length
      continue
    }

    const vowel = matchAt(word, i, keys.vowels)

    if (vowel) {
      if (pendingConsonant) {
        // Attach as a SIGN, never as a standalone letter. Inherent 'a' is the
        // empty string, so "ka" correctly emits just க.
        out += script.signs[vowel]
        pendingConsonant = false
      } else {
        out += script.vowels[vowel]
      }
      i += vowel.length
      continue
    }

    // Unmapped character — digit, punctuation, stray Latin letter. Close any
    // open consonant and pass it through untouched rather than dropping it.
    if (pendingConsonant) {
      out += script.virama
      pendingConsonant = false
    }
    out += word[i]
    i += 1
  }

  // A word ending on a consonant takes a virama: "vanakkam" ends ...ம், not ...ம.
  if (pendingConsonant) out += script.virama

  return out
}

/**
 * Transliterate a whole string, preserving whitespace and punctuation.
 *
 * @param {string} text   romanised input, e.g. "vanakkam nanba"
 * @param {string} target script code — 'ta' or 'hi'
 */
function transliterate (text, target) {
  const script = SCRIPTS[target]
  if (!script) throw new Error(`transliterate: unsupported script "${target}"`)
  if (typeof text !== 'string' || text.length === 0) return ''

  // Split on whitespace but KEEP it, so the original spacing survives.
  return text
    .split(/(\s+)/)
    .map((token) => (/^\s+$/.test(token) ? token : convertWord(token, script)))
    .join('')
}

function isSupported (code) {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, code)
}

function supportedScripts () {
  return Object.values(SCRIPTS).map((s) => ({ code: s.code, name: s.name }))
}

/* ---------------------------------------------------------------------------
 * SCOPE — what this does and does not claim
 *
 * Rule-based transliteration handles well-formed input well and informal
 * romanisation approximately. "vanakkam" is unambiguous; "na" genuinely is not
 * (ந or ன), and no rule can decide it — Google Input Tools uses a statistical
 * model for exactly this reason. The COMMON table buys accuracy on the words
 * people actually type; everything else is a best effort.
 *
 * The UI must therefore keep this as a SUGGESTION the user can reject, never a
 * silent rewrite of what they typed. Two scripts ship now (Tamil, Devanagari);
 * Telugu, Kannada, Malayalam, Bengali and Gujarati are each just another table.
 * ------------------------------------------------------------------------- */

module.exports = { transliterate, isSupported, supportedScripts, SCRIPTS }
