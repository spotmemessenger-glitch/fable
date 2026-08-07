/**
 * Spot Me — Contacts. People you have accepted, alphabetical, with live
 * presence dots and one-tap reconnection. Same design grammar as the inbox
 * (design/01-messages.html): header bar, big title, search well, rows whose
 * dividers start at 78px.
 */
import './contacts.css'
import { db, randomHex } from '../lib/db.js'
import { lobby } from '../lib/discovery.js'
import { reach } from '../lib/reach.js'
import { rooms } from '../lib/rooms.js'
/** Demo accounts are gone from the product; old stored ones stay filtered out. */
const isDemo = (id) => typeof id === 'string' && id.startsWith('demo-')
import { langName } from '../lib/translate.js'
import { el, clear, avatar, actionSheet } from '../lib/ui.js'

const LONG_PRESS_MS = 550
const STAGGER_MS = 32
const STAGGER_CAP = 12

const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4-4" stroke-linecap="round"/></svg>'
const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 13.4a4.2 4.2 0 006 .4l2.5-2.5a4.2 4.2 0 00-6-6L11.7 6.7"/><path d="M13.4 10.6a4.2 4.2 0 00-6-.4l-2.5 2.5a4.2 4.2 0 006 6l1.4-1.4"/></svg>'

const roomLink = (roomId, secret) =>
  `${location.origin}${location.pathname}#r=${roomId}&k=${secret}`

/** navigator.share when available, clipboard otherwise. Never throws. */
async function shareLink (url, toast) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Spot Me', text: 'Chat with me on Spot Me', url })
      return
    } catch (err) {
      if (err && err.name === 'AbortError') return
      /* share unavailable mid-flight — fall through to clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    toast('Invite link copied')
  } catch {
    toast('Could not share the link')
  }
}

export function render (root, ctx) {
  const pressTimers = new Set()

  /* ------------------------------------------------------------- actions */

  function openContact (contact) {
    const existing = db.convos().find((c) =>
      (c.kind === 'dm' || c.kind === 'demo') && c.peer?.id === contact.id)
    if (existing) { ctx.openThread(existing.roomId); return }

    if (isDemo(contact.id)) {
      try {
        const roomId = 'demo-' + randomHex(6)
        db.upsertConvo({
          roomId,
          secret: 'x',
          kind: 'demo',
          mode: 'meet',
          peer: { id: contact.id, name: contact.name, avatar: contact.avatar || null, lang: contact.lang || 'en' },
          title: contact.name
        })
        rooms.ensure(roomId)
        ctx.openThread(roomId)
      } catch { ctx.toast('Could not open that chat') }
      return
    }

    const live = lobby.peers().find((p) => p.id === contact.id)
    if (live) {
      actionSheet([{
        label: 'Send chat request',
        fn () {
          try {
            const roomId = reach.reach(live, 'Hi again!', 'meet')
            ctx.openThread(roomId)
          } catch { ctx.toast('Could not send the request') }
        }
      }], contact.name)
      return
    }

    ctx.toast('They are offline right now — request them from Discovery when they are online.')
  }

  function contactMenu (contact) {
    actionSheet([
      {
        label: 'Block',
        danger: true,
        fn () { db.block(contact.id, contact.name); ctx.toast(`${contact.name} blocked`) }
      },
      {
        label: 'Remove contact',
        danger: true,
        fn () { db.removeContact(contact.id); ctx.toast('Contact removed') }
      }
    ], contact.name)
  }

  async function inviteFriend () {
    try {
      const roomId = randomHex(8)
      const secret = randomHex(16)
      db.upsertConvo({
        roomId,
        secret,
        kind: 'dm',
        mode: 'meet',
        peer: { id: null, name: 'Invited chat', avatar: null, lang: 'en' },
        title: 'Invited chat',
        last: { text: 'Invite link created', ts: Date.now(), fromMe: true }
      })
      rooms.ensure(roomId)
      await shareLink(roomLink(roomId, secret), ctx.toast)
      ctx.openThread(roomId)
    } catch { ctx.toast('Could not create the invite') }
  }

  /** Tap opens, long-press (or right-click) opens the manage menu. */
  function attachPress (node, onTap, onHold) {
    let timer = null
    let held = false
    const cancel = () => {
      if (timer) { clearTimeout(timer); pressTimers.delete(timer); timer = null }
    }
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return
      held = false
      cancel()
      timer = setTimeout(() => { pressTimers.delete(timer); timer = null; held = true; onHold() }, LONG_PRESS_MS)
      pressTimers.add(timer)
    })
    node.addEventListener('pointerup', cancel)
    node.addEventListener('pointerleave', cancel)
    node.addEventListener('pointercancel', cancel)
    node.addEventListener('click', () => {
      if (held) { held = false; return }
      onTap()
    })
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      cancel()
      if (!held) { held = true; onHold() }
    })
  }

  /* ------------------------------------------------------------ skeleton */

  const search = el('input', { type: 'text', placeholder: 'Search contacts...', autocomplete: 'off' })
  const listEl = el('div', { class: 'list' })

  const wrap = el('div', { class: 'v-contacts' }, [
    el('div', { class: 'bar' }, [
      el('span', { class: 'sp' }),
      avatar(db.profile() || {}, 34)
    ]),
    el('h1', { class: 'h1', text: 'Contacts' }),
    el('div', { class: 'search', html: ICON_SEARCH }, [search]),
    el('div', { class: 'scroll-y' }, [
      el('button', { class: 'invite', type: 'button', onclick: inviteFriend }, [
        el('span', { class: 'ic', html: ICON_LINK }),
        el('span', { class: 'tx' }, [
          el('b', { text: 'Invite a friend by link' }),
          el('span', { class: 'sub', text: 'A private room only the two of you can open' })
        ])
      ]),
      listEl
    ])
  ])

  /* ---------------------------------------------------------------- draw */

  function draw () {
    const q = search.value.trim().toLowerCase()
    const online = new Set(lobby.peers().map((p) => p.id))
    const contacts = db.contacts()
      .filter((c) => !db.isBlocked(c.id))
      .filter((c) => !q ||
        c.name.toLowerCase().includes(q) ||
        langName(c.lang || '').toLowerCase().includes(q))

    clear(listEl)

    if (!contacts.length) {
      const bits = [el('p', {
        text: q ? 'No one matches your search.' : 'People you accept appear here.'
      })]
      if (!q) {
        bits.push(el('button', {
          class: 'pill ok',
          type: 'button',
          text: 'Open Discovery',
          onclick: () => ctx.nav('#/discovery')
        }))
      }
      listEl.appendChild(el('div', { class: 'empty' }, bits))
      return
    }

    contacts.filter((c) => !isDemo(c.id)).forEach((contact, i) => {
      const isOn = online.has(contact.id)
      const chips = [el('span', { class: 'chip', text: langName(contact.lang || 'en') })]

      const row = el('div', {
        class: 'row',
        style: `animation-delay:${Math.min(i, STAGGER_CAP) * STAGGER_MS}ms`
      }, [
        avatar(contact, 52, { dot: isOn }),
        el('div', { class: 'mid' }, [
          el('div', { class: 'l1' }, [
            el('span', { class: 'nm', text: contact.name }),
            ...chips
          ])
        ])
      ])
      attachPress(row, () => openContact(contact), () => contactMenu(contact))
      listEl.appendChild(row)
    })
  }

  /* ---------------------------------------------------------------- wire */

  const unsubDb = db.subscribe(draw)
  const unsubLobby = lobby.subscribe(draw)
  search.addEventListener('input', draw)

  root.appendChild(wrap)
  draw()

  return () => {
    unsubDb()
    unsubLobby()
    for (const timer of pressTimers) clearTimeout(timer)
    pressTimers.clear()
  }
}
