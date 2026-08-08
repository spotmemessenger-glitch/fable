/**
 * Chat language composer through the React port (ADR-035 session 3).
 *
 * Pins that the React path drives the SAME translate/translit entry points
 * with the SAME arguments as the legacy composer (views/chat.js), and ships
 * the SAME envelope shapes — the engines are injected fakes, so every call is
 * recorded verbatim:
 *
 *   1. translate mode sends the translated hero line with the ORIGINAL riding
 *      as `tr: { lang, text }` (the characterization-pinned envelope), via
 *      translateText(raw, null, langTo);
 *   2. a settled preview is REUSED at send time — no second engine call;
 *   3. every engine down → the plain draft goes out (nothing half-translated);
 *   4. translit mode never rewrites the outgoing text (reading aid), and the
 *      preview converts locally via transliterate(raw, target);
 *   5. plain English is settled deterministically — zero engine calls;
 *   6. incoming rows translate via translateText(m.text, null, readLang),
 *      with the sender-shipped `tr` as the zero-call instant path, and an
 *      all-engines-down result suppresses the line;
 *   7. the header toggles persist the SAME convo keys the legacy header
 *      writes (composeMode/langTo/xlit/xlitLang), including the
 *      "turning the globe off hands the composer back to 文A" rule.
 *
 *   node --test test/chat-lang-react.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLangComposer } from '../src/views/chat-island-lang.js'

const ROOM = 'r1'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeDb (convoOver = {}, profileOver = {}) {
  const convos = { [ROOM]: { roomId: ROOM, ...convoOver } }
  return {
    convo: (id) => convos[id] || null,
    convos: () => Object.values(convos),
    upsertConvo (patch) { convos[patch.roomId] = { ...convos[patch.roomId], ...patch } },
    profile: () => ({ id: 'me', lang: 'en', autoTranslate: true, translit: false, ...profileOver })
  }
}

function makeLang (over = {}) {
  const calls = []
  return {
    calls,
    translateText: (...a) => { calls.push(['translateText', ...a]); return Promise.resolve({ text: null, engine: null }) },
    transliterateRemote: (...a) => { calls.push(['transliterateRemote', ...a]); return Promise.resolve(null) },
    detectLanguage: (...a) => { calls.push(['detectLanguage', ...a]); return Promise.resolve(null) },
    langName: (code) => ({ en: 'English', ta: 'Tamil', hi: 'Hindi' })[code] || code,
    transliterate: (...a) => { calls.push(['transliterate', ...a]); return null },
    supportedScripts: () => [{ code: 'ta' }, { code: 'hi' }],
    isPlainEnglish: () => false,
    actionSheet: (...a) => { calls.push(['actionSheet', ...a]) },
    ...over
  }
}

const noopCtx = { toast () {} }
const build = (db, lang) => buildLangComposer({ db, lang }, noopCtx, ROOM, () => {})

test('translate mode: same entry point, same args, same tr envelope as legacy', async () => {
  const db = makeDb({ composeMode: 'translate', langTo: 'ta' })
  const lang = makeLang({
    translateText: (...a) => {
      lang.calls.push(['translateText', ...a])
      return Promise.resolve({ text: 'வணக்கம்', engine: 'azure', detected: 'en' })
    }
  })
  const composer = build(db, lang)

  const sent = []
  composer.sendText('hello', (partial) => sent.push(partial))
  await wait(20)

  // Legacy sendText: translateText(raw, null, langTo) — detection, not claim.
  assert.deepEqual(lang.calls[0], ['translateText', 'hello', null, 'ta'])
  // Legacy envelope: translated hero + lang + tr carrying the ORIGINAL.
  assert.deepEqual(sent, [{ text: 'வணக்கம்', lang: 'ta', tr: { lang: 'en', text: 'hello' } }])
})

test('a settled preview is reused at send — one engine call total', async () => {
  const db = makeDb({ composeMode: 'translate', langTo: 'ta' })
  let hits = 0
  const lang = makeLang({
    translateText (raw, from, to) {
      hits++
      assert.deepEqual([raw, from, to], ['hello', null, 'ta'])
      return Promise.resolve({ text: 'வணக்கம்', engine: 'azure', detected: 'en-Latn' })
    }
  })
  const composer = build(db, lang)

  composer.draftChanged('hello')
  await wait(400)   // > the 320ms legacy debounce
  const view = composer.composerView()
  assert.equal(view.preview.main, 'வணக்கம்')
  assert.equal(view.preview.tag, '文A Translation · Tamil')

  const sent = []
  composer.sendText('hello', (partial) => sent.push(partial))
  assert.equal(hits, 1, 'send reuses the settled preview')
  assert.deepEqual(sent, [{ text: 'வணக்கம்', lang: 'ta', tr: { lang: 'en', text: 'hello' } }])
})

test('every engine down: the plain draft goes out — nothing half-translated', async () => {
  const db = makeDb({ composeMode: 'translate', langTo: 'ta' })
  const composer = build(db, makeLang())   // translateText → { text: null, engine: null }
  const sent = []
  composer.sendText('hello', (partial) => sent.push(partial))
  await wait(20)
  assert.deepEqual(sent, [{ text: 'hello' }])
})

test('translit mode never rewrites the outgoing text; preview converts locally', async () => {
  const db = makeDb({ composeMode: 'translit', xlit: true, xlitLang: 'ta' })
  const lang = makeLang({
    transliterate: (raw, target) => {
      lang.calls.push(['transliterate', raw, target])
      return 'வணக்கம்'
    }
  })
  const composer = build(db, lang)

  composer.draftChanged('vanakkam')
  // Instant, same frame — the on-device engine, same args as legacy convertDraft.
  assert.deepEqual(lang.calls[0], ['transliterate', 'vanakkam', 'ta'])
  const view = composer.composerView()
  assert.equal(view.preview.main, 'வணக்கம்')
  assert.equal(view.preview.tag, '文A Tamil · Transliterated')

  const sent = []
  composer.sendText('vanakkam', (partial) => sent.push(partial))
  assert.deepEqual(sent, [{ text: 'vanakkam' }], 'transliteration is a reading aid — raw text sends')
})

test('plain English settles deterministically — zero engine calls', () => {
  const db = makeDb({ composeMode: 'translit', xlit: true })
  const lang = makeLang({ isPlainEnglish: () => true })
  const composer = build(db, lang)
  composer.draftChanged('ok see you')
  assert.deepEqual(composer.composerView().preview,
    { tag: '文A Already English', main: 'ok see you', sub: '' })
  assert.equal(lang.calls.length, 0)
})

test('incoming rows: translateText(m.text, null, readLang); tr is the instant path', async () => {
  const db = makeDb({ composeMode: 'translate', langTo: 'ta' })
  const lang = makeLang({
    translateText: (...a) => {
      lang.calls.push(['translateText', ...a])
      return Promise.resolve({ text: 'where are you', engine: 'azure', detected: 'ta' })
    }
  })
  const composer = build(db, lang)

  // Instant path: sender shipped tr in my language — no engine call at all.
  const instant = composer.translationOf(
    { id: 'm1', text: 'எங்கே இருக்கிறாய்', lang: 'ta', tr: { lang: 'en', text: 'where are you' } }, false)
  assert.deepEqual(instant, { tag: 'Tamil · Translated', text: 'where are you', pending: false })
  assert.equal(lang.calls.length, 0)

  // Network path: the same call shape the legacy applyTranslation makes.
  const pendingLine = composer.translationOf({ id: 'm2', text: 'எப்படி இருக்க' }, false)
  assert.deepEqual(pendingLine, { tag: 'Translating…', text: '…', pending: true })
  assert.deepEqual(lang.calls[0], ['translateText', 'எப்படி இருக்க', null, 'en'])
  await wait(20)
  const settled = composer.translationOf({ id: 'm2', text: 'எப்படி இருக்க' }, false)
  assert.deepEqual(settled, { tag: 'Tamil · Translated', text: 'where are you', pending: false })

  // Mine, or globe off, never translates (legacy want-condition).
  assert.equal(composer.translationOf({ id: 'm3', text: 'hi' }, true), null)
})

test('all engines down suppresses the incoming line (never an empty block)', async () => {
  const db = makeDb({ composeMode: 'translate', langTo: 'ta' })
  const composer = build(db, makeLang())   // engine: null
  composer.translationOf({ id: 'm1', text: 'எங்கே' }, false)
  await wait(20)
  assert.equal(composer.translationOf({ id: 'm1', text: 'எங்கே' }, false), null)
})

test('toggles persist the same convo keys the legacy header writes', () => {
  const db = makeDb({})
  const composer = build(db, makeLang())

  composer.toggleTranslate()
  assert.equal(db.convo(ROOM).composeMode, 'translate')
  assert.equal(db.convo(ROOM).langTo, 'en')

  composer.toggleTranslit()
  // Translation owns the composer when both are on (legacy rule).
  assert.equal(db.convo(ROOM).composeMode, 'translate')
  assert.equal(db.convo(ROOM).xlit, true)

  composer.toggleTranslate()
  // Turning the globe off hands the composer back to 文A, not to nothing.
  assert.equal(db.convo(ROOM).composeMode, 'translit')
  assert.equal(db.convo(ROOM).langTo, null)

  const view = composer.composerView()
  assert.equal(view.translateOn, false)
  assert.equal(view.translitOn, true)
  assert.equal(view.translitLangLabel, 'Auto')
})
