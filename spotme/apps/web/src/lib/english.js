/**
 * Spot Me — "is this just English?", decided without asking a model.
 *
 * WHY THIS EXISTS
 * A message typed in plain English was delivered to the other person as
 * Kannada. "Type something in Kannada in English and send me" arrived as
 * "It's been so many days since I saw you, how are you?" — text the sender
 * never wrote. The transliteration chain had decided English was romanized
 * Kannada, converted it to Kannada script, and translated that back.
 *
 * The chain's language judgement comes from an LLM, and an LLM reading a
 * sentence containing the word "Kannada" is easily talked into seeing Kannada.
 * So the guard has to be deterministic and has to run FIRST: if the text is
 * obviously English, nothing downstream is allowed to have an opinion.
 *
 * WHY A PROPORTION AND NOT "every word"
 * The old test required every single word to be a known English word, so one
 * proper noun — a name, a place, "Kannada" — disqualified an entire English
 * sentence. Real messages are full of proper nouns. A proportion survives them.
 *
 * WHY THESE WORDS
 * Function words, not vocabulary: English is identifiable by its glue ("in",
 * "and", "to", "that"), which is short, closed, and used constantly. Tokens
 * that are also common in romanized Tamil/Kannada — "en", "un", "na", "ne",
 * "va", "di", "la" — are deliberately EXCLUDED, or "en pondati" would start
 * scoring as English.
 */

/** High-frequency English glue and verbs. Deliberately excludes short tokens
 *  that collide with romanized Indic spellings. */
const EN_FUNCTION = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'so', 'because', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'him', 'her', 'them', 'us', 'my', 'your', 'his',
  'its', 'our', 'their', 'mine', 'yours',
  'in', 'on', 'at', 'to', 'of', 'for', 'from', 'with', 'without', 'about', 'into', 'over',
  'under', 'after', 'before', 'between', 'through', 'during', 'by', 'up', 'down', 'out', 'off',
  'not', 'no', 'yes', 'very', 'just', 'only', 'also', 'still', 'even', 'more', 'most', 'much',
  'many', 'some', 'any', 'all', 'both', 'each', 'other', 'same', 'such', 'than', 'then', 'there',
  'here', 'where', 'when', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose',
  'get', 'got', 'go', 'going', 'went', 'come', 'coming', 'came', 'make', 'makes', 'made', 'take',
  'took', 'give', 'gave', 'send', 'sent', 'tell', 'told', 'say', 'said', 'know', 'knew', 'think',
  'thought', 'want', 'need', 'like', 'see', 'saw', 'look', 'use', 'used', 'find', 'found',
  'try', 'keep', 'let', 'put', 'ask', 'work', 'works', 'working', 'add', 'select', 'click',
  'type', 'open', 'close', 'check', 'call', 'wait', 'help', 'show', 'read', 'write',
  'something', 'anything', 'nothing', 'everything', 'someone', 'anyone', 'everyone',
  'now', 'today', 'tomorrow', 'yesterday', 'time', 'day', 'good', 'bad', 'new', 'old',
  'please', 'thanks', 'thank', 'sorry', 'okay', 'ok'
])

/** Fraction of words that are recognisably English glue. 0 when there are none. */
export function englishScore (text) {
  const words = String(text || '').toLowerCase().match(/[a-z']+/g) || []
  if (!words.length) return 0
  let hits = 0
  for (const w of words) if (EN_FUNCTION.has(w)) hits++
  return hits / words.length
}

/**
 * Half the words being English glue is decisive in practice, and the floor of
 * three words matters as much as the ratio: below it a single "no" or "ok"
 * would read as 100% English, and short romanized messages ("Naan varala")
 * are exactly the ones detection already gets wrong.
 */
export const ENGLISH_SURE = 0.5
export const ENGLISH_MIN_WORDS = 3

export const wordCount = (text) =>
  String(text || '').trim().split(/\s+/).filter(Boolean).length

/** True only for text long enough to judge AND densely English. */
export function isPlainEnglish (text) {
  return wordCount(text) >= ENGLISH_MIN_WORDS && englishScore(text) >= ENGLISH_SURE
}
