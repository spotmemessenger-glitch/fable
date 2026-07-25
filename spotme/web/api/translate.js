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
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300,
      temperature: 0,
      system,
      // Claude has no JSON response mode, so the reply is steered by
      // pre-filling the opening brace — it then has nowhere to go but JSON.
      messages: [{ role: 'user', content: user }, { role: 'assistant', content: '{' }]
    })
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const body = json?.content?.[0]?.text
  if (!body) throw new Error('anthropic empty')
  return '{' + body          // put back the brace we pre-filled
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
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
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
  if (process.env.OPENAI_API_KEY) providers.push(['openai', askOpenAI])

  let raw = null
  const failures = []
  for (const [name, ask] of providers) {
    try {
      raw = await ask(system, user)
      if (raw) break
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }
  if (!raw) throw new Error(failures.join(' | ') || 'no llm provider')
  const parsed = JSON.parse(raw)
  return {
    lang: String(parsed.lang || '').slice(0, 8),
    script: String(parsed.script || ''),
    english: String(parsed.english || ''),
    engine: 'llm'
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
        try {
          res.status(200).json(await googleTransliterate(q, lang))
          return
        } catch { /* fall through to Azure */ }
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

    // No dead ends: two engines, ordered by who is better at this input.
    const engines = source
      ? [() => googleTranslate(q, source, target), () => azureTranslate(q, source, target)]
      : [() => azureTranslate(q, null, target), () => googleTranslate(q, null, target)]
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
