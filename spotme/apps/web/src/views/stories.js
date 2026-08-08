/**
 * Spot Me — Stories (#/stories). Owns the story rings that used to sit on
 * Home: the bar slot the Home button vacated leads here instead. Rings are
 * built from contacts; posting is honest about needing the native app.
 *
 * The chat list is the app's landing screen and no longer has a bar button,
 * so this screen carries the way back to it.
 */
import './stories.css'
import { db } from '../lib/db.js'
import { el, clear, avatar } from '../lib/ui.js'
import { uiFlag } from '../lib/island.js'
import { storiesIsland } from '../lib/island-adapters.js'

const INK_RINGS = 2            // first two tiles carry the ink ring (design)

const ICON = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4L3 21l1.1-8.5A8.4 8.4 0 1121 11.5z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A1.5 1.5 0 014.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0121 8.5v9A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5z"/><circle cx="12" cy="13" r="3.4"/></svg>'
}

export function render (root, ctx) {
  if (uiFlag('stories')) return storiesIsland(root, ctx) // ADR-035 slice 2, default OFF

  root.classList.add('v-stories')

  const meBtn = el('button', {
    class: 'me', type: 'button', 'aria-label': 'My profile',
    onclick: () => ctx.nav('#/settings')
  })

  root.appendChild(el('div', { class: 'bar' }, [
    meBtn,
    el('span', { class: 'sp' }),
    el('span', { class: 'wm', text: 'Spot Me' }),
    el('span', { class: 'sp' }),
    el('button', {
      class: 'toChats', type: 'button', 'aria-label': 'Chats',
      html: ICON.chat, onclick: () => ctx.nav('#/chat')
    })
  ]))

  const bodyEl = el('div', { class: 'scroll-y sbody' })
  root.appendChild(bodyEl)

  function openPersonChat (person) {
    const convo = db.convos().find((c) => c.peer?.id === person.id)
    if (convo) ctx.openThread(convo.roomId)
    else ctx.toast(`No chat with ${person.name} yet — find them in Discovery`)
  }

  function draw () {
    clear(meBtn)
    meBtn.appendChild(avatar(db.profile(), 34))
    clear(bodyEl)

    const contacts = db.contacts()

    bodyEl.appendChild(el('button', {
      class: 'myst', type: 'button',
      onclick: () => ctx.toast('Posting a story arrives with the native app')
    }, [
      el('span', { class: 'stRing add' }, [
        el('span', { class: 'stIn' }, [avatar(db.profile(), 54)]),
        el('span', { class: 'plusDot', html: ICON.add })
      ]),
      el('span', { class: 'mw' }, [
        el('b', { text: 'My story' }),
        el('span', { text: 'Share a photo or video for 24 hours' })
      ]),
      el('span', { class: 'cam', html: ICON.camera })
    ]))

    if (!contacts.length) {
      bodyEl.appendChild(el('div', { class: 'sempty' }, [
        el('b', { text: 'No stories yet' }),
        el('span', { text: 'People you chat with show up here — their rings light up when they post.' })
      ]))
      return
    }

    bodyEl.appendChild(el('div', { class: 'shead', text: 'Recent' }))
    const grid = el('div', { class: 'sgrid' })
    contacts.forEach((person, i) => {
      grid.appendChild(el('button', {
        class: 'st', type: 'button', 'data-seen': i < INK_RINGS ? '0' : '1',
        onclick: () => openPersonChat(person)
      }, [
        el('span', { class: 'stRing' }, [
          el('span', { class: 'stIn' }, [avatar(person, 62)])
        ]),
        el('span', { class: 'stN', text: person.name })
      ]))
    })
    bodyEl.appendChild(grid)

    bodyEl.appendChild(el('p', {
      class: 'snote',
      text: 'Stories are a native-app feature: posting needs background upload and 24-hour expiry that a web tab cannot hold. Tapping someone opens your chat with them.'
    }))
  }

  const unsub = db.subscribe(draw)
  draw()

  return function cleanup () {
    unsub()
    root.classList.remove('v-stories')
  }
}
