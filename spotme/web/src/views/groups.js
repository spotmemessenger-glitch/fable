/**
 * Spot Me — Groups. A group is a shared P2P room: everyone with the link is
 * in, no admin, no server. Same design grammar as the inbox
 * (design/01-messages.html): header bar, big title, search well, rows with
 * 78px-indented dividers and blue unread state.
 */
import './groups.css'
import { db, randomHex } from '../lib/db.js'
import { lobby } from '../lib/discovery.js'
import { rooms } from '../lib/rooms.js'
import { el, clear, avatar, actionSheet, fmtDay } from '../lib/ui.js'

const STAGGER_MS = 32
const STAGGER_CAP = 12
const NAME_MAX = 40
const EXPLAINER = 'A group is a shared room. Everyone with the link is in — no admin, no server.'

const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4-4" stroke-linecap="round"/></svg>'
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>'

const groupLink = (convo) =>
  `${location.origin}${location.pathname}#r=${convo.roomId}&k=${convo.secret}` +
  `&g=${encodeURIComponent(convo.title || 'Group')}`

/** navigator.share when available, clipboard otherwise. Never throws. */
async function shareLink (url, toast) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Spot Me', text: 'Join our group on Spot Me', url })
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
  let sheetEl = null

  /* ------------------------------------------------------------- actions */

  function groupMenu (convo) {
    actionSheet([
      { label: 'Share invite link', fn: () => shareLink(groupLink(convo), ctx.toast) },
      {
        label: 'Archive',
        fn () { db.setArchived(convo.roomId, true); ctx.toast('Group archived') }
      },
      {
        label: 'Leave group',
        danger: true,
        fn () {
          try { rooms.leave(convo.roomId) } catch { /* room may never have connected */ }
          db.removeConvo(convo.roomId)
          ctx.toast('You left the group')
        }
      }
    ], convo.title || 'Group')
  }

  function openNewGroup () {
    if (sheetEl) return
    const input = el('input', {
      class: 'ng-input',
      type: 'text',
      maxlength: String(NAME_MAX),
      placeholder: 'Group name',
      autocomplete: 'off'
    })
    const backdrop = el('div', { class: 'as-backdrop' })

    const close = () => {
      sheetEl = null
      backdrop.classList.add('closing')
      setTimeout(() => backdrop.remove(), 160)
    }

    const create = () => {
      const name = input.value.trim()
      if (!name) { ctx.toast('Give the group a name first'); input.focus(); return }
      try {
        const roomId = randomHex(8)
        const secret = randomHex(16)
        db.upsertConvo({
          roomId,
          secret,
          kind: 'group',
          mode: 'meet',
          title: name,
          peer: { id: null, name, avatar: null, lang: 'en' }
        })
        rooms.ensure(roomId)
        close()
        ctx.openThread(roomId)
      } catch { ctx.toast('Could not create the group') }
    }

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create() })
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
    backdrop.appendChild(el('div', { class: 'as-sheet ng' }, [
      el('div', { class: 'ng-title', text: 'New group' }),
      el('p', { class: 'ng-hint', text: EXPLAINER }),
      input,
      el('button', { class: 'pill ok ng-create', type: 'button', text: 'Create', onclick: create }),
      el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: () => close() })
    ]))
    wrap.appendChild(backdrop)
    sheetEl = backdrop
    input.focus()
  }

  /* ------------------------------------------------------------ skeleton */

  const search = el('input', { type: 'text', placeholder: 'Search groups...', autocomplete: 'off' })
  const listEl = el('div', { class: 'list' })

  const wrap = el('div', { class: 'v-groups' }, [
    el('div', { class: 'bar' }, [
      el('span', { class: 'sp' }),
      el('button', { class: 'pill ok', type: 'button', text: 'New group', onclick: openNewGroup })
    ]),
    el('h1', { class: 'h1', text: 'Groups' }),
    el('div', { class: 'search', html: ICON_SEARCH }, [search]),
    el('div', { class: 'scroll-y' }, [listEl])
  ])

  /* ---------------------------------------------------------------- draw */

  function draw () {
    const q = search.value.trim().toLowerCase()
    const groups = db.convos()
      .filter((c) => c.kind === 'group' && !c.archived)
      .filter((c) => !q || (c.title || '').toLowerCase().includes(q))

    clear(listEl)

    if (!groups.length) {
      const bits = [el('p', { text: q ? 'No group matches your search.' : EXPLAINER })]
      if (!q) {
        bits.push(el('button', {
          class: 'pill ok',
          type: 'button',
          text: 'New group',
          onclick: openNewGroup
        }))
      }
      listEl.appendChild(el('div', { class: 'empty' }, bits))
      return
    }

    groups.forEach((convo, i) => {
      const title = convo.title || 'Group'
      const unread = convo.unread || 0
      const preview = convo.last
        ? `${convo.last.fromMe ? 'You: ' : ''}${convo.last.text}`
        : 'Shared P2P room'

      listEl.appendChild(el('div', {
        class: 'row' + (unread ? ' unread' : ''),
        style: `animation-delay:${Math.min(i, STAGGER_CAP) * STAGGER_MS}ms`,
        onclick: () => ctx.openThread(convo.roomId)
      }, [
        avatar({ name: title }, 52),
        el('div', { class: 'mid' }, [
          el('div', { class: 'l1' }, [
            el('span', { class: 'nm', text: title }),
            convo.last ? el('span', { class: 'tm', text: fmtDay(convo.last.ts) }) : null
          ]),
          el('div', { class: 'l2' }, [
            el('span', { class: 'pv', text: preview }),
            unread ? el('span', { class: 'bdg', text: unread > 99 ? '99+' : String(unread) }) : null
          ])
        ]),
        el('button', {
          class: 'more',
          type: 'button',
          'aria-label': 'Group options',
          html: ICON_MORE,
          onclick (e) { e.stopPropagation(); groupMenu(convo) }
        })
      ]))
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
    if (sheetEl) { sheetEl.remove(); sheetEl = null }
  }
}
