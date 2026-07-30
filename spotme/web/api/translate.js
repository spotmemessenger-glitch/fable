/**
 * Spot Me — language services proxy. Keys live in env vars, never client-side.
 *
 * POST /api/translate                       {q, source?, target}
 *   → {text, detected, engine:'google'|'azure'}
 *   Engine order: source known → Google, then Azure. Source unknown → Azure
 *   first (its detection understands romanized text like "vanakkam" as
 *   ta-Latn, which Google cannot), then Google. No dead ends: both engines
 *   must fail before the client sees an error.
 *
 * POST /api/translate?op=translit           {q, lang, toScript, fromScript?}
 *   fromScript defaults to Latn (romanized → native); pass the native script
 *   and toScript:'Latn' for the reverse (native → readable in English letters).
 *   → {text}   Azure transliteration (Latin → native script), which covers
 *   far more languages than the app's built-in rules.
 *
 * POST /api/translate?op=read               {q, hint?}
 *   → {lang, script, english}  One LLM call replacing detect+translit+translate.
 *
 * POST /api/translate?op=detect             {q}
 *   → {language, score}   Azure language detection.
 */
const GOOGLE_URL = 'https://translation.googleapis.com/language/translate/v2'

function azureBase () {
  const ep = (process.env.AZURE_TRANSLATOR_ENDPOINT || '').replace(/\/$/, '')
  return `${ep}/translator/text/v3.0`
}

function azureHeaders () {
  return {
    'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
    'content-type': 'application/json'
  }
}

async function googleTranslate (q, source, target) {
  const key = process.env.GOOGLE_TRANSLATE_KEY
  if (!key) throw new Error('no google key')
  const body = { q, target, format: 'text' }
  if (source) body.source = source
  const res = await fetch(`${GOOGLE_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error?.message || `google ${res.status}`)
  const item = json?.data?.translations?.[0]
  if (!item?.translatedText) throw new Error('google empty')
  return { text: item.translatedText, detected: item.detectedSourceLanguage || source || null, engine: 'google' }
}

async function azureTranslate (q, source, target) {
  if (!process.env.AZURE_TRANSLATOR_KEY) throw new Error('no azure key')
  // Azure rejects region-suffixed detections as `from` (e.g. ta-Latn is not a
  // valid source for /translate) — omitting `from` lets it auto-handle both
  // native and romanized input.
  const from = source && !source.includes('-') ? `&from=${source}` : ''
  const res = await fetch(`${azureBase()}/translate?api-version=3.0&to=${target}${from}`, {
    method: 'POST',
    headers: azureHeaders(),
    body: JSON.stringify([{ Text: q }])
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error?.message || `azure ${res.status}`)
  const item = json?.[0]
  const text = item?.translations?.[0]?.text
  if (!text) throw new Error('azure empty')
  return { text, detected: item?.detectedLanguage?.language || source || null, engine: 'azure' }
}

/**
 * Sarvam — built specifically for Indian languages, which is most of what this
 * app carries. It speaks BCP-47-with-region codes (ta-IN, not ta), so anything
 * outside this table is not Sarvam's problem and falls through to Google/Azure.
 */
const SARVAM_LANGS = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', gu: 'gu-IN', kn: 'kn-IN',
  ml: 'ml-IN', mr: 'mr-IN', od: 'od-IN', or: 'od-IN', pa: 'pa-IN',
  ta: 'ta-IN', te: 'te-IN'
}

const sarvamCode = (lang) => SARVAM_LANGS[String(lang || '').toLowerCase().split('-')[0]]

async function sarvamPost (path, body) {
  const key = process.env.SARVAM_API_KEY
  if (!key) throw new Error('no sarvam key')
  const res = await fetch(`https://api.sarvam.ai/${path}`, {
    method: 'POST',
    // Header name matters: this API rejects Bearer and Ocp-Apim styles alike.
    headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`sarvam ${res.status}: ${JSON.stringify(json)?.slice(0, 160)}`)
  return json
}

async function sarvamTranslate (q, source, target) {
  const to = sarvamCode(target)
  const from = sarvamCode(source)
  if (!to) throw new Error(`sarvam does not speak ${target}`)
  const json = await sarvamPost('translate', {
    input: q,
    // "auto" lets Sarvam detect, which it does well on Indic text; naming a
    // language it does not support would fail the call outright.
    source_language_code: from || 'auto',
    target_language_code: to
  })
  const text = json?.translated_text
  if (!text) throw new Error('sarvam empty')
  return { text, detected: json?.source_language_code || source || null, engine: 'sarvam' }
}

async function sarvamTransliterate (q, lang) {
  const to = sarvamCode(lang)
  if (!to) throw new Error(`sarvam does not speak ${lang}`)
  const json = await sarvamPost('transliterate', {
    input: q, source_language_code: 'en-IN', target_language_code: to
  })
  const text = json?.transliterated_text
  if (!text) throw new Error('sarvam empty')
  return { text, engine: 'sarvam' }
}

async function azureTransliterate (q, lang, toScript, fromScript = 'Latn') {
  if (!process.env.AZURE_TRANSLATOR_KEY) throw new Error('no azure key')
  const res = await fetch(
    `${azureBase()}/transliterate?api-version=3.0&language=${lang}&fromScript=${fromScript}&toScript=${toScript}`,
    { method: 'POST', headers: azureHeaders(), body: JSON.stringify([{ Text: q }]) }
  )
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error?.message || `azure ${res.status}`)
  const text = json?.[0]?.text
  if (!text) throw new Error('transliterate empty')
  return { text }
}


/**
 * Google Input Tools — the engine behind Gboard's Indic typing. Unlike a raw
 * character mapper it knows real words, so ear-spelled input ("vetuku",
 * "unaruu") lands on the right word where Azure's transliterator does not.
 * Undocumented and keyless: treat every failure as "fall back to Azure".
 */
async function googleTransliterate (q, lang) {
  const url = 'https://inputtools.google.com/request?text=' + encodeURIComponent(q) +
    `&itc=${encodeURIComponent(lang)}-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8&app=spotme`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`inputtools ${res.status}`)
  const json = await res.json()
  if (json?.[0] !== 'SUCCESS') throw new Error('inputtools rejected the text')
  const text = json?.[1]?.[0]?.[1]?.[0]
  if (!text) throw new Error('inputtools empty')
  return { text, engine: 'google' }
}


/**
 * The reading layer. One call answers all three questions at once — which
 * language, the same words in their own script, and natural English — which
 * is what makes it beat the detect→transliterate→translate chain on
 * ear-spelled input ("Ippo variya" → "Are you coming now?", where the chain
 * gives "Is it tax now?"). Names and brands survive untouched.
 */
/**
 * Ask one LLM provider. Kept separate from llmRead so the reading engine can
 * try a second provider when the first is down, throttled, or holding a key
 * that has since been rotated — which took the app's headline feature offline
 * once already.
 */
async function askAnthropic (system, user) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('no anthropic key')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      // Unpinned alias on purpose: a dated snapshot goes 404 when it retires,
      // and this feature failing over a model name is a bad trade for the
      // reproducibility a pin buys.
      model: process.env.READ_MODEL || 'claude-sonnet-5',
      max_tokens: 300,
      // No `temperature`: current Claude models reject it outright
      // ("`temperature` is deprecated for this model", HTTP 400), which took
      // the whole reading layer down. Determinism here comes from the rules in
      // the system prompt and the pre-filled brace below, not a sampling knob.
      system,
      // No assistant prefill. Steering the reply by pre-filling an opening
      // brace worked on older models and is rejected outright by current ones
      // ("This model does not support assistant message prefill", HTTP 400),
      // which took the reading layer offline. The system prompt already
      // demands bare JSON; jsonFrom() below handles a stray fence or preamble.
      messages: [{ role: 'user', content: user }]
    })
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  // NOT content[0]: current models can emit a reasoning block first, so the
  // answer is the first block that is actually of type "text". Assuming index
  // zero returned undefined and read as "anthropic empty" — a working reply,
  // discarded for looking in the wrong slot.
  const body = (json?.content || []).find((b) => b?.type === 'text')?.text
  if (!body) throw new Error('anthropic empty')
  return body
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Models occasionally wrap JSON in a ```json fence or a line of preamble. That
 * is a formatting slip, not a failed answer, and throwing it away would drop a
 * perfectly good translation.
 */
function jsonFrom (raw) {
  const text = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('model did not return JSON')
    return JSON.parse(text.slice(start, end + 1))
  }
}

/**
 * Gemini — the second opinion when the first reader does not recognise a
 * message. Google's models see a great deal of romanized Indic text, which is
 * exactly the input this app lives on.
 *
 * Auth is the `x-goog-api-key` header. A Bearer token is NOT accepted here
 * (the API answers 401 asking for an OAuth token), which is worth stating
 * because the key format looks like one.
 */
async function askGemini (system, user) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('no gemini key')
  /* 'gemini-2.0-flash' and every pinned 2.x id now answer
   *   404 "This model is no longer available to new users"
   * for this key, so Gemini had been silently dead: adjudicate() lists it
   * first among the judges, threw every time, and quietly fell through to
   * OpenAI. Only the floating aliases still resolve. Measured on this key:
   * flash-lite ~0.8s, flash ~3.5s (it thinks before answering), so lite. */
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // Gemini has a real JSON mode, so no brace-prefill trickery is needed.
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 400 }
      })
    }
  )
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200)
    // 429 here usually means the AI Studio project is out of credit rather
    // than that we are sending too fast — the message says which.
    throw new Error(`gemini ${res.status}: ${detail}`)
  }
  const json = await res.json()
  const body = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || ''
  if (!body.trim()) throw new Error('gemini empty')
  return body
}

async function askOpenAI (system, user) {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('no openai key')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      // gpt-4o, not mini: measured on held-out Tanglish, mini dropped items
      // from lists ("eyes, lips, nose, face" became "face under your eyes")
      // and invented people's names out of ordinary words.
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  })
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const raw = json?.choices?.[0]?.message?.content
  if (!raw) throw new Error('openai empty')
  return raw
}

async function llmRead (q, hint) {
  // Must list every provider below. This guard predated Gemini and, left
  // alone, refused to run at all when Gemini was the ONLY key configured —
  // silently disabling the exact fallback it was added to provide.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY &&
      !process.env.OPENAI_API_KEY) {
    throw new Error('no llm key')
  }
  /* Graded against a 26-sentence corpus of the owner's own Tanglish, the
   * bare instruction scored 14/26. The failures were systematic, not random:
   * person markers flipped (ne = YOU became "he"), negation dropped
   * (matanga = will NOT), tense lost (saptinga = ate, not eating), ordinary
   * words taken as names ("Kaila" for kaila = in the hand), and near-homophones
   * chosen wrongly (vekam shy vs vegam fast). Each rule below is one of those
   * failures; the examples teach the spelling conventions people actually use. */
  const system = [
    'You read romanized Indian-language chat (Tanglish, Tenglish, Kanglish, Hinglish) written in English letters by native speakers who spell by ear.',
    'Reply ONLY as compact JSON: {"lang":"<iso 639-1>","script":"<the same words in the native script>","english":"<natural, casual English>"}.',
    'RULES, in order of importance:',
    '1. PERSON: ne/nee/unna/unaku/neenga = YOU. avan/ava/avana = he/she. naan/enaku/en = I/me. Never swap these.',
    '2. NEGATION: word-endings la/le/illa/matanga/maten/kala mean NOT. "pidikala" = do NOT like. "iruka matanga" = will NOT be there.',
    '3. TENSE: -ttinga/-ttiya/-tten/-tan = PAST. "saptinga" = did you eat (not are you eating). "poitan" = has gone/died.',
    '4. QUESTION MARKER: a trailing -aa or -ya turns a statement into a yes/no question. paravailla = it is ok, but paravaillaya = IS it ok? Likewise iruka/irukaa, vandhutta/vandhuttiya, sapta/saptiya, vilunthitta/vilunthitiya. Never flatten the question into a statement.',
    '5. Do NOT invent proper nouns. Ordinary words are not names: kaila = in the hand, vettla = at home, seri = okay.',
    '6. Spelling is approximate — choose the meaning a friend would obviously intend in a chat, not the closest-looking dictionary word.',
    '7. Translate EVERY word. Do not drop items from a list.',
    '8. Keep real names, brands and English loanwords exactly as written (Yuvs, Bitcoin, OpenAI).',
    '9. Keep the casual register. Never make it formal or polite beyond the original.',
    'If the message is ordinary English, reply {"lang":"en","script":"","english":""}.',
    'Worked examples (Tamil):',
    'ne epadi iruka -> how are you (casual)',
    'ena saptinga -> what did you eat',
    'ne romba ketta payan -> you are a very bad boy',
    'vettla yaar elam iruka -> who all are at home',
    'kaila ena iruku -> what is in your hand',
    'enaku romba vekama iruku -> I am feeling very shy',
    'avan sethu poitan -> he is dead',
    'ena kalayam paniko -> marry me',
    'poda pani -> get lost you pig',
    'adi vanga pora -> you are going to get beaten up',
    'rathiri vetuku va amma appa iruka matanga -> come home tonight, my mom and dad will not be there',
    'seri ya sollu -> tell me properly',
    'paravailla -> it is ok',
    'paravaillaya -> is it ok?'
  ].join(String.fromCharCode(10))
  const user = hint
    ? `Hint: when this sender writes in an Indian language it is usually ${hint}. `
      + `Use that ONLY if the message really is that language — if it is ordinary English, answer lang "en". `
      + `Message: ${q}`
    : q
  /* Whichever provider is configured, in order, first success wins. Anthropic
   * leads because it is the key that is known-good; OpenAI's was found rotated
   * in the field, and a silent 401 there should cost accuracy, not the whole
   * feature. Failures are collected so a total outage still says why. */
  const providers = []
  if (process.env.ANTHROPIC_API_KEY) providers.push(['anthropic', askAnthropic])
  // Gemini sits second: it is the supervisor for messages the first reader
  // cannot make sense of, and Google's models see far more romanized Indic
  // text than most. It is ahead of OpenAI because that key has been found
  // rotated in the field more than once.
  if (process.env.GEMINI_API_KEY) providers.push(['gemini', askGemini])
  if (process.env.OPENAI_API_KEY) providers.push(['openai', askOpenAI])

  let parsed = null
  const failures = []
  for (const [name, ask] of providers) {
    try {
      const raw = await ask(system, user)
      if (!raw) continue
      const candidate = jsonFrom(raw)
      // A reader that NAMES a language but returns no English has not
      // understood the message — it recognised the script and gave up. That is
      // a failure even though the call succeeded, so the next provider gets a
      // turn. Plain English is exempt: {"lang":"en","english":""} is the
      // correct answer for a message that needs no translation.
      const named = String(candidate.lang || '')
      if (named && named !== 'en' && !String(candidate.english || '').trim()) {
        failures.push(`${name}: recognised ${named} but returned no translation`)
        continue
      }
      parsed = candidate
      break
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }
  if (!parsed) throw new Error(failures.join(' | ') || 'no llm provider')
  return {
    lang: String(parsed.lang || '').slice(0, 8),
    script: String(parsed.script || ''),
    english: String(parsed.english || ''),
    engine: 'llm'
  }
}

/**
 * Do two engines agree? Compared on meaning-bearing characters only.
 *
 * Engines differ constantly in ways a reader would not notice — a trailing
 * full stop, ஒரு vs ஓர், a space before a question mark. Treating those as
 * disagreement would send almost every message to the adjudicator and triple
 * the cost for nothing.
 */
function agree (a, b) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\s‌‍]+/g, '')      // whitespace + zero-width joiners
    .replace(/[.,!?;:''""()।]/g, '')   // punctuation, incl. the danda
  return norm(a) === norm(b) && norm(a).length > 0
}

/**
 * Translate with Gemini.
 *
 * The engines above are statistical translators; this one reads the sentence.
 * That matters most for the traffic this app actually carries — short,
 * context-dependent Indic chat where the right answer depends on who is
 * speaking to whom ("varen" is a promise to come, not a description).
 *
 * It returns the same shape as every other engine, so it drops into the
 * existing cross-confirmation without the callers knowing which engine ran.
 */
async function geminiTranslate (q, source, target) {
  const system = [
    'You are a translation engine. Translate the user text into the target language.',
    'Preserve meaning, tone and register; keep names, numbers, emoji and @handles as they are.',
    'Write what a native speaker would actually say, not a word-for-word gloss.',
    'Reply ONLY as compact JSON: {"text":"<translation>"} with no commentary.'
  ].join(' ')
  const user = `TARGET LANGUAGE: ${target}${source ? `\nSOURCE LANGUAGE: ${source}` : ''}\nTEXT: ${q}`
  const parsed = jsonFrom(await askGemini(system, user))
  const text = String(parsed.text || '').trim()
  if (!text) throw new Error('gemini translate empty')
  return { text, detected: source || null, engine: 'gemini' }
}

/**
 * Ask a language model which of two translations is right.
 *
 * Reached only when the specialist and the general engine actually disagree,
 * which is where the accuracy is won: one of them is usually wrong in a way
 * the other is not, and a model that reads both plus the original can tell.
 * Any failure here falls back to the specialist rather than erroring — a
 * second opinion is an improvement, never a dependency.
 */
async function adjudicate (original, target, a, b, exclude = []) {
  const system = [
    'You judge translations into Indian languages.',
    'You are given the ORIGINAL text and two candidate translations, A and B.',
    'Pick the one that a native speaker would actually say: correct meaning first,',
    'then natural phrasing and register. Ignore trivial punctuation differences.',
    'If both are wrong, write a better translation yourself.',
    'Reply ONLY as compact JSON: {"pick":"A"|"B"|"other","text":"<the winning translation>","why":"<8 words max>"}'
  ].join(' ')
  const user = `ORIGINAL: ${original}\nTARGET LANGUAGE: ${target}\nA: ${a}\nB: ${b}`

  /* OpenAI supervises. It is deliberately first now that Gemini can be one of
   * the translators: a model marking its own homework is not a second opinion,
   * and `exclude` drops any judge that wrote one of the candidates. */
  const judges = []
  if (process.env.OPENAI_API_KEY) judges.push(['openai', askOpenAI])
  if (process.env.GEMINI_API_KEY) judges.push(['gemini', askGemini])
  if (process.env.ANTHROPIC_API_KEY) judges.push(['anthropic', askAnthropic])

  for (const [name, ask] of judges.filter(([n]) => !exclude.includes(n))) {
    try {
      const parsed = jsonFrom(await ask(system, user))
      const text = String(parsed.text || '').trim()
      if (text) return { text, judge: name, pick: String(parsed.pick || '') }
    } catch { /* next judge */ }
  }
  return null
}

/**
 * Translate, then have a second engine confirm it.
 *
 * Sarvam is trained specifically for Indian languages; Google and Azure are
 * general. Running both and comparing catches the case where one is confidently
 * wrong — which a single engine can never tell you about. They run in PARALLEL,
 * so confirmation costs roughly nothing in wall-clock time; only a genuine
 * disagreement costs an extra call.
 */
async function confirmedTranslate (q, source, target, primary) {
  if (!process.env.SARVAM_API_KEY || !sarvamCode(target)) return null
  const [first, second] = await Promise.allSettled([
    primary(),
    sarvamTranslate(q, source, target)
  ])
  const a = first.status === 'fulfilled' ? first.value : null
  const b = second.status === 'fulfilled' ? second.value : null
  if (!a && !b) return null
  if (!a) return { ...b, confirmed: false, note: 'single engine' }
  if (!b) return { ...a, confirmed: false, note: 'single engine' }

  if (agree(a.text, b.text)) {
    // Two independent engines landing on the same words is the strongest
    // signal available without a human.
    return { ...b, confirmed: true, engine: `${b.engine}+${a.engine}` }
  }

  // A candidate's own author never judges the comparison it is part of.
  const authors = [a.engine, b.engine].map((e) => String(e || '').split('+')[0])
  const verdict = await adjudicate(q, target, a.text, b.text, authors)
  if (!verdict) {
    // No judge available: prefer the specialist for its own languages.
    return { ...b, confirmed: false, alternative: a.text, note: 'engines differ, unjudged' }
  }
  return {
    text: verdict.text,
    detected: b.detected || a.detected || null,
    engine: `${b.engine}+${a.engine}/${verdict.judge}`,
    confirmed: true,
    alternative: verdict.pick === 'A' ? b.text : a.text
  }
}

async function azureDetect (q) {
  if (!process.env.AZURE_TRANSLATOR_KEY) throw new Error('no azure key')
  let res = await fetch(`${azureBase()}/detect?api-version=3.0`, {
    method: 'POST', headers: azureHeaders(), body: JSON.stringify([{ Text: q }])
  })
  // The free tier throttles at ~10 req/s and asks for a one-second wait.
  if (res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 1100))
    res = await fetch(`${azureBase()}/detect?api-version=3.0`, {
      method: 'POST', headers: azureHeaders(), body: JSON.stringify([{ Text: q }])
    })
  }
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error?.message || `azure ${res.status}`)
  const item = json?.[0]
  if (!item?.language) throw new Error('detect empty')
  return { language: item.language, score: item.score ?? null }
}

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
  const q = typeof body?.q === 'string' ? body.q.slice(0, 1000) : ''
  if (!q) { res.status(400).json({ error: 'need q' }); return }

  let op = req.query?.op
  if (!op && req.url) {
    try { op = new URL(req.url, 'http://x').searchParams.get('op') } catch { /* no op */ }
  }

  try {
    if (op === 'translit') {
      const lang = String(body.lang || '')
      const toScript = String(body.toScript || '')
      const fromScript = String(body.fromScript || 'Latn')
      if (!/^[a-z-]{2,10}$/i.test(lang) || !/^[A-Za-z]{4}$/.test(toScript) ||
          !/^[A-Za-z]{4}$/.test(fromScript)) {
        res.status(400).json({ error: 'need lang and toScript' })
        return
      }
      if (fromScript === 'Latn') {
        // Google Input Tools and Sarvam, in parallel, then compared. Input
        // Tools is the engine behind Gboard's Indic typing and knows real
        // WORDS; Sarvam is trained for these languages specifically. When both
        // spell a name the same way it is almost certainly right, and when
        // they differ that is exactly where transliteration goes wrong.
        const [g, s] = await Promise.allSettled([
          googleTransliterate(q, lang),
          sarvamTransliterate(q, lang)
        ])
        const gv = g.status === 'fulfilled' ? g.value : null
        const sv = s.status === 'fulfilled' ? s.value : null
        if (gv && sv && agree(gv.text, sv.text)) {
          res.status(200).json({ ...gv, engine: 'google+sarvam', confirmed: true })
          return
        }
        if (gv || sv) {
          // Input Tools leads on disagreement: it is word-aware, so it handles
          // the ear-spelled input people actually type. The other reading is
          // returned too rather than thrown away.
          const win = gv || sv
          const other = gv && sv ? (win === gv ? sv.text : gv.text) : undefined
          res.status(200).json({ ...win, confirmed: false, alternative: other })
          return
        }
      }
      res.status(200).json(await azureTransliterate(q, lang, toScript, fromScript))
      return
    }

    if (op === 'read') {
      const hint = typeof body.hint === 'string' ? body.hint.slice(0, 24) : ''
      res.status(200).json(await llmRead(q, hint))
      return
    }

    if (op === 'detect') {
      res.status(200).json(await azureDetect(q))
      return
    }

    const source = body.source ? String(body.source) : null
    const target = String(body.target || '')
    if (!target) { res.status(400).json({ error: 'need target' }); return }

    // No dead ends: engines ordered by who is better at THIS input.
    //
    // Sarvam leads whenever an Indian language is involved — it is trained for
    // exactly those, and this app's traffic is mostly Indic. It is skipped
    // silently for pairs it does not speak (sarvamCode returns undefined and
    // the attempt throws), so a French message still goes to Google/Azure.
    const indic = sarvamCode(target) && sarvamCode(target) !== 'en-IN'
      ? true
      : Boolean(source && sarvamCode(source) && sarvamCode(source) !== 'en-IN')
    const engines = source
      ? [() => googleTranslate(q, source, target), () => azureTranslate(q, source, target)]
      : [() => azureTranslate(q, null, target), () => googleTranslate(q, null, target)]
    // Cross-confirmation for Indian languages: the specialist and a general
    // engine both translate, and they only disagree when one of them is wrong.
    // Opt out with {verify:false} for a latency-critical path.
    if (indic && body.verify !== false) {
      /* Gemini leads when it is configured: measured against the statistical
       * engines it reads context that they cannot, which is most of what this
       * app carries. Sarvam still runs beside it as an INDEPENDENT second
       * opinion — two engines of the same kind agreeing proves little, so the
       * pairing is deliberately one reader and one specialist. Gemini failing
       * (dead model, no credit) falls back to the previous lead untouched. */
      const lead = process.env.GEMINI_API_KEY
        ? () => geminiTranslate(q, source, target).catch(() => engines[0]())
        : engines[0]
      const checked = await confirmedTranslate(q, source, target, lead)
      if (checked) { res.status(200).json(checked); return }
    }
    if (indic && process.env.SARVAM_API_KEY) {
      engines.unshift(() => sarvamTranslate(q, source, target))
    }
    let lastError = null
    for (const attempt of engines) {
      try { res.status(200).json(await attempt()); return } catch (e) { lastError = e }
    }
    res.status(502).json({ error: String(lastError?.message || 'all engines failed') })
  } catch (e) {
    const detail = String(e?.message || e)
    if (/rate limit|429|too many requests/i.test(detail)) {
      res.setHeader('Retry-After', '1')
      res.status(429).json({ error: 'Language service is busy — retry in a moment' })
      return
    }
    // Never relay the upstream text: it names the vendor and pricing tier.
    console.error('translate proxy failure:', detail)
    res.status(502).json({ error: 'Language service unavailable' })
  }
}
