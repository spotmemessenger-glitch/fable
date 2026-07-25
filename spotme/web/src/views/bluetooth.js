/**
 * Spot Me — Bluetooth screen (#/bluetooth). Radar-scope rebuild.
 *
 * The scope + scan flow finds SPOT ME PEOPLE via the internet lobby — that is
 * what makes Bluetooth chat actually work today. One tap runs an 8-second
 * sweep that reveals everyone currently in the discovery lobby, nearest
 * first, staggered radar-style as glowing blips on the scope and rows in the
 * list. Tapping a person routes through the normal request → accept gate with
 * mode 'bluetooth', so the receiver sees it in Requests with the Bluetooth
 * chip and the chat files under the Bluetooth inbox tab.
 *
 * Where Web Bluetooth exists, a ghost button additionally opens the browser's
 * real device chooser; picked devices are listed informationally only (name +
 * 'device' chip, no chat). Where it is blocked (iPhone) the screen says so.
 * The footnote is honest: this scan uses the internet — true offline
 * Bluetooth chat arrives with the native app.
 */
import './bluetooth.css'
import { db } from '../lib/db.js'
import { lobby, distanceM, fmtDistance } from '../lib/discovery.js'
import { el, clear, avatar, actionSheet } from '../lib/ui.js'

const SCAN_MS = 8000               // one sweep window
const REVEAL_START_MS = 500        // first blip lands after the sweep visibly starts
const REVEAL_SPREAD_MS = 6000      // reveals spread across this much of the window
const REVEAL_MIN_STEP_MS = 260
const REVEAL_MAX_STEP_MS = 900
const LATE_REVEAL_JITTER_MS = 1500 // peers arriving mid-sweep pop in within this
const TICK_COUNT = 12
const BLIP_R_MIN = 16              // blip distance from centre, % of scope radius
const BLIP_R_SPAN = 26

const ICO = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  bt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 7l10 10-5 4V3l5 4L7 17"/></svg>'
}

const hashCode = (str) => {
  let h = 0
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}
const hex4 = (id) => hashCode(id).toString(16).padStart(4, '0').slice(0, 4).toUpperCase()

/** Deterministic blip spot from a person's id: stable angle + ring distance. */
function blipPos (id) {
  const h = hashCode(id)
  const ang = (h % 360) * Math.PI / 180
  const r = BLIP_R_MIN + ((h >>> 9) % BLIP_R_SPAN)
  return { x: 50 + r * Math.cos(ang), y: 50 + r * Math.sin(ang) }
}

export function render (root, ctx) {
  let disposed = false
  const timers = new Set()
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
  }

  const bt = navigator.bluetooth || null
  const supported = !!(bt && typeof bt.requestDevice === 'function')

  let scanning = false
  let sweptOnce = false            // a sweep has finished at least once
  const found = new Map()          // person.id -> lobby person (revealed this sweep)
  const queued = new Set()         // ids with a reveal timer pending
  const devices = new Map()        // chooser-picked real devices — session only
  let chooserOpen = false

  /* ------------------------------------------------------------ skeleton */

  const wrap = el('div', { class: 'v-bt' })

  wrap.appendChild(el('header', { class: 'top' }, [
    el('button', {
      class: 'hb', type: 'button', 'aria-label': 'Back', html: ICO.back,
      onclick: () => ctx.nav('#/chat')
    }),
    el('span', { class: 'btIco', html: ICO.bt }),
    el('h1', { text: 'Bluetooth' })
  ]))

  const blipLayer = el('div', { class: 'blips' })
  const scope = el('div', { class: 'scope', 'aria-hidden': 'true' }, [
    el('div', { class: 'ring r1' }),
    el('div', { class: 'ring r2' }),
    el('div', { class: 'ring r3' }),
    el('div', { class: 'cross' }),
    ...Array.from({ length: TICK_COUNT }, (_, i) =>
      el('i', { class: 'tick', style: `transform:rotate(${i * (360 / TICK_COUNT)}deg)` })),
    el('div', { class: 'sweep' }),
    blipLayer,
    el('i', { class: 'hub' })
  ])

  const scanBtn = el('button', { class: 'scanbtn', type: 'button', onclick: startScan }, [
    el('span', { class: 'bi', html: ICO.bt }), 'Scan nearby devices'
  ])
  const scanState = el('div', { class: 'scanstate', style: 'display:none' }, [
    el('i'), el('span', { text: 'Scanning…' })
  ])

  wrap.appendChild(el('div', { class: 'scanrow' }, [
    scope,
    el('div', { class: 'scanside' }, [
      scanBtn,
      el('p', { class: 'scancap', text: 'Finds Spot Me users around you' }),
      scanState
    ])
  ]))

  if (supported) {
    wrap.appendChild(el('button', {
      class: 'addbt', type: 'button', onclick: addDevice
    }, [el('span', { class: 'bi', html: ICO.bt }), 'Add real Bluetooth device']))
  } else {
    wrap.appendChild(el('p', {
      class: 'noweb',
      text: 'Apple blocks Web Bluetooth on iPhone. Device scanning works in Chrome on Android/desktop — and fully in the native app.'
    }))
  }

  const countEl = el('span', { class: 'n', text: '' })
  const listEl = el('div', { class: 'plist' })
  const devWrap = el('div')
  wrap.appendChild(el('div', { class: 'body scroll-y' }, [
    el('div', { class: 'sh' }, [el('h2', { text: 'Found nearby' }), countEl]),
    listEl,
    devWrap
  ]))
  wrap.appendChild(el('p', {
    class: 'foot',
    text: 'Nearby scan uses the internet to find Spot Me users around you. True offline Bluetooth chat arrives with the native app.'
  }))
  root.appendChild(wrap)

  /* --------------------------------------------------------------- scope */

  function addBlip (person) {
    const { x, y } = blipPos(person.id)
    blipLayer.appendChild(el('i', {
      class: 'sblip', title: person.name || '', style: `left:${x}%;top:${y}%`
    }))
  }

  /* ---------------------------------------------------------- people list */

  function openPerson (person) {
    const existing = db.convos().find((c) => c.mode === 'bluetooth' && c.peer?.id === person.id)
    if (existing) { ctx.openThread(existing.roomId); return }
    actionSheet([{
      label: 'Send request',
      fn () {
        try {
          const roomId = lobby.request(person, 'Bluetooth chat request', 'bluetooth')
          ctx.toast('Request sent')
          ctx.openThread(roomId)
        } catch { ctx.toast('Could not send that request') }
      }
    }], `Send Bluetooth chat request to ${person.name || 'this person'}?`)
  }

  function personRow (person, live, index) {
    const dist = fmtDistance(distanceM(lobby.myPosition(), person))
    return el('button', {
      class: 'prow',
      type: 'button',
      style: `animation-delay:${Math.min(index, 8) * 40}ms`,
      onclick: () => openPerson(person)
    }, [
      avatar(person, 44, { dot: live.has(person.id) }),
      el('div', { class: 'pinfo' }, [
        el('b', { text: person.name || 'Unknown' }),
        el('span', { class: 'dist', text: dist || (person.ghost ? 'position hidden' : 'nearby') })
      ]),
      el('span', { class: 'chip', text: 'BLUETOOTH' })
    ])
  }

  function renderList () {
    clear(listEl)
    const live = new Set(lobby.peers().map((p) => p.id))
    const my = lobby.myPosition()
    const people = [...found.values()]
      .sort((a, b) => (distanceM(my, a) ?? Infinity) - (distanceM(my, b) ?? Infinity))
    countEl.textContent = people.length ? `${people.length} found` : ''
    if (!people.length) {
      const text = scanning
        ? 'Sweeping… people appear as the radar finds them.'
        : sweptOnce
          ? 'No one nearby right now. Ask a friend to open Spot Me, then scan again.'
          : 'Tap Scan to look for Spot Me users around you.'
      listEl.appendChild(el('div', { class: 'empty' }, [el('span', { text })]))
      return
    }
    people.forEach((p, i) => listEl.appendChild(personRow(p, live, i)))
  }

  /* ------------------------------------------------------------- scanning */

  function syncScanUI () {
    scanBtn.disabled = scanning
    scanState.style.display = scanning ? '' : 'none'
    scope.classList.toggle('scanning', scanning)
  }

  function scheduleReveal (person, delay) {
    if (found.has(person.id) || queued.has(person.id)) return
    queued.add(person.id)
    later(() => {
      queued.delete(person.id)
      found.set(person.id, person)
      addBlip(person)
      renderList()
    }, delay)
  }

  function startScan () {
    if (scanning) return
    scanning = true
    found.clear()
    queued.clear()
    clear(blipLayer)
    syncScanUI()
    renderList()
    try { lobby.refreshPosition(); lobby.announce() } catch { /* lobby not up — sweep still runs */ }
    const my = lobby.myPosition()
    const peers = lobby.peers()
      .sort((a, b) => (distanceM(my, a) ?? Infinity) - (distanceM(my, b) ?? Infinity))
    const step = peers.length
      ? Math.min(REVEAL_MAX_STEP_MS, Math.max(REVEAL_MIN_STEP_MS, REVEAL_SPREAD_MS / peers.length))
      : 0
    peers.forEach((p, i) => scheduleReveal(p, REVEAL_START_MS + i * step))
    later(() => {
      scanning = false
      sweptOnce = true
      syncScanUI()
      renderList()
    }, SCAN_MS)
  }

  /* ------------------------------------------- real devices (informational) */

  function renderDevices () {
    clear(devWrap)
    if (!devices.size) return
    devWrap.appendChild(el('div', { class: 'sh' }, [
      el('h2', { text: 'Bluetooth devices' }),
      el('span', { class: 'n', text: 'session only' })
    ]))
    for (const rec of devices.values()) {
      devWrap.appendChild(el('div', { class: 'drow' }, [
        el('span', { class: 'dico', html: ICO.bt }),
        el('b', { text: rec.name }),
        el('span', { class: 'chip dev', text: 'DEVICE' })
      ]))
    }
  }

  async function addDevice () {
    if (!supported || chooserOpen) return
    chooserOpen = true
    try {
      const device = await bt.requestDevice({ acceptAllDevices: true })
      if (disposed) return
      const id = device.id || `anon-${devices.size}`
      if (!devices.has(id)) {
        devices.set(id, { name: device.name || `Unnamed device ${hex4(id)}` })
      }
      renderDevices()
    } catch (err) {
      if (disposed) return
      // NotFoundError = the user closed the chooser without picking — silence.
      if (err && err.name === 'NotFoundError') return
      ctx.toast('Bluetooth scan failed — check that Bluetooth is on')
    } finally {
      chooserOpen = false
    }
  }

  /* ----------------------------------------------------------------- boot */

  const unsubLobby = lobby.subscribe(() => {
    if (disposed) return
    let changed = false
    for (const p of lobby.peers()) {
      if (found.has(p.id)) { found.set(p.id, p); changed = true }
      else if (scanning) scheduleReveal(p, REVEAL_START_MS + Math.random() * LATE_REVEAL_JITTER_MS)
    }
    if (changed) renderList()
  })

  renderList()
  renderDevices()
  syncScanUI()

  return function cleanup () {
    disposed = true
    for (const t of timers) clearTimeout(t)
    timers.clear()
    unsubLobby()
  }
}
