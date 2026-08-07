/**
 * Chat island — language composer (ADR-035 final slice, session 3).
 *
 * Translation + transliteration for the React chat, driving the SAME engines
 * the legacy view drives — lib/translate.js (translateText,
 * transliterateRemote, detectLanguage, langName) and the bundled
 * spotme-core/core/translit.js — through injected deps, never rewritten.
 * The @spotme/ui package only ever sees display-ready strings (ComposerView,
 * TranslationLine); every engine, timer and cache lives HERE.
 *
 * Semantics mirror views/chat.js line for line:
 *   - composeMode/langTo/xlit/xlitLang persist per-convo via db.upsertConvo
 *     (the same keys the legacy header writes, so flipping the flag keeps
 *     the user's choices);
 *   - translit mode NEVER rewrites the outgoing text — it is a reading aid;
 *   - translate mode sends the translated hero line with the ORIGINAL riding
 *     the envelope as `tr: { lang, text }` (characterization-pinned shape),
 *     falling back to the raw draft when every engine is down (4s cap);
 *   - incoming rows translate only when: theirs, plain text, autoTranslate
 *     profile flag, and this chat's globe is ON with a target picked. The
 *     sender-shipped `tr` in my language is the zero-wait instant path.
 *
 * No flag read here — the single one lives in chat-island.js.
 */

/** Same target lists as the legacy header. */
export const TR_LANGS = [
  'en',
  'ta', 'te', 'kn', 'ml', 'tcy', 'gom',
  'hi', 'mr', 'bn', 'gu', 'pa', 'ur', 'or', 'as',
  'ar', 'zh', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru'
]
export const XLIT_LANGS = ['ta', 'te', 'ml', 'kn', 'hi', 'mr', 'bn', 'gu', 'pa', 'ur']

const TRANSLATE_DEBOUNCE_MS = 320
const TRANSLIT_DEBOUNCE_MS = 260
const SEND_TRANSLATE_CAP_MS = 4000

/** Legacy flatten: unchanged-through-translation suppression. */
const flatten = (t) => String(t || '').replace(/[\s\p{P}]+/gu, ' ').trim().toLowerCase()

/**
 * @param {object} deps
 * @param {object} deps.db - lib/db.js
 * @param {object} deps.lang - the engines, injected so an app-side test can
 *   pin the exact call shapes: { translateText, transliterateRemote,
 *   detectLanguage, langName, transliterate, supportedScripts,
 *   isPlainEnglish, actionSheet }
 * @param {{ toast(m:string):void }} ctx
 * @param {string} roomId
 * @param {() => void} invalidate - snapshot invalidation (port-owned)
 */
export function buildLangComposer ({ db, lang }, ctx, roomId, invalidate) {
  const {
    translateText, transliterateRemote, detectLanguage, langName,
    transliterate, supportedScripts, isPlainEnglish, actionSheet
  } = lang

  const convo = () => db.convo(roomId) || {}
  const hasLocalScript = (code) => supportedScripts().some((s) => s.code === code)

  /* --------------------------------------------------- persisted choices */
  const composeState = () => {
    const c = convo()
    return { mode: c.composeMode || null, langTo: c.langTo || null }
  }
  const xlitOn = () => {
    const c = convo()
    return c.xlit === undefined ? Boolean(db.profile().translit) : Boolean(c.xlit)
  }
  const setCompose = (patch) => { db.upsertConvo({ roomId, ...patch }); refreshPreview(); invalidate() }

  /** Legacy readingTag: never print a raw ISO code at a person. */
  function readingTag (code, mode) {
    const base = String(code || '').split('-')[0]
    if (!base || base === 'en') return mode
    const name = langName(base)
    return name && name !== base ? `${name} · ${mode}` : mode
  }

  /** The language THEIR messages arrive in (legacy myReadLang). */
  function myReadLang () {
    const c = convo()
    return c.myLang && c.myLang !== c.langTo ? c.myLang : db.profile().lang
  }
  function rememberMyLang (detected) {
    const base = String(detected || '').split('-')[0]
    if (!base || base === 'und') return
    if (convo().myLang !== base) db.upsertConvo({ roomId, myLang: base })
  }

  /* -------------------------------------------------------- toggles/picks */
  function toggleTranslate () {
    const { mode } = composeState()
    const on = mode !== 'translate'
    const remembered = convo().langTo
    setCompose({
      composeMode: on ? 'translate' : (xlitOn() ? 'translit' : null),
      langTo: on ? (remembered || 'en') : null
    })
    ctx.toast(on ? `Translating into ${langName(remembered || 'en')}` : 'Translation off')
  }
  function pickTranslateLang () {
    const cur = convo().langTo || 'en'
    actionSheet(
      TR_LANGS.map((code) => ({
        label: (cur === code ? '✓ ' : '') + langName(code),
        fn () {
          setCompose({ composeMode: 'translate', langTo: code })
          ctx.toast(`Translating into ${langName(code)}`)
        }
      })),
      'Translate into…'
    )
  }
  function toggleTranslit () {
    const on = !xlitOn()
    const { mode } = composeState()
    // Translation owns the composer when both are on (legacy rule).
    setCompose({ xlit: on, composeMode: mode === 'translate' ? mode : (on ? 'translit' : null) })
    ctx.toast(on ? 'Transliteration on for this chat' : 'Transliteration off')
  }
  function pickTranslitLang () {
    const cur = convo().xlitLang || null
    const pick = (code) => setCompose({ xlitLang: code, translitLang: code })
    actionSheet([
      { label: (cur ? '' : '✓ ') + 'Auto-detect', fn: () => pick(null) },
      ...XLIT_LANGS.map((code) => ({
        label: (cur === code ? '✓ ' : '') + langName(code),
        fn: () => pick(code)
      }))
    ], 'You are typing in…')
  }

  /* ---------------------------------------------------- composer preview */
  let preview = null           // { tag, main, sub } | null
  let lastDraft = ''
  let bestConvert = null       // translit: { src, text, lang, engine }
  let lastTranslation = null   // translate: { src, text, lang, detected }
  let lastDetect = null        // translit: { src, base }
  let seq = 0
  let timer = null

  const setPreview = (next) => { preview = next; invalidate() }

  /** Which language this draft should be written in (legacy translitTarget). */
  function translitTarget (raw) {
    const c = convo()
    if (c.xlitLang && c.xlitLang !== 'en') return c.xlitLang
    if (lastDetect?.src === raw && lastDetect.base && lastDetect.base !== 'en') return lastDetect.base
    const learned = c.xlitLang || c.translitLang || c.myLang || null
    return learned && learned !== 'en' ? learned : null
  }

  const translitTag = (code, converted) =>
    converted ? `文A ${readingTag(code, 'Transliterated')}` : '文A Reading…'

  function runTranslit (raw, mySeq) {
    // Plain English settles deterministically and for free (legacy rule).
    if (isPlainEnglish(raw)) {
      lastDetect = null
      bestConvert = null
      setPreview({ tag: '文A Already English', main: raw, sub: '' })
      return
    }
    const target = translitTarget(raw)
    // Instant on-device conversion; leftover ASCII means the guess was wrong.
    if (target && hasLocalScript(target) &&
        !(bestConvert?.src === raw && bestConvert.engine === 'azure')) {
      try {
        const converted = transliterate(raw, target)
        if (converted && converted !== raw && !/[a-z]/i.test(converted)) {
          bestConvert = { src: raw, text: converted, lang: target, engine: 'local' }
        }
      } catch { /* the remote stage still covers it */ }
    }
    const showing = bestConvert?.src === raw ? bestConvert : null
    setPreview({
      tag: translitTag(showing?.lang || target, Boolean(showing)),
      // Never blank — the draft itself is a truthful placeholder.
      main: showing?.text || raw,
      sub: ''
    })

    timer = setTimeout(async () => {
      try {
        let code = target
        if (!code) {
          const hit = await detectLanguage(raw)
          if (mySeq !== seq) return
          if (hit?.base === 'en') {
            lastDetect = null
            bestConvert = null
            setPreview({ tag: '文A Already English', main: raw, sub: '' })
            return
          }
          code = hit?.base || null
          if (code) lastDetect = { src: raw, base: code }
        }
        if (!code || code === 'en') {
          if (!showing) setPreview({ tag: '文A Could not read that one', main: raw, sub: '' })
          return
        }
        // The remote transliterator knows real WORDS — it upgrades the rules.
        const native = await transliterateRemote(raw, code)
        if (mySeq !== seq) return
        if (!native || native === raw) {
          if (!bestConvert || bestConvert.src !== raw) {
            setPreview({ tag: '文A Could not read that one', main: raw, sub: '' })
          }
          return
        }
        bestConvert = { src: raw, text: native, lang: code, engine: 'azure' }
        setPreview({ tag: translitTag(code, true), main: native, sub: '' })
      } catch { /* keep whatever is painted — failures never blank it */ }
    }, TRANSLIT_DEBOUNCE_MS)
  }

  const detectedSub = (detected, langTo) => {
    if (!detected || detected === langTo) return ''
    const base = String(detected).split('-')[0]
    const roman = String(detected).includes('-Latn') ? ' (romanized)' : ''
    return `Detected ${langName(base)}${roman}`
  }

  function runTranslate (raw, langTo, mySeq) {
    const fresh = lastTranslation?.src === raw && lastTranslation.lang === langTo
    setPreview({
      tag: `文A Translation · ${langName(langTo)}`,
      main: fresh ? lastTranslation.text : '…',
      sub: fresh ? detectedSub(lastTranslation.detected, langTo) : ''
    })
    timer = setTimeout(() => {
      translateText(raw, null, langTo).then((res) => {
        if (mySeq !== seq) return
        if (res.text && res.engine !== null) {
          lastTranslation = { src: raw, text: res.text, lang: langTo, detected: res.detected }
          rememberMyLang(res.detected)
          setPreview({
            tag: `文A Translation · ${langName(langTo)}`,
            main: res.text,
            sub: detectedSub(res.detected, langTo)
          })
        }
      }).catch(() => { /* the raw draft stays sendable */ })
    }, TRANSLATE_DEBOUNCE_MS)
  }

  function draftChanged (raw) {
    lastDraft = String(raw || '').trim()
    refreshPreview()
  }

  function refreshPreview () {
    const raw = lastDraft
    const { mode, langTo } = composeState()
    if (timer) { clearTimeout(timer); timer = null }
    const mySeq = ++seq
    if (!mode || !raw || (mode === 'translate' && !langTo)) {
      lastTranslation = null
      if (preview) setPreview(null)
      return
    }
    if (mode === 'translit') runTranslit(raw, mySeq)
    else runTranslate(raw, langTo, mySeq)
  }

  /* ---------------------------------------------------------------- send */
  let sendBusy = false

  const afterSend = () => {
    bestConvert = null
    lastTranslation = null
    lastDraft = ''
    if (timer) { clearTimeout(timer); timer = null }
    ++seq
    setPreview(null)
  }

  /** Route a draft through the active mode, then hand the engine-ready
   *  partial to `dispatch` (the port adds replyTo/ttl and calls
   *  rooms.sendMessage — the same call the legacy dispatchSend makes). */
  function sendText (raw, dispatch) {
    const { mode, langTo } = composeState()
    // Transliteration never rewrites what leaves the device (reading aid).
    if (mode !== 'translate' || !langTo) {
      dispatch({ text: raw })
      afterSend()
      return
    }
    if (lastTranslation?.src === raw && lastTranslation.lang === langTo) {
      const src = String(lastTranslation.detected || 'en').split('-')[0]
      // tr carries the ORIGINAL: a receiver reading my language sees it instantly.
      dispatch({ text: lastTranslation.text, lang: langTo, tr: { lang: src, text: raw } })
      afterSend()
      return
    }
    if (sendBusy) return
    // Preview has not caught up — finish the translation, then send (4s cap;
    // if every engine is down the plain draft goes out instead).
    sendBusy = true
    Promise.race([
      translateText(raw, null, langTo),
      new Promise((resolve) => setTimeout(() => resolve({ text: null, engine: null }), SEND_TRANSLATE_CAP_MS))
    ]).catch(() => ({ text: null, engine: null })).then((res) => {
      sendBusy = false
      if (res?.text && res.engine !== null) {
        const src = String(res.detected || 'en').split('-')[0]
        dispatch({ text: res.text, lang: langTo, tr: { lang: src, text: raw } })
      } else {
        dispatch({ text: raw })
      }
      afterSend()
    })
  }

  /* ------------------------------------------- incoming translation line */
  const trCache = new Map()    // id -> { text, engine, detected } | 'pending'

  /** The TranslationLine for a THEIR text row, or null (legacy applyTranslation). */
  function translationOf (m, mine) {
    const readLang = myReadLang()
    const { mode, langTo } = composeState()
    const want = !mine && (!m.kind || m.kind === 'text') && Boolean(m.text) &&
      Boolean(readLang) && db.profile().autoTranslate &&
      mode === 'translate' && Boolean(langTo)
    if (!want) return null

    if (!trCache.has(m.id)) {
      // Instant path: the sender pre-translated into my language.
      if (m.tr?.lang === readLang && m.tr.text) {
        trCache.set(m.id, { text: m.tr.text, engine: 'instant' })
      } else {
        trCache.set(m.id, 'pending')
        // Detection beats the sender's profile claim (legacy comment).
        translateText(m.text, null, myReadLang())
          .then((res) => { trCache.set(m.id, res) })
          .catch(() => { trCache.set(m.id, { text: null, engine: null }) })
          .then(() => invalidate())
      }
    }

    const cur = trCache.get(m.id)
    if (cur !== 'pending' && cur?.engine === null) return null
    if (cur !== 'pending' && cur?.text && flatten(cur.text) === flatten(m.text)) return null
    const pending = cur === 'pending'
    const from = cur?.detected || (cur?.engine === 'instant' ? m.lang : null)
    return {
      tag: pending ? 'Translating…' : readingTag(from, 'Translated'),
      text: pending ? '…' : cur.text,
      pending
    }
  }

  /* ------------------------------------------------------------ snapshot */
  function composerView () {
    const { mode, langTo } = composeState()
    const trOn = mode === 'translate' && Boolean(langTo)
    const pinned = convo().xlitLang
    return {
      mode,
      translateOn: trOn,
      translitOn: xlitOn(),
      translateLangLabel: langName(langTo || 'en'),
      translitLangLabel: pinned ? langName(pinned) : 'Auto',
      preview
    }
  }

  return {
    composerView,
    draftChanged,
    sendText,
    translationOf,
    toggleTranslate,
    pickTranslateLang,
    toggleTranslit,
    pickTranslitLang
  }
}
