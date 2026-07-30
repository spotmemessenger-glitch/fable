/**
 * Spot Me — translation layer.
 *
 * Preference order, and the honesty that goes with it:
 *   1. Chrome's built-in on-device Translator API (Chrome 138+). Nothing
 *      leaves the phone — matches the native app's ML Kit decision.
 *   2. MyMemory public API as a CLOUD fallback. Plaintext goes to a third
 *      party; the UI labels these translations "cloud" so nobody mistakes the
 *      privacy property. The native app will not need this fallback.
 *
 * Messages carry the sender's language tag, so there is no detection step.
 */

const memory = new Map()               // "from|to|text" -> {text, engine}
// v1 held low-quality MyMemory entries; v2 held wrong-source passthroughs
// ("Unga Peru enna?" cached as its own translation), which outlived the fix
// because a cache hit short-circuits it.
const CACHE_KEY = 'spotme:tcache:v3'
const CACHE_MAX = 400
const translators = new Map()          // "from|to" -> Translator instance

/** Languages offered across the app. Indian languages are first-class. */
export const LANGS = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'mr', name: 'Marathi', native: 'मराठी' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
  /* The rest of South India. The four majors above are carried by every
   * engine; these two are not, which is part of why the LLM engine now leads —
   * Tulu and Konkani reach Google and Gemini but not the statistical pair. */
  { code: 'tcy', name: 'Tulu', native: 'ತುಳು' },
  { code: 'gom', name: 'Konkani', native: 'कोंकणी' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'as', name: 'Assamese', native: 'অসমীয়া' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'zh', name: 'Chinese', native: '中文' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'ru', name: 'Russian', native: 'Русский' }
]

export const langName = (code) => LANGS.find((l) => l.code === code)?.name || code

function loadCache () {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) for (const [k, v] of JSON.parse(raw)) memory.set(k, v)
  } catch { /* start cold */ }
}
loadCache()

function persistCache () {
  try {
    const entries = Array.from(memory.entries()).slice(-CACHE_MAX)
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries))
  } catch { /* full or private — cache stays in memory */ }
}

/** A hung engine must never strand a chat bubble on "…". */
function withTimeout (promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ])
}

async function deviceTranslator (from, to) {
  if (typeof self.Translator === 'undefined') return null
  const key = `${from}|${to}`
  // Negative results are cached too — without this, every keystroke's live
  // preview re-paid the 2s availability probe on devices with no on-device
  // model, which is exactly the "translation is slow" complaint.
  if (translators.has(key)) return translators.get(key) || null
  try {
    const availability = await withTimeout(
      self.Translator.availability({ sourceLanguage: from, targetLanguage: to }),
      2000
    )
    // 'downloadable' would trigger a multi-megabyte model download mid-chat
    // (and Translator.create can block indefinitely on it) — cloud fallback
    // handles this message; the browser may finish the download for later.
    if (availability !== 'available') {
      translators.set(key, false)
      return null
    }
    const t = await withTimeout(
      self.Translator.create({ sourceLanguage: from, targetLanguage: to }),
      4000
    )
    translators.set(key, t)
    return t
  } catch {
    translators.set(key, false)
    return null
  }
}

async function fetchJson (url, timeoutMs = 8000) {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`http ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(abortTimer)
  }
}

import { API_BASE } from './api.js'
import { freshTokens } from './socket-transport.js'

/**
 * Every /api/translate call carries the same short-lived access token the room
 * socket and the groups API already use.
 *
 * The endpoint proxies Anthropic, OpenAI, Gemini, Sarvam, Azure and Google, and
 * until now it was open to the internet with `ACAO: *` — the URL is in this
 * bundle, so anyone reading it could spend the owner's vendor credit. The token
 * is taken from socket-transport rather than minted here for the same reason
 * groups-api.js does it: two auth paths means two caches and two expiry clocks.
 *
 * The timeout is the important part. `freshTokens()` waits for onboarding to
 * produce a profile and will happily wait forever (socket-transport.js:163-166),
 * and the AbortController below only covers the fetch — so without this race a
 * pre-onboarding translate would hang rather than fail. Going out unauthenticated
 * earns a clean 401, which every caller here already treats as "try the next
 * engine".
 */
const TOKEN_WAIT_MS = 4000

async function authHeaders () {
  const headers = { 'content-type': 'application/json' }
  try {
    const { accessToken } = await Promise.race([
      freshTokens(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no token yet')), TOKEN_WAIT_MS))
    ])
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
  } catch { /* unauthenticated attempt; the caller falls back on 401 */ }
  return headers
}

/** POST to the proxy, authenticated, with a hard deadline. */
async function postTranslate (query, body, timeoutMs) {
  const controller = new AbortController()
  const headers = await authHeaders()
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`${API_BASE}/api/translate${query}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } finally {
    clearTimeout(abortTimer)
  }
}

/**
 * Cloud fallback, tried in quality order:
 *   1. Our /api/translate proxy → official Google Cloud Translation
 *      (the key lives server-side, never in this bundle).
 *   2. Google's keyless gtx endpoint.
 *   3. MyMemory — last resort (its community memory returns junk for some pairs).
 */
async function cloudTranslate (text, from, to) {
  const clipped = text.slice(0, 480)

  try {
    const res = await postTranslate('', { q: clipped, source: from || undefined, target: to }, 8000)
    if (res.ok) {
      const j = await res.json()
      if (j?.text) return { text: j.text, detected: j.detected || from || null }
    }
  } catch { /* try the next engine */ }

  try {
    const j = await fetchJson(
      'https://translate.googleapis.com/translate_a/single?client=gtx' +
      `&sl=${from || 'auto'}&tl=${to}&dt=t&q=${encodeURIComponent(clipped)}`
    )
    const out = Array.isArray(j?.[0]) ? j[0].map((seg) => seg?.[0] || '').join('') : null
    if (out) return { text: out, detected: j?.[2] || from || null }
  } catch { /* try the next engine */ }

  const j = await fetchJson(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clipped)}&langpair=${from || 'en'}|${to}`
  )
  const out = j?.responseData?.translatedText
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error('no translation')
  return { text: out, detected: from || null }
}

/**
 * Translate text. Returns { text, engine } where engine is 'device', 'cloud'
 * or null (same language / both engines failed — caller shows the original).
 */
/** Codes that mean "we do not actually know" — never send them as a source. */
const NO_SOURCE = new Set(['auto', 'und', 'unknown', 'zxx', 'mul'])

/** A source code we are willing to hand an engine: "ta", "ta-Latn", "pt-BR". */
function normalizeSource (from) {
  const code = String(from || '').trim()
  if (!code || NO_SOURCE.has(code.toLowerCase())) return null
  return /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/i.test(code) ? code : null
}

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
const unchanged = (a, b) => flat(a) === flat(b)

export async function translateText (text, from, to) {
  const src = normalizeSource(from)
  if (!text || !to || src === to) return { text, engine: null, detected: src || null }
  const key = `${src || 'auto'}|${to}|${text}`
  if (memory.has(key)) return memory.get(key)

  let result = null
  // The on-device translator needs a known source; detection is cloud-side.
  const device = src ? await deviceTranslator(src, to) : null
  if (device) {
    try {
      result = {
        text: await withTimeout(device.translate(text), 5000),
        engine: 'device',
        detected: src
      }
    } catch { /* fall through to cloud */ }
  }
  if (!result) {
    try {
      const out = await cloudTranslate(text, src, to)
      result = { text: out.text, engine: 'cloud', detected: out.detected }
    } catch {
      result = { text: null, engine: null, detected: null }
    }
  }

  /**
   * A declared source is a claim, not a fact: messages carry the SENDER'S
   * profile language, so someone typing romanized Tamil while set to English
   * ships text tagged "en". Asking an engine to translate en→ta then returns
   * the sentence untouched — the "translation does nothing" bug. When a
   * declared source produces no change, retry letting the cloud detect.
   */
  if (src && (!result.text || unchanged(result.text, text))) {
    try {
      const out = await cloudTranslate(text, null, to)
      if (out.text && !unchanged(out.text, text)) {
        result = { text: out.text, engine: 'cloud', detected: out.detected }
      }
    } catch { /* keep whatever the declared source produced */ }
  }

  // Never persist a no-op: a wrong-source passthrough would otherwise stick
  // in the cache (and in localStorage) and poison every later attempt.
  if (result.text && !unchanged(result.text, text)) {
    memory.set(key, result)
    persistCache()
  }
  return result
}

/**
 * Azure transliteration coverage: language → native script code. These are
 * the languages where typing in Latin can convert live even though the app's
 * built-in rules don't know the script.
 */
export const SCRIPT_MAP = {
  ta: 'Taml', hi: 'Deva', mr: 'Deva', te: 'Telu', bn: 'Beng', gu: 'Gujr',
  kn: 'Knda', ml: 'Mlym', pa: 'Guru', ur: 'Arab', ar: 'Arab', ja: 'Jpan', zh: 'Hans',
  ru: 'Cyrl', ko: 'Kore'
}


const readCache = new Map()   // in-memory only — never persisted to disk

/**
 * Read a chat message: which language, the same words in their own script,
 * and natural English — in ONE call. Measured far better than the
 * detect→transliterate→translate chain on ear-spelled input ("Ippo variya"
 * → "Are you coming now?" instead of "Is it tax now?"). Returns null on any
 * failure so the caller can fall back to the classic chain.
 *
 * Deliberately NOT written to localStorage: this is message content.
 */
export async function readMessage (text, hint) {
  const q = String(text || '').trim().slice(0, 480)
  if (!q) return null
  const key = `${hint || ''}|${q}`
  if (readCache.has(key)) return readCache.get(key)
  try {
    const res = await postTranslate('?op=read', { q, hint: hint || '' }, 8000)
    if (!res.ok) return null
    const json = await res.json()
    if (!json?.lang) return null
    const out = { lang: json.lang.split('-')[0], script: json.script || '', english: json.english || '' }
    if (readCache.size > 500) readCache.clear()
    readCache.set(key, out)
    return out
  } catch { return null }
}

const detectCache = new Map()

/**
 * What language is this draft? → { code, base, romanized, score } | null.
 *
 * Azure reports romanized input as "ta-Latn" / "hi-Latn", which is exactly
 * what transliteration needs: the language, plus the fact that it arrived in
 * Latin letters and therefore CAN be converted into its own script.
 */
export async function detectLanguage (text) {
  const q = String(text || '').trim().slice(0, 480)
  if (q.length < 2) return null
  if (detectCache.has(q)) return detectCache.get(q)
  try {
    const res = await postTranslate('?op=detect', { q }, 6000)
    if (!res.ok) return null
    const json = await res.json()
    if (!json?.language) return null
    const code = String(json.language)
    const out = {
      code,
      base: code.split('-')[0],
      romanized: /-Latn$/i.test(code),
      score: json.score ?? null
    }
    detectCache.set(q, out)
    return out
  } catch { return null }
}

const translitCache = new Map()

/** Latin draft → native script via Azure. Null on any failure — the caller
 * keeps its local conversion (or the raw text); nothing ever breaks typing. */
export async function transliterateRemote (text, lang, opts = {}) {
  const native = SCRIPT_MAP[lang]
  if (!native || !text) return null
  // Default direction: English letters → the language's own script. Pass
  // { toLatin: true } for the reverse, so a Tamil-script message can be read
  // by someone who speaks Tamil but does not read the script.
  const toScript = opts.toLatin ? 'Latn' : native
  const fromScript = opts.toLatin ? native : 'Latn'
  if (toScript === fromScript) return null
  const key = `${lang}|${fromScript}>${toScript}|${text}`
  if (translitCache.has(key)) return translitCache.get(key)
  try {
    const res = await postTranslate(
      '?op=translit', { q: text.slice(0, 480), lang, toScript, fromScript }, 6000
    )
    if (!res.ok) return null
    const j = await res.json()
    const out = j?.text || null
    // Never cache a no-op: an engine that hands the text back unchanged (a
    // stale deploy, an unsupported script pair) would otherwise pin that
    // failure in memory and defeat the fix that follows.
    if (out && out !== text) translitCache.set(key, out)
    return out
  } catch { return null }
}

/**
 * Warm the pipeline for a chat: spin up the serverless function (cold starts
 * cost ~300-500ms) and memoise device-translator availability for both
 * directions, so the first real translation is already hot.
 */
let warmed = false
export function warmup (myLang, peerLang) {
  if (peerLang && peerLang !== myLang) {
    deviceTranslator(peerLang, myLang).catch(() => {})
    deviceTranslator(myLang, peerLang).catch(() => {})
  }
  if (warmed) return
  warmed = true
  postTranslate(
    '', { q: 'hi', target: peerLang && peerLang !== myLang ? peerLang : 'es', source: 'en' }, 8000
  ).catch(() => {})
}

/** Read a message aloud in the listener's language via the Web Speech API. */
export function speak (text, lang) {
  try {
    if (!('speechSynthesis' in window)) return false
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = lang || 'en'
    window.speechSynthesis.speak(utterance)
    return true
  } catch {
    return false
  }
}

/** Dictate into the composer where SpeechRecognition exists (Chrome/Safari). */
export function dictate (lang, onResult, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return null
  const rec = new SR()
  rec.lang = lang || 'en'
  rec.interimResults = true
  rec.onresult = (e) => {
    const text = Array.from(e.results).map((r) => r[0].transcript).join('')
    onResult(text, e.results[e.results.length - 1].isFinal)
  }
  rec.onend = onEnd
  rec.onerror = onEnd
  rec.start()
  return rec
}
