/**
 * Spot Me web — application.
 *
 * Two screens: set up who you are, then the conversation. No framework; the
 * app is small enough that direct DOM work is clearer than a render loop, and
 * it keeps the bundle small.
 */
import { createNet, roomLink, readLink, randomId, selfId } from './net.js'
import { createStore, loadIdentity, saveIdentity } from './store.js'
import { transliterate, supportedScripts } from 'spotme-core/core/translit.js'

const app = document.getElementById('app')

/** Languages offered in setup. Scripts with transliteration are marked. */
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ta', name: 'Tamil' },
  { code: 'hi', name: 'Hindi' }
]
const TRANSLITERABLE = new Set(supportedScripts().map((s) => s.code))
const REACTIONS = ['❤️', '😂', '👍', '😮', '😢']

let identity = loadIdentity()
let store = null
let net = null
let room = null
let replyTo = null
let translitOn = true

/* ------------------------------------------------------------------ utils */

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value !== null && value !== undefined) node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild) }

const time = (ts) => new Date(ts)
  .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function toast (message) {
  const existing = document.querySelector('.toast')
  if (existing) existing.remove()
  const node = el('div', { class: 'toast', text: message })
  document.body.appendChild(node)
  setTimeout(() => node.remove(), 2600)
}

/**
 * Apply transliteration if the user's language has a script and the toggle is
 * on. Deliberately applied at SEND time, not as you type: rewriting the input
 * under the cursor makes correcting a word almost impossible on a phone.
 */
function maybeTransliterate (text) {
  if (!translitOn || !TRANSLITERABLE.has(identity.lang)) return text
  try {
    return transliterate(text, identity.lang)
  } catch {
    return text // never let a conversion failure swallow the message
  }
}

/* ------------------------------------------------------------------ setup */

function renderSetup () {
  clear(app)

  const name = el('input', {
    id: 'name', type: 'text', placeholder: 'Your name',
    maxlength: '32', value: identity?.name || '', autocomplete: 'nickname'
  })

  const langs = el('div', { class: 'langs' }, LANGUAGES.map((language) =>
    el('button', {
      class: 'lang' + ((identity?.lang || 'en') === language.code ? ' on' : ''),
      type: 'button',
      'data-lang': language.code,
      onclick (event) {
        document.querySelectorAll('.lang').forEach((b) => b.classList.remove('on'))
        event.currentTarget.classList.add('on')
      }
    }, [
      el('strong', { text: language.name }),
      TRANSLITERABLE.has(language.code)
        ? el('span', { text: 'type in English, send in script' })
        : el('span', { text: 'no transliteration needed' })
    ])
  ))

  const start = (mode) => {
    const chosen = name.value.trim()
    if (!chosen) { toast('Enter a name first'); name.focus(); return }
    const lang = document.querySelector('.lang.on')?.dataset.lang || 'en'
    identity = { name: chosen, lang }
    saveIdentity(identity)

    if (mode === 'create') {
      room = { roomId: randomId(8), secret: randomId(16) }
      window.location.hash = `r=${room.roomId}&k=${room.secret}`
    }
    openRoom()
  }

  const fromLink = readLink()

  app.appendChild(el('div', { class: 'screen setup' }, [
    el('h1', { text: 'Spot Me' }),
    el('p', { class: 'lede', text: fromLink
      ? 'You have been invited to a room. Tell us who you are.'
      : 'Peer-to-peer chat. No account, no server holding your messages.' }),

    el('label', { for: 'name', text: 'Name' }),
    name,

    el('label', { text: 'You read and write in' }),
    langs,

    fromLink
      ? el('button', { class: 'primary', type: 'button', text: 'Join the room', onclick: () => start('join') })
      : el('button', { class: 'primary', type: 'button', text: 'Start a room', onclick: () => start('create') }),

    el('p', { class: 'fineprint', text:
      'Messages go directly between devices and are encrypted in transit. ' +
      'Because there is no server, a message only arrives if the other person ' +
      'is online at the same time.' })
  ]))

  name.focus()
}

/* ------------------------------------------------------------------- chat */

function openRoom () {
  room = room || readLink()
  if (!room) return renderSetup()

  store = createStore(room.roomId)

  net = createNet(room.roomId, room.secret, {
    profile: () => ({ name: identity.name, lang: identity.lang }),
    onMessage: (payload) => { if (store.add(payload)) notifyIfHidden(payload) },
    onHistory: (messages) => store.mergeHistory(messages),
    onReaction: (payload) => store.addReaction(payload),
    onProfile: (payload, peerId) => store.addProfile(peerId, payload),
    onPeers: (count, peerId, event) => {
      updatePeers(count)
      const who = store.profiles().get(peerId)?.name
      if (event === 'join' && who) toast(`${who} joined`)
    }
  }, () => store.list())

  renderChat()
  store.subscribe(renderMessages)
}

function notifyIfHidden (message) {
  if (document.visibilityState === 'visible') return
  toast(`${message.name}: ${message.text}`)
}

function updatePeers (count) {
  const node = document.querySelector('.peers')
  if (!node) return
  node.textContent = count === 0
    ? 'waiting for someone to join'
    : `${count} ${count === 1 ? 'person' : 'people'} connected`
  node.classList.toggle('alone', count === 0)
}

function renderChat () {
  clear(app)

  const list = el('div', { class: 'messages', id: 'messages' })
  const input = el('input', {
    id: 'draft', type: 'text', placeholder: 'Message',
    autocomplete: 'off', autocapitalize: 'sentences'
  })
  const preview = el('div', { class: 'preview', id: 'preview' })

  const send = () => {
    const raw = input.value.trim()
    if (!raw) return
    const message = {
      id: randomId(8),
      from: selfId,
      name: identity.name,
      text: maybeTransliterate(raw),
      lang: identity.lang,
      ts: Date.now(),
      replyTo: replyTo?.id || null
    }
    input.value = ''
    preview.textContent = ''
    setReply(null)
    store.add(message)
    net.sendMessage(message)
  }

  input.addEventListener('input', () => {
    const raw = input.value.trim()
    const converted = maybeTransliterate(raw)
    preview.textContent = converted !== raw ? converted : ''
  })
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') send() })

  app.appendChild(el('div', { class: 'screen chat' }, [
    el('header', {}, [
      el('div', {}, [
        el('strong', { text: 'Room' }),
        el('div', { class: 'peers alone', text: 'waiting for someone to join' })
      ]),
      el('div', { class: 'actions' }, [
        el('button', { class: 'link', type: 'button', text: 'Invite', onclick: shareLink }),
        TRANSLITERABLE.has(identity.lang)
          ? el('button', {
            class: 'link toggle on', type: 'button', text: 'Aa',
            title: 'Transliteration on',
            onclick (event) {
              translitOn = !translitOn
              event.currentTarget.classList.toggle('on', translitOn)
              event.currentTarget.title = translitOn ? 'Transliteration on' : 'Transliteration off'
              toast(translitOn ? 'Transliteration on' : 'Transliteration off')
            }
          })
          : null
      ])
    ]),
    list,
    el('div', { class: 'composer-wrap' }, [
      el('div', { class: 'reply-bar', id: 'reply-bar' }),
      preview,
      el('div', { class: 'composer' }, [
        input,
        el('button', { class: 'send', type: 'button', text: 'Send', onclick: send })
      ])
    ])
  ]))

  renderMessages()
}

function setReply (message) {
  replyTo = message
  const bar = document.getElementById('reply-bar')
  if (!bar) return
  clear(bar)
  bar.classList.toggle('on', Boolean(message))
  if (!message) return
  bar.appendChild(el('span', { text: `Replying to ${message.name}: ${message.text.slice(0, 40)}` }))
  bar.appendChild(el('button', { class: 'link', type: 'button', text: 'Cancel', onclick: () => setReply(null) }))
}

function renderMessages () {
  const list = document.getElementById('messages')
  if (!list) return

  // Only stick to the bottom if the reader is already there — yanking the view
  // down while someone reads back through history is infuriating.
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const messages = store.list()
  clear(list)

  if (messages.length === 0) {
    list.appendChild(el('p', { class: 'empty', text:
      'No messages yet. Tap Invite and send the link to the other phone.' }))
    return
  }

  const byId = new Map(messages.map((m) => [m.id, m]))

  for (const message of messages) {
    const mine = message.from === selfId
    const parent = message.replyTo ? byId.get(message.replyTo) : null

    const bubble = el('div', { class: 'bubble' + (mine ? ' mine' : '') }, [
      mine ? null : el('div', { class: 'who', text: message.name }),
      parent ? el('div', { class: 'quote', text: `${parent.name}: ${parent.text.slice(0, 60)}` }) : null,
      el('div', { class: 'text', text: message.text }),
      el('div', { class: 'meta', text: time(message.ts) }),
      message.reactions.length
        ? el('div', { class: 'reactions', text: message.reactions.map((r) => r.emoji).join(' ') })
        : null
    ])

    // Long-press to react, tap to reply. Matches what people already do in
    // WhatsApp and Telegram, so it needs no explaining.
    let timer = null
    const startPress = () => { timer = setTimeout(() => showReactions(message), 420) }
    const endPress = () => { if (timer) clearTimeout(timer); timer = null }
    bubble.addEventListener('touchstart', startPress, { passive: true })
    bubble.addEventListener('touchend', endPress)
    bubble.addEventListener('touchmove', endPress, { passive: true })
    bubble.addEventListener('dblclick', () => showReactions(message))
    bubble.addEventListener('click', () => setReply(message))

    list.appendChild(bubble)
  }

  if (atBottom) list.scrollTop = list.scrollHeight
}

function showReactions (message) {
  const existing = document.querySelector('.reaction-picker')
  if (existing) existing.remove()

  const picker = el('div', { class: 'reaction-picker' }, REACTIONS.map((emoji) =>
    el('button', {
      type: 'button', text: emoji,
      onclick () {
        const payload = { target: message.id, emoji, from: selfId }
        store.addReaction(payload)
        net.sendReaction(payload)
        picker.remove()
      }
    })
  ))

  document.body.appendChild(picker)
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 0)
}

async function shareLink () {
  const link = roomLink(room.roomId, room.secret)
  // The native share sheet beats a clipboard toast on a phone — it puts the
  // link straight into WhatsApp, Messages or AirDrop.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Spot Me', text: 'Join my room', url: link })
      return
    } catch {
      // User dismissed the sheet; fall through to copying.
    }
  }
  try {
    await navigator.clipboard.writeText(link)
    toast('Invite link copied')
  } catch {
    prompt('Copy this link:', link)
  }
}

/* ------------------------------------------------------------------- boot */

const invited = readLink()
if (identity && invited) {
  room = invited
  openRoom()
} else {
  renderSetup()
}
