/**
 * Spot Me — shell: router, locked bottom bar, onboarding, boot.
 *
 * Views own their screens; this file owns navigation between them, the
 * one-time profile setup (no login — a name and a username), and bringing the
 * network layers up. Room links (#r=...&k=...) keep working: they are the
 * proven two-phone flow, now joining straight into a conversation.
 */
import './tokens.css'
import { API_BASE } from './lib/api.js'
import { db, wipeDevice } from './lib/db.js'
import { lobby } from './lib/discovery.js'
import { reach } from './lib/reach.js'
import { rooms } from './lib/rooms.js'
import { publishIdentity, identityStatus } from './lib/crypto/identity-store.js'
import { freshTokens, setTerminalAuthHandler } from './lib/socket-transport.js'
import { setBlockedSendHandler } from './lib/crypto/identity-enforcement.js'
import { readyRTC } from './net.js'
import { attachPullRefresh } from './lib/pullrefresh.js'
import { el, clear, toast, avatar, actionSheet } from './lib/ui.js'
import { compressImage, shrinkDataURL, AVATAR_EDGE, AVATAR_QUALITY } from './lib/media.js'
import { openCrop } from './lib/crop.js'
import { readLink } from './net.js'
import { primeAudio, startNotifier, notifyState, enableNotify, notifyBlockedReason, alertMessage } from './lib/notify.js'
import { subscribePush, attachPushHandlers, isNative as isNativeShell } from './lib/push.js'

import * as inbox from './views/inbox.js'
import * as discovery from './views/discovery.js'
import * as chat from './views/chat.js'
import * as bluetooth from './views/bluetooth.js'
import * as profile from './views/profile.js'
import * as contacts from './views/contacts.js'
import * as groups from './views/groups.js'
import * as groupManage from './views/group-manage.js'
import * as verify from './views/verify.js'
import * as notifications from './views/notifications.js'
import * as stories from './views/stories.js'

const app = document.getElementById('app')

/**
 * A reset was asked for via ?fresh — read once, before anything can navigate
 * the URL out from under it. Startup and render both stand down while it runs.
 */
/**
 * A reset the owner can order from here, for devices they are not holding.
 *
 * Chats live only in each phone's own storage — there is no server copy, which
 * is the point of the product but also means nothing run from a laptop can
 * reach them. A device only obeys code it has loaded, so the wipe has to
 * travel inside the build: bump this string, ship it, and the next load of
 * every device resets itself once.
 */
const RESET_EPOCH = '2026-07-26-direct-chat'
const EPOCH_KEY = 'spotme:epoch'

const resetOrdered = () => {
  try { return localStorage.getItem(EPOCH_KEY) !== RESET_EPOCH } catch { return false }
}

const RESETTING = new URL(window.location.href).searchParams.has('fresh') || resetOrdered()

/* ------------------------------------------------- locked bottom bar (5) */

const NAV_ITEMS = [
  {
    // Home left the bar (owner call): the chat list is the landing screen and
    // the Stories screen carries the way back. This slot is Stories now — the
    // rings moved off Home entirely.
    path: '#/stories', label: 'Stories',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.4" stroke-dasharray="4.6 3.1"/><circle cx="12" cy="12" r="3.4"/></svg>'
  },
  {
    path: '#/discovery', label: 'Discovery',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M8.3 8.3a5.2 5.2 0 000 7.4M15.7 8.3a5.2 5.2 0 010 7.4" stroke-linecap="round"/><path d="M5.2 5.2a9.6 9.6 0 000 13.6M18.8 5.2a9.6 9.6 0 010 13.6" stroke-linecap="round"/></svg>'
  },
  {
    // WhatsApp's Chats slot: the fastest way back to the list from anywhere,
    // carrying the unread count. Bluetooth left the bar (owner call) and
    // lives on as the Bluetooth tab inside Home.
    path: '#/chat', label: 'Chats',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M15.6 13.4a5.6 5.6 0 01-6.9 5.5L5.2 20l.8-3.2a5.6 5.6 0 114.9-8.3"/><path d="M13.4 3.6a5.4 5.4 0 015.2 8.4l.7 2.6-2.9-.9"/></svg>'
  },
  {
    // Settings left the bar (owner call — it lives behind the Home profile
    // pic). Its slot is Notifications: requests + fresh unread, one glance.
    // "Alerts", not "Notifications": the long word overflowed its slot and
    // stretched the tab, breaking the even spacing of the reference bar.
    path: '#/notifications', label: 'Alerts',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.2 8.9a6.2 6.2 0 00-12.4 0c0 5.7-2.2 7.3-2.2 7.3h16.8s-2.2-1.6-2.2-7.3"/><path d="M13.9 19.7a2.2 2.2 0 01-3.8 0"/></svg>'
  }
]

/** Which nav tab lights up for each route. */
const ACTIVE_TAB = {
  '#/contacts': '#/chat',       // unlisted screen; Chats stays lit
  '#/discovery': '#/discovery',
  '#/bluetooth': '#/chat',      // a Home tab now, so Chats stays lit
  '#/chat': '#/chat',
  '#/settings': null,           // reached via the profile pic
  '#/stories': '#/stories',
  '#/notifications': '#/notifications'
}

let navEl = null

function buildNav () {
  navEl = el('nav', { class: 'nav' }, NAV_ITEMS.map((item) =>
    el('button', {
      class: 'nv', type: 'button', 'data-path': item.path,
      html: item.icon,
      onclick: () => navigate(item.path)
    }, [item.label])
  ))
  return navEl
}

function updateNav (route) {
  if (!navEl) return
  const active = ACTIVE_TAB[route] || null
  for (const button of navEl.querySelectorAll('.nv')) {
    if (button.dataset.path === active) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  // WhatsApp's unread badge, on the Chats button: total unread across every
  // non-archived conversation.
  const chatBtn = navEl.querySelector('[data-path="#/chat"]')
  chatBtn?.querySelector('.pip')?.remove()
  const unread = db.totalUnread()
  if (chatBtn && unread > 0) {
    chatBtn.appendChild(el('span', { class: 'pip', text: unread > 99 ? '99+' : String(unread) }))
  }
  // RED badge on the bell — only what is NEW since Notifications was last
  // closed (settings.notifSeenTs): non-archived convos whose unread activity
  // is newer + people who first appeared after that moment. The Home pip
  // above stays a total count on purpose.
  const notifBtn = navEl.querySelector('[data-path="#/notifications"]')
  notifBtn?.querySelector('.pip')?.remove()
  const seen = db.settings().notifSeenTs || 0
  const notifCount = db.convos().filter((c) => !c.archived && (c.unread || 0) > 0 && (c.last?.ts || 0) > seen).length +
    lobby.strangers().filter((p) => (p.firstSeen || 0) > seen).length
  if (notifBtn && notifCount > 0) {
    notifBtn.appendChild(el('span', { class: 'pip req', text: notifCount > 99 ? '99+' : String(notifCount) }))
  }
}

/* ---------------------------------------------------------------- router */

const ROUTES = {
  '#/chat': inbox,
  '#/discovery': discovery,
  '#/contacts': contacts,
  '#/groups': groups,      // reachable by link; no longer in the bar
  '#/settings': profile,
  '#/notifications': notifications,
  '#/stories': stories,
  '#/bluetooth': bluetooth
}

let currentCleanup = null
let viewContainer = null

export function navigate (path) {
  if (window.location.hash === path) render()
  else window.location.hash = path
}

const ctx = {
  nav: navigate,
  openThread: (roomId) => navigate(`#/thread/${roomId}`),
  toast
}

function render () {
  // A reset is in flight and will replace the URL — painting the old profile
  // first would flash the very data being erased.
  if (RESETTING) return
  const hash = window.location.hash || '#/chat'

  if (!db.ready()) { renderOnboarding(); return }

  if (typeof currentCleanup === 'function') currentCleanup()
  currentCleanup = null
  db.setOpenRoom(null)

  if (!viewContainer) {
    clear(app)
    viewContainer = el('div', { class: 'view' })
    app.appendChild(viewContainer)
    app.appendChild(buildNav())
    // Pull down anywhere to hard-refresh: phones otherwise sit on an old
    // bundle until someone remembers the browser's own gesture.
    attachPullRefresh(app)
  }
  clear(viewContainer)

  const threadMatch = hash.match(/^#\/thread\/(.+)$/)
  if (threadMatch) {
    navEl.style.display = 'none'
    currentCleanup = chat.render(viewContainer, ctx, decodeURIComponent(threadMatch[1]))
    return
  }

  /* Key verification is a full screen entered from one chat, and its back
   * button returns to that chat — same shape as group management below. */
  const verifyMatch = hash.match(/^#\/verify\/(.+)$/)
  if (verifyMatch) {
    navEl.style.display = 'none'
    currentCleanup = verify.render(viewContainer, ctx, decodeURIComponent(verifyMatch[1]))
    return
  }

  // Group management is a full screen like a thread, not a tab: it is entered
  // from one group and its back button returns to the list.
  const groupMatch = hash.match(/^#\/group\/(.+)$/)
  if (groupMatch) {
    navEl.style.display = 'none'
    currentCleanup = groupManage.render(viewContainer, ctx, decodeURIComponent(groupMatch[1]))
    return
  }

  navEl.style.display = ''
  const view = ROUTES[hash] || inbox
  updateNav(hash in ROUTES ? hash : '#/chat')
  currentCleanup = view.render(viewContainer, ctx)
}

/* ------------------------------------------------------------ onboarding */

/** Username registry origin — the registry lives on the Spot Me backend, so
 *  this must be the SAME host the rooms use or the two disagree about ids. */
const REGISTRY_API = API_BASE
const USERNAME_RE = /^[a-z0-9_]{3,16}$/
const CHECK_DEBOUNCE_MS = 400

/* 18+ gate (owner decision D6). Year-month only — never a full birthday — and
 * the same CONSERVATIVE month rule the server enforces: eligible only once the
 * 18th-birthday month has fully passed in UTC. This check is a courtesy so the
 * refusal is instant and clearly worded; the server refuses independently, so
 * bypassing this buys nothing. */
const BIRTH_YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const AGE_REFUSAL = 'Spot Me is for people 18 and over. We are not able to offer you an account yet.'
function isAdultYM (ym) {
  if (!BIRTH_YM_RE.test(ym)) return false
  const now = new Date()
  const eighteenthYear = Number(ym.slice(0, 4)) + 18
  const month = Number(ym.slice(5, 7))
  const curY = now.getUTCFullYear()
  return curY > eighteenthYear || (curY === eighteenthYear && now.getUTCMonth() + 1 > month)
}

function renderOnboarding () {
  clear(app)
  viewContainer = null
  navEl = null

  let avatarData = null
  const name = el('input', {
    class: 'ob-name', type: 'text', placeholder: 'Your name', maxlength: '32',
    autocomplete: 'nickname'
  })

  /* Username: normalised live, availability checked against the registry. */
  let usernameState = 'idle'   // idle | checking | available | taken | error
  let checkTimer = null
  let checkSeq = 0
  let starting = false

  const username = el('input', {
    class: 'ob-name ob-uinput', type: 'text', placeholder: 'username', maxlength: '16',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false'
  })
  const usernameStatus = el('span', { class: 'ob-ustatus', 'aria-hidden': 'true' })

  const setUsernameState = (next) => {
    usernameState = next
    usernameStatus.className = 'ob-ustatus' + (next === 'idle' ? '' : ` ${next}`)
    usernameStatus.textContent = next === 'available' ? '✓' : next === 'taken' ? '✕' : ''
  }

  const checkAvailability = async (value) => {
    const seq = ++checkSeq
    try {
      const res = await fetch(`${REGISTRY_API}/api/username?check=${encodeURIComponent(value)}`)
      if (!res.ok) throw new Error('check failed')
      const data = await res.json()
      if (seq !== checkSeq || username.value !== value) return
      setUsernameState(data.available ? 'available' : 'taken')
    } catch {
      if (seq !== checkSeq || username.value !== value) return
      setUsernameState('error')   // registry unreachable — Start may still proceed
    }
  }

  username.addEventListener('input', () => {
    const cleaned = username.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16)
    if (cleaned !== username.value) username.value = cleaned
    clearTimeout(checkTimer)
    if (!USERNAME_RE.test(cleaned)) { setUsernameState('idle'); return }
    setUsernameState('checking')
    checkTimer = setTimeout(() => checkAvailability(cleaned), CHECK_DEBOUNCE_MS)
  })

  /* Birth year-month for the 18+ gate. type="month" gets a native picker on
   * phones and degrades to text elsewhere — the placeholder covers that. */
  const birthYM = el('input', {
    class: 'ob-name', type: 'month', placeholder: 'YYYY-MM',
    autocomplete: 'bday', max: new Date().toISOString().slice(0, 7)
  })

  const avatarSlot = el('button', {
    class: 'ob-avatar', type: 'button', 'aria-label': 'Add a photo',
    onclick: () => filePick.click()
  }, [avatar({ name: ' ' }, 84)])

  const filePick = el('input', { type: 'file', accept: 'image/*', style: 'display:none' })
  filePick.addEventListener('change', async () => {
    const file = filePick.files?.[0]
    if (!file) return
    try {
      const { dataURL } = await compressImage(file, AVATAR_EDGE, AVATAR_QUALITY)
      const cropped = await openCrop(dataURL)
      if (!cropped) return                       // cancelled — keep whatever was there
      avatarData = cropped
      clear(avatarSlot)
      avatarSlot.appendChild(avatar({ avatar: cropped }, 84))
    } catch { toast('Could not read that image') }
  })

  const start = async () => {
    if (starting) return
    const chosen = name.value.trim()
    if (!chosen) { toast('Tell us your name first'); name.focus(); return }
    const handle = username.value.trim().toLowerCase()
    if (!USERNAME_RE.test(handle)) {
      toast('Pick a username — 3–16 letters, numbers or underscores')
      username.focus()
      return
    }
    if (usernameState === 'taken') { toast('That username is taken'); username.focus(); return }
    const ym = birthYM.value.trim()
    if (!BIRTH_YM_RE.test(ym)) {
      toast('Enter your birth month — Spot Me is 18+')
      birthYM.focus()
      return
    }
    if (!isAdultYM(ym)) { toast(AGE_REFUSAL); return }

    starting = true
    goBtn.disabled = true
    // Mint the profile id first — the claim record binds username -> id.
    // birthYearMonth stays on-device too: every later guest re-auth (fresh
    // install token fetch) sends it so the account is created age-verified.
    const me = db.setProfile({ name: chosen, lang: db.profile()?.lang || 'en', avatar: avatarData, birthYearMonth: ym })
    let claimed = false
    let reachable = true
    try {
      const res = await fetch(`${REGISTRY_API}/api/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: handle, id: me.id, name: chosen, secret: me.claimSecret, birthYearMonth: ym })
      })
      if (res.status === 400) {
        // The server's own 18+ refusal (it re-checks; the client check above is
        // only a courtesy). Terminal for this attempt — no account was created.
        let msg = null
        try { msg = (await res.clone().json())?.message } catch { /* non-JSON */ }
        const text = Array.isArray(msg) ? msg.join(' ') : String(msg || '')
        if (text.includes('18 and over')) {
          toast(AGE_REFUSAL)
          starting = false
          goBtn.disabled = false
          return
        }
      }
      if (res.status === 409) {
        setUsernameState('taken')
        toast('That username was just taken — try another')
        starting = false
        goBtn.disabled = false
        return
      }
      claimed = res.ok
    } catch { reachable = false }
    if (claimed) {
      db.setProfile({ username: handle })
    } else {
      toast(reachable
        ? 'Could not claim that username — you can claim it later in Settings.'
        : 'Username registry unreachable — you can claim it later in Settings.')
    }
    boot()
    // A brand-new device reaches the startup offer while db.ready() is still
    // false, so it bails there. This is the moment a profile first exists —
    // ask now, or a fresh install would never be asked at all.
    offerNotifications()
    // Land on Messages — never on whatever screen the hash pointed at before
    // onboarding (after "Clear all data" it was #/settings, which stuck).
    if (readLink()) {
      const roomId = adoptRoomLink()
      if (roomId) { window.location.hash = `#/thread/${roomId}`; return }
    }
    navigate('#/chat')
  }

  const goBtn = el('button', { class: 'pill ok ob-go', type: 'button', text: 'Start', onclick: start })

  /* A pre-gate device arriving back here (age_declaration_required) keeps its
   * identity: prefill so "confirm your birth month" is one field, not a redo. */
  const existing = db.profile()
  if (existing?.name) name.value = existing.name
  if (existing?.username) { username.value = existing.username; setUsernameState('idle') }
  if (existing?.avatar) {
    avatarData = existing.avatar
    clear(avatarSlot)
    avatarSlot.appendChild(avatar({ avatar: existing.avatar }, 84))
  }

  app.appendChild(el('div', { class: 'onboard scroll-y' }, [
    el('div', { class: 'ob-inner' }, [
      el('h1', { text: 'Spot Me' }),
      // The old lede promised "no server reading your messages". That was false:
    // DM keys were derived from a non-cryptographic hash of two user ids the
    // server stores, so it could recompute any of them (V-19, ADR-001). New
    // chats now use real key agreement, but old ones cannot be retrofitted and
    // the server still hands out the public keys — so the claim is narrowed to
    // what is actually true rather than restated with a fresh adjective.
    el('p', { class: 'ob-lede', text: 'Meet people nearby. Chat in any language. No account needed — new chats are encrypted with keys made on your device.' }),
      avatarSlot,
      filePick,
      el('label', { text: 'Name' }),
      name,
      el('label', { text: 'Username' }),
      el('div', { class: 'ob-username' }, [
        el('span', { class: 'ob-uat', text: '@' }),
        username,
        usernameStatus
      ]),
      el('p', { class: 'ob-uhint', text: '3–16 letters, numbers, underscores' }),
      el('label', { text: 'Birth month' }),
      birthYM,
      el('p', { class: 'ob-uhint', text: 'Spot Me is 18+. Only the year and month — never your full birthday.' }),
      goBtn,
      el('p', { class: 'ob-fine', text: 'No password, no phone number. Your profile lives on this device.' })
    ])
  ]))
  name.focus()
}

/* ------------------------------------------------------------------ boot */

/** A #r=&k= link means someone shared a chat or group with this person. */
function adoptRoomLink () {
  const link = readLink()
  if (!link) return null
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const groupName = params.get('g')
  if (!db.convo(link.roomId)) {
    db.upsertConvo({
      roomId: link.roomId,
      secret: link.secret,
      kind: groupName ? 'group' : 'dm',
      mode: 'meet',
      peer: { id: null, name: groupName || 'Invited chat', avatar: null, lang: 'en' },
      title: groupName || 'Invited chat',
      last: { text: 'Joined via link', ts: Date.now(), fromMe: true }
    })
  }
  return link.roomId
}

/**
 * ?fresh — wipe this device's Spot Me data and start onboarding again.
 *
 * Testing two phones means resetting them repeatedly, and Settings > Clear all
 * is several taps deep behind a profile you are trying to destroy.
 *
 * The username goes back to the registry FIRST, while the secret proving we
 * hold it still exists. Skipping that would burn the name: the record would
 * outlive the device, still pointing at a profile id nothing answers to, so
 * anyone searching it would send a request into a void. Best-effort — if the
 * registry is unreachable the wipe still happens, and the name stays taken.
 *
 * Everything else is local. It cannot touch the other person's phone.
 */
async function maybeFreshStart () {
  const url = new URL(window.location.href)
  const ordered = resetOrdered()
  if (!url.searchParams.has('fresh') && !ordered) return false

  const me = db.profile()
  if (me?.username) {
    try {
      await fetch(`${REGISTRY_API}/api/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'release', username: me.username, secret: me.claimSecret || '', id: me.id
        })
      })
    } catch { /* offline — the name stays claimed, nothing else breaks */ }
  }

  /* AWAITED, and its answer acted on. Two things were wrong with firing this
   * and reloading: the IndexedDB deletes had not finished when the page went
   * away, and a wipe that FAILED — most realistically because another tab still
   * holds a database open, which makes deleteDatabase block and silently do
   * nothing — reloaded into a screen that claimed the device was clean while
   * the data was still on disk. Telling someone their data is gone when it is
   * not is the one outcome this button must never produce. */
  let wiped = { ok: false, failures: ['unknown'] }
  try { wiped = await wipeDevice() } catch { /* private mode — nothing to clear */ }
  if (!wiped.ok) {
    toast(`Couldn’t finish clearing this device (${wiped.failures.join(', ')}). ` +
      'Close any other Spot Me tabs and try again.')
    return false
  }
  // Stamped AFTER the wipe, so a reset interrupted half-way runs again next
  // time instead of being marked done.
  try { localStorage.setItem(EPOCH_KEY, RESET_EPOCH) } catch { /* private mode */ }

  url.searchParams.delete('fresh')
  const next = url.toString()
  // replace() to an identical URL does NOT reload, and this screen is frozen
  // until something does — RESETTING keeps render() and boot() standing down.
  if (next === window.location.href) window.location.reload()
  else window.location.replace(next)
  return true
}

/**
 * Avatars captured before the 256px cap are hundreds of KB and now ride the
 * room handshake. Shrink once, in place, so the cost is paid one time rather
 * than on every reconnect.
 */
const AVATAR_WIRE_LIMIT = 60_000

function healOversizedAvatar () {
  const me = db.profile()
  if (!me?.avatar || me.avatar.length <= AVATAR_WIRE_LIMIT) return
  shrinkDataURL(me.avatar).then((small) => {
    if (small && small.length < me.avatar.length) db.setProfile({ avatar: small })
  }).catch(() => { /* keep the big one rather than lose the picture */ })
}

function boot () {
  if (!db.ready()) return
  healOversizedAvatar()
  /**
   * Unlock audio on the first touch or key, whatever it was for.
   *
   * Browsers refuse to start an AudioContext until the user has interacted
   * with the page, and a message can land before they have deliberately done
   * anything sound-related. Without this the very first alert — the one that
   * matters most — would arrive silently.
   */
  for (const event of ['pointerdown', 'keydown']) {
    window.addEventListener(event, primeAudio, { once: true, passive: true })
  }
  /**
   * Relay credentials FIRST. Trystero reads the connection config once, at
   * join time, so a conversation that joins before the relay arrives is stuck
   * on a direct-only path for its whole lifetime — which on Indian mobile
   * networks means presence works while messages silently never arrive.
   * readyRTC() resolves either way (STUN-only on failure), so this cannot
   * strand the app offline.
   */
  /**
   * PUBLISH THIS DEVICE'S PUBLIC KEY.
   *
   * Without this the whole e2e_v2 path is dead code: `User.publicKey` stays
   * NULL for everyone, so every `fetchPeerKey` 404s, every `prepareV2` returns
   * null, and every new room silently falls back to the v1 cyrb53 secret the
   * server can recompute. The crypto was correct and simply never ran.
   *
   * Fire-and-forget on purpose. It is not on the critical path — nothing local
   * needs the PUBLISHED key, only peers do — so it must never delay chat or
   * fail sign-in. A failed publish means peers open v1 rooms with us until the
   * next boot, which is the old behaviour, not a regression.
   *
   * It runs OUTSIDE the readyRTC() gate below because it is plain HTTP and has
   * nothing to do with ICE.
   */
  /* `publishIdentity` loads the identity on its way through, so once it settles
   * — either way — `identityStatus()` has a real answer. Toasting here rather
   * than only in the chat means a device in this state says so at launch,
   * before the user has typed a message nobody will be able to read. The chat
   * carries the persistent copy; this is the one that arrives unprompted. */
  /* An identity the server will never accept again — a deleted account.
   *
   * Registered because stopping the retry loop is only half the fix: a device
   * that quietly stops trying is indistinguishable from one that is quietly
   * working, and that ambiguity is the exact shape of every bug found here
   * tonight. The transport reports the fact; this is what turns it into
   * something the person holding the phone can read. */
  setTerminalAuthHandler(({ code, message }) => {
    if (code === 'age_declaration_required') {
      // A pre-gate install: the device has a profile but no declaration, and
      // the server now refuses to (re)create its account without one. Back
      // through onboarding — it prefills, and chats stay in local storage.
      toast(message || 'Spot Me is 18+ now — confirm your birth month to continue.')
      renderOnboarding()
      return
    }
    toast(message || 'This account has been deleted. Start a new one to keep chatting.')
  })

  /* A5. What a refused send says out loud.
   *
   * Registered here rather than imported by `rooms.js` for the same reason as
   * the handler above: the room layer must not reach into a view, and a
   * refusal nobody is told about is indistinguishable from a message that
   * quietly went nowhere — which is the ambiguity this codebase keeps
   * rediscovering. `message` already names what would clear the block, so this
   * does not compose its own sentence.
   *
   * Inert until enforcement is switched on: nothing is refused today. */
  setBlockedSendHandler(({ message }) => {
    toast(message || 'That message was not sent — check this contact’s verification.')
  })

  publishIdentity(freshTokens)
    .catch(() => {})
    .then(() => {
      const state = identityStatus()
      if (state === 'ephemeral') {
        toast('This device can’t save its encryption key — messages you send can’t be read.')
      } else if (state === 'unavailable') {
        toast('This device can’t store encryption keys — private browsing is the usual cause.')
      }
    })

  readyRTC().then(() => {
    rooms.connectAll()
    lobby.start()
    reach.joinInbox()
  })
}

db.subscribe(() => {
  const hash = window.location.hash || '#/chat'
  if (hash in ACTIVE_TAB) updateNav(hash)
})

// Presence changes move the bell count (active people nearby) — keep it live.
lobby.subscribe(() => {
  const hash = window.location.hash || '#/chat'
  if (hash in ACTIVE_TAB) updateNav(hash)
})

/* ------------------------------- app-switcher privacy blur (cooperative) */

// Blur the whole app while the tab/app is hidden so switcher previews show
// nothing readable. True screenshot DETECTION does not exist on the web —
// this is the honest, achievable version. Gated by settings.appBlur
// (default true; the toggle lives in Settings).
document.addEventListener('visibilitychange', () => {
  const wanted = db.settings().appBlur !== false && document.hidden
  app.classList.toggle('privacy-blur', wanted)
})

// Regaining foreground is the one moment worth reacting to immediately: a
// locked phone can silently kill the lobby's connections, and an undelivered
// hello should not wait on a heartbeat timer to notice.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { lobby.resume(); reach.resume() }
})

window.addEventListener('hashchange', render)

// Kicked off before the boot sequence below reads the profile: a reset that
// races the lobby would announce the identity it is about to delete.
if (RESETTING) maybeFreshStart()

/**
 * Ask, once, whether this device should be woken for messages.
 *
 * Until now nothing ever asked. Startup only RE-subscribed when permission was
 * already granted, and the only place that called requestPermission() was a
 * toggle buried in profile settings — so a person installed the app, never
 * found that switch, and silently never received a notification. Production
 * bore this out exactly: zero push subscriptions, for every user, ever.
 *
 * It has to be a sheet with a button rather than an automatic call, because
 * browsers only honour requestPermission() from a user gesture — the tap IS
 * the gesture. Asked at most once: `notifyAsked` is set whatever the answer,
 * since re-prompting someone who declined is how an app gets muted for good.
 * Anyone who changes their mind still has the settings toggle.
 */
async function offerNotifications () {
  if (!db.ready()) return                       // still onboarding
  if (db.settings().notifyAsked) return
  if (notifyState() !== 'default') return       // already granted or denied

  // On iOS, Web Push exists ONLY for a PWA opened from the Home Screen. Asking
  // in Safari would fail and burn the one prompt, so point at the real fix.
  if (notifyBlockedReason() === 'ios-needs-install') {
    db.setSettings({ notifyAsked: true })
    toast('Add Spot Me to your Home Screen to get alerts when the app is closed')
    return
  }

  db.setSettings({ notifyAsked: true })
  const yes = await actionSheet(
    [{ label: 'Turn on alerts', fn: () => true }, { label: 'Not now', fn: () => false }],
    'Get told when a message arrives, even with Spot Me closed?'
  )
  if (!yes) return

  const result = await enableNotify()
  if (result !== 'granted') return
  const push = await subscribePush().catch(() => ({ ok: false }))
  toast(push.ok ? 'Alerts on — you can be reached with the app closed' : 'Alerts on')
}

/* Deliberately outside boot(), which stands down until onboarding is complete.
 * The worker is what puts alerts in the phone's notification tray, and it takes
 * a moment to activate — waiting for a finished profile would mean the first
 * messages of a brand-new install fell back to a tab-bound notification. */
if (!RESETTING) {
  startNotifier().then(() => {
    /* Re-claim the push subscription on every launch. Browsers drop them —
     * on storage pressure, on a long absence, whenever the push service
     * rotates an endpoint — and a stale endpoint fails silently, so a device
     * that once enabled alerts would simply stop being wakeable and never say
     * so. Existing subscriptions are reused, so this is cheap. */
    /* The packaged app has NO `Notification` object at all, so gating on
     * Notification.permission silently skipped native registration and left
     * the phone permanently unwakeable. Native asks the OS for permission
     * itself, so it must bypass this browser-only check entirely. */
    if (isNativeShell() || (typeof Notification !== 'undefined' && Notification.permission === 'granted')) {
      subscribePush().catch(() => {})
    } else {
      offerNotifications()
    }

    /* Consume what arrives. Registration only makes the phone REACHABLE; until
     * these are attached, a push landing while the app is open displays nothing
     * (Android hands it to the running app rather than the tray) and a tap on a
     * tray notification opens the app on whatever screen it was last showing.
     *
     * Not chained to subscribePush: a token registered on a PREVIOUS launch is
     * still live, so taps must route even when today's registration fails.
     * `#/thread/<roomId>` is the chat itself — `#/chat` is the chat LIST, and
     * routing there would drop the user one screen short every time.
     *
     * alertMessage takes an object, and it earns its keep here: it suppresses
     * the alert when this very room is already on screen, and only raises a
     * system notification when the app is hidden. */
    attachPushHandlers({
      onForeground: ({ roomId, title, body }) => alertMessage({ roomId, title, body }),
      onOpenRoom: (roomId) => { window.location.hash = `#/thread/${roomId}` }
    }).catch(() => {})
  })
}

const linkedRoom = !RESETTING && db.ready() ? adoptRoomLink() : null
if (!RESETTING) boot()
if (linkedRoom) {
  window.location.hash = `#/thread/${linkedRoom}`
} else if (!window.location.hash || window.location.hash.startsWith('#r=')) {
  // Not ready yet but arrived via link: onboarding first, thread after.
  if (!db.ready() && readLink()) {
    const pending = readLink()
    const unsub = db.subscribe(() => {
      if (db.ready()) {
        unsub()
        boot()
        const roomId = adoptRoomLink() || pending.roomId
        window.location.hash = `#/thread/${roomId}`
      }
    })
  } else {
    window.location.hash = '#/chat'
  }
}
render()
