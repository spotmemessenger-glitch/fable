/**
 * React chat island — the apps/web ADAPTER for @spotme/ui's ChatShell.
 *
 * REUSES THE ENGINE, NEVER REBUILDS IT: every message goes through
 * lib/rooms.js exactly as the legacy view sends it, so a React device and a
 * legacy device speak the same protocol. The engine port wraps the nine calls
 * the mission names — ensure, get, connectAll, injectLocal, sendMessage,
 * sendAttachment, retryMessage, retryAttachment, identityStatus — and nothing
 * else. Translation reuses lib/translate.js; transliteration imports
 * spotme-core/core/translit.js (never reimplemented); styling is the locked
 * chat.css, shared with the legacy tree byte for byte.
 *
 * Mounted from main.js ONLY when localStorage 'spotme.ui.chat' === 'on'
 * (DEFAULT OFF) — the gate runs before this module is even downloaded.
 */
import '../../views/chat.css'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { rooms } from '../../lib/rooms.js'
import { identityStatus } from '../../lib/crypto/identity-store.js'
import { db } from '../../lib/db.js'
import { translateText, transliterateRemote, langName } from '../../lib/translate.js'
import { transliterate } from 'spotme-core/core/translit.js'
import { isPlainEnglish } from '../../lib/english.js'
import { ChatShell } from '@spotme/ui/chat/ChatShell'
import { ChatController } from '@spotme/ui/chat/controller'

/** '文A Tamil · Transliterated' — same spelling as the legacy translitTag. */
const hintTag = (lang) => {
  const base = String(lang || '').split('-')[0]
  const name = base && base !== 'en' ? langName(base) : null
  return name && name !== base ? `文A ${name} · Transliterated` : '文A Transliterated'
}

/** Wrap an engine connection as the read surface the controller expects. */
const wrapConn = (conn) => conn && {
  on: (cb) => conn.on(cb),
  list: () => conn.store.list(),
  readUpTo: () => conn.readUpTo,
  peerCount: () => conn.peerCount || 0,
  typing: () => conn.typing || null
}

/** THE nine wrapped calls — the entire engine surface the React tree sees. */
const engine = {
  ensure: (roomId) => wrapConn(rooms.ensure(roomId)),
  get: (roomId) => wrapConn(rooms.get(roomId)),
  connectAll: () => rooms.connectAll(),
  injectLocal: (roomId, m) => rooms.injectLocal(roomId, m),
  sendMessage: (roomId, partial) => rooms.sendMessage(roomId, partial),
  sendAttachment: (roomId, partial, onProgress) => rooms.sendAttachment(roomId, partial, onProgress),
  retryMessage: (roomId, id) => rooms.retryMessage(roomId, id),
  retryAttachment: (roomId, id, onProgress) => rooms.retryAttachment(roomId, id, onProgress),
  identityStatus: () => identityStatus()
}

/** Composer transliteration hint — the same staged idea as runTranslit:
 *  plain English answers deterministically, the on-device engine answers on
 *  the same frame, the remote transliterator upgrades it when it knows more.
 *  Leftover ASCII invalidates a local guess (the "Netflix and chill" rule). */
function makeTranslitPort (roomId) {
  const target = () => {
    const c = db.convo(roomId)
    return c?.xlitLang || c?.translitLang || c?.myLang || null
  }
  return {
    hint (raw) {
      if (isPlainEnglish(raw)) return { tag: '文A Already English', text: raw }
      const lang = target()
      if (!lang || lang === 'en') return { tag: '文A Reading…', text: raw }
      let local = null
      try { local = transliterate(raw, lang) } catch { local = null }
      const text = local?.text && !/[a-z]/i.test(local.text) ? local.text : raw
      return { tag: hintTag(lang), text }
    },
    async hintRemote (raw) {
      if (isPlainEnglish(raw)) return null
      const lang = target()
      if (!lang || lang === 'en') return null
      const native = await transliterateRemote(raw, lang).catch(() => null)
      if (!native || native === raw) return null
      return { tag: hintTag(lang), text: native }
    }
  }
}

/**
 * Mount the React chat for one room. Returns the cleanup main.js expects —
 * same contract as chat.render(root, ctx, roomId).
 */
export function mount (root, ctx, roomId) {
  const convo = db.convo(roomId)
  if (!convo) {
    ctx.toast('Conversation not found')
    ctx.nav('#/chat')
    return () => {}
  }
  const profile = db.profile()
  const readLang = (convo.myLang && convo.myLang !== convo.langTo ? convo.myLang : profile.lang) || null
  const translateWanted = Boolean(profile.autoTranslate && convo.composeMode === 'translate' && convo.langTo)

  const controller = new ChatController({
    engine,
    roomId,
    selfId: profile.id,
    clock: { now: () => Date.now() },
    translate: { translate: (text, from, to) => translateText(text, from, to) },
    translit: makeTranslitPort(roomId),
    readLang,
    translateWanted
  })

  const reactRoot = createRoot(root)
  reactRoot.render(createElement(ChatShell, {
    controller,
    header: { name: convo.title || convo.peer?.name || 'Chat', isGroup: convo.kind === 'group' },
    onBack: () => ctx.nav('#/chat')
  }))
  return () => reactRoot.unmount()
}
