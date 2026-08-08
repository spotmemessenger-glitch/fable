/**
 * Spot Me — shell: router, locked bottom bar, onboarding, boot.
 *
 * Views own their screens; this file owns navigation between them, the
 * one-time profile setup (no login — a name and a username), and bringing the
 * network layers up. Room links (#r=...&k=...) keep working: they are the
 * proven two-phone flow, now joining straight into a conversation.
 */
/* Faces first: tokens.css sets --font, so the @font-face rules that define
 * those families must already be in the sheet when it is applied. */
import './fonts.css'
import './tokens.css'
import { API_BASE } from './lib/api.js'
import { db, wipeDevice } from './lib/db.js'
import { lobby } from './lib/discovery.js'
import { reach } from './lib/reach.js'
import { rooms } from './lib/rooms.js'
import { publishIdentity, identityStatus, identityFailure } from './lib/crypto/identity-store.js'
import { freshTokens, setTerminalAuthHandler } from './lib/socket-transport.js'
import { setBlockedSendHandler } from './lib/crypto/identity-enforcement.js'
import { readyRTC } from './net.js'
import { attachPullRefresh } from './lib/pullrefresh.js'
import { installAudioUnlock } from './lib/video.js'
import { warmAvailability } from './lib/blobstore.js'
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
import * as exchange from './views/exchange.js'
import * as profile from './views/profile.js'
import * as contacts from './views/contacts.js'
import * as groups from './views/groups.js'
import * as groupManage from './views/group-manage.js'
import * as verify from './views/verify.js'
import * as notifications from './views/notifications.js'
import * as stories from './views/stories.js'
import * as moments from './views/moments.js'
import { momentsAvailable, resetMomentsAvailability } from './lib/moments-api.js'

const app = document.getElementById('app')

/* Video sound is meant to be ON, and browsers only permit that once the page
 * has been touched. Arm the listener at the document, at boot, so the gesture
 * that unlocks it is the reader's FIRST tap anywhere — onboarding, a chat, a
 * tab — rather than a second tap they have to spend on a video control after
 * already arriving at one. See lib/video.js for the full rule. */
installAudioUnlock(document)
/* Settle whether IndexedDB actually OPENS before anything gates on it.
 * `blobstore.available()` can only guess until a real open has been tried, and
 * its guess was the optimistic one on exactly the devices where it was wrong. */
void warmAvailability()

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

/* `let`, not `const`: a FAILED wipe lifts the stand-down (maybeFreshStart)
 * rather than leaving the screen blank forever. */
let RESETTING = new URL(window.location.href).searchParams.has('fresh') || resetOrdered()

/* F1: ask the browser to mark this origin's storage durable, so the identity
 * key and profile survive storage pressure. Best-effort — denial changes
 * nothing about how the app behaves, it only leaves eviction possible. */
if (!RESETTING) { try { navigator.storage?.persist?.().catch(() => {}) } catch { /* older engines */ } }

/* ------------------------------------------------- locked bottom bar (5) */

const NAV_ITEMS = [
  {
    /* M6: POSTS replaces Stories in the bar. Stories are not a destination —
     * they are the ring row at the top of the Posts feed, the way Instagram
     * and Messenger do it, so the bar stays at five slots and the rings sit
     * where people already look for them. #/stories still routes (old links
     * keep working); it simply has no tab.
     *
     * `flag: 'moments'` means this item is DROPPED from the bar unless the
     * server serves Moments to this account — in production the bar is
     * byte-identical to what it was before this change. */
    path: '#/posts', label: 'Posts', flag: 'moments',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.4" y="3.4" width="17.2" height="17.2" rx="4.6"/><circle cx="12" cy="12" r="3.6"/><circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none"/></svg>'
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
  },
  {
    /* Exchange (slice 1). `deviceFlag` gates on the LOCAL opt-in
     * (`spotme.ui.exchange`, default OFF) rather than a server probe: the
     * server domain is open to every account, but the React surface ships
     * dark, so the tab appears only on a device where someone ran
     * localStorage.setItem('spotme.ui.exchange','on'). For everyone else the
     * bar is byte-identical to before this entry existed. */
    path: '#/exchange', label: 'Exchange', deviceFlag: 'exchange',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.8L3.4 7.4 7 11M3.6 7.4h13M17 13l3.6 3.6L17 20.2M20.4 16.6h-13"/></svg>'
  }
]

/** Which nav tab lights up for each route. */
const ACTIVE_TAB = {
  '#/contacts': '#/chat',       // unlisted screen; Chats stays lit
  '#/discovery': '#/discovery',
  '#/bluetooth': '#/chat',      // a Home tab now, so Chats stays lit
  '#/chat': '#/chat',
  '#/settings': null,           // reached via the profile pic
  '#/stories': null,            // still routable by link; no tab of its own
  '#/posts': '#/posts',
  '#/notifications': '#/notifications',
  '#/exchange': '#/exchange'
}

/** The route part of a hash, without its query string: `#/posts?m=abc` →
 *  `#/posts`. Share links are the only routes that carry params today. */
function routePath (hash) {
  const h = hash || '#/chat'
  const i = h.indexOf('?')
  return i === -1 ? h : h.slice(0, i)
}

/* M7: Posts is the HOME of a served account.
 *
 * The cold-open landing decision needs an answer BEFORE the server probe can
 * possibly have one, so the probe's last definitive answer is kept in
 * settings (`momentsHome`) and read synchronously at load. It is a CACHE of
 * the server's statement, never a switch of its own: a device that has never
 * been told "served" cannot land on Posts, the bar is still built only from
 * the live probe, and every Moments request is still gated server-side. The
 * probe reconciles a stale cache in both directions in refreshFlaggedTabs.
 *
 * Only the four bar tabs count as a "remembered last tab" a cold open may
 * override. Anything else in the hash — a thread, a share link with params,
 * a settings screen — is someone going SOMEWHERE, and always wins. */
const BAR_TABS = new Set(NAV_ITEMS.map((item) => item.path))
// A resetting device is mid-wipe: its hint is the very data being erased, so
// the landing falls back to the line that has always been here.
const homeTab = () => (!RESETTING && db.ready() && db.settings().momentsHome ? '#/posts' : '#/chat')
let coldOpenTab = null   // the bar tab this load landed on by default, until the person navigates
let hintLed = false      // that landing was chosen by the stored hint, not by the URL

let navEl = null

/* Which flagged tabs the SERVER is currently serving. Empty until the probe
 * answers, so the bar renders in its production shape first and gains a tab
 * only if Moments is genuinely available — never the other way round. */
const enabledFlags = new Set()

function navItems () {
  return NAV_ITEMS.filter((item) =>
    (!item.flag || enabledFlags.has(item.flag)) &&
    (!item.deviceFlag || exchange.uiFlag(item.deviceFlag)))
}

function buildNav () {
  navEl = el('nav', { class: 'nav' }, navItems().map((item) =>
    el('button', {
      class: 'nv', type: 'button', 'data-path': item.path,
      html: item.icon,
      onclick: () => navigate(item.path)
    }, [item.label])
  ))
  return navEl
}

/** Re-ask the server which flagged surfaces exist, and rebuild the bar.
 *  Idempotent: reconciles against the ACTUAL DOM, not a boolean, so it does
 *  the right thing no matter which of the (boot / first-render) callers wins
 *  the race — the earlier `on !== had` guard skipped the rebuild when the flag
 *  was set before navEl existed, leaving the tab permanently absent. */
export async function refreshFlaggedTabs () {
  let on = false
  try { on = await momentsAvailable() } catch { on = false }
  if (on) enabledFlags.add('moments'); else enabledFlags.delete('moments')
  /* M7: remember the answer so the NEXT cold open lands right without waiting
   * for this probe — and reconcile THIS one while the person is still sitting
   * on the landing tab. Served + still on the default → move Home to Posts
   * (the first grant, or a device with no cache yet). Not served + the cache
   * chose Posts → back to Chats rather than a dead tab. Once they navigate
   * anywhere themselves, coldOpenTab is null and nothing moves them again. */
  if (db.ready() && db.settings().momentsHome !== on) db.setSettings({ momentsHome: on })
  if (coldOpenTab && window.location.hash === coldOpenTab) {
    if (on && coldOpenTab !== '#/posts') {
      coldOpenTab = '#/posts'
      hintLed = true
      navigate('#/posts')
    } else if (!on && hintLed) {
      coldOpenTab = null
      hintLed = false
      navigate('#/chat')
    }
  }
  if (!navEl) return
  const desired = navItems().map((i) => i.path).join(',')
  const current = [...navEl.querySelectorAll('.nv')].map((b) => b.dataset.path).join(',')
  if (desired !== current) {
    // buildNav() REASSIGNS the module-level navEl as a side effect, so the old
    // element must be captured FIRST — otherwise `navEl.replaceWith(navEl)` is
    // a no-op and the stale nav stays in the DOM while the fresh (correct) one
    // is never inserted. That was the bug the runtime logs exposed: the
    // reconcile "succeeded" against a detached node while the bar never moved.
    const old = navEl
    buildNav()
    old.replaceWith(navEl)
    // Strip any `?m=…` before the tab lookup, for the same reason the router
    // does: `#/posts?m=x` is the Posts tab, not an unknown route.
    updateNav(routePath(window.location.hash))
  }
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
  '#/posts': moments,
  '#/bluetooth': bluetooth,
  /* Slice 1. Renders the React island when spotme.ui.exchange is 'on';
   * with the flag off (the default) it renders nothing and the route is
   * effectively absent -- Exchange has no legacy screen to fall back to. */
  '#/exchange': exchange
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
    // M6: boot()'s probe can fire BEFORE this first nav exists (it runs before
    // the first render), so the flagged-tab rebuild there no-ops on a null
    // navEl. Re-run it now that navEl is real — momentsAvailable() is cached,
    // so this is just the DOM rebuild the earlier call could not do.
    refreshFlaggedTabs().catch(() => {})
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

  /* A route may carry a query string — `#/posts?m=<id>` is the share link a
   * post's own Share button produces. The lookup below used to be a plain
   * `ROUTES[hash]`, so the whole `#/posts?m=…` string missed every key and
   * fell through to the `|| inbox` default: every shared post link opened the
   * chat list. Split the path from its params and route on the path, then hand
   * the params to the view so it can honour them. */
  const qIndex = hash.indexOf('?')
  const path = routePath(hash)
  const params = new URLSearchParams(qIndex === -1 ? '' : hash.slice(qIndex + 1))

  navEl.style.display = ''
  const view = ROUTES[path] || inbox
  updateNav(path in ROUTES ? path : '#/chat')
  currentCleanup = view.render(viewContainer, ctx, params)
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
/* Fix-the-Foundation F1: this account lives in this browser's storage, and
 * in-app browser views (links opened inside WhatsApp, Instagram, chat apps…)
 * often keep a SEPARATE, throwaway copy of that storage — which is exactly
 * "I have to sign up again every time I reopen". The app cannot stop a host
 * app from discarding its webview storage; what it can do is ask for durable
 * storage, say out loud when the window looks throwaway, and (the real fix)
 * let the same @username sign back in with a recovery code. */
const IN_APP_BROWSER_RE = /\bwv\b|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|GSA\/|TikTok|Twitter/i
function looksInApp () {
  const ua = navigator.userAgent || ''
  if (IN_APP_BROWSER_RE.test(ua)) return true
  // iOS webviews ship AppleWebKit without the trailing "Safari" token.
  return /iPhone|iPad/.test(ua) && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)
}

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
    // Land on Home — never on whatever screen the hash pointed at before
    // onboarding (after "Clear all data" it was #/settings, which stuck).
    // Home is homeTab(), not a literal: a served account interrupted by the
    // age re-declaration returns to Posts (M7); a fresh device, which cannot
    // hold the hint yet, lands on Messages exactly as before.
    if (readLink()) {
      const roomId = adoptRoomLink()
      if (roomId) { window.location.hash = `#/thread/${roomId}`; return }
    }
    navigate(homeTab())
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
      el('p', { class: 'ob-fine', text: 'No password, no phone number. Your profile lives on this device.' }),
      looksInApp()
        ? el('p', { class: 'ob-fine', style: 'color:#b45309', text: 'You seem to be inside another app’s browser — it may forget you when it closes. Open spotme-web-v2.vercel.app in Chrome or Safari and use “Add to Home Screen”.' })
        : null,
      el('button', {
        class: 'linkbtn', type: 'button', text: 'Been here before? Sign back in',
        onclick: renderRecovery
      })
    ])
  ]))
  name.focus()
}

/* Fix-the-Foundation F1: sign back in as an existing @username with the
 * recovery code (shown in Profile after signup). The device ADOPTS the
 * account's id — chats stored on other devices stay theirs; this device
 * starts with the account, not with its history (messages are device-local). */
function renderRecovery () {
  clear(app)
  viewContainer = null
  navEl = null
  const user = el('input', {
    class: 'ob-name ob-uinput', type: 'text', placeholder: 'username', maxlength: '16',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false'
  })
  const code = el('input', {
    class: 'ob-name', type: 'text', placeholder: 'recovery code',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false'
  })
  let busy = false
  const go = async () => {
    if (busy) return
    const uname = user.value.trim().toLowerCase().replace(/^@/, '')
    const secret = code.value.trim()
    if (!/^[a-z0-9_]{3,16}$/.test(uname)) { toast('Enter your @username'); user.focus(); return }
    if (secret.length < 8) { toast('Enter your recovery code'); code.focus(); return }
    busy = true; goBtn.disabled = true
    try {
      const res = await fetch(`${REGISTRY_API}/api/auth/guest/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: uname, secret })
      })
      if (!res.ok) { toast('That username and code don’t match.'); busy = false; goBtn.disabled = false; return }
      const acct = await res.json()
      // Adopt the account: its id IS the identity every room and lookup keys on.
      db.setProfile({ id: acct.userId, username: acct.username, name: acct.name || acct.username, claimSecret: secret })
      /* M7: a DIFFERENT account now owns this device. The moments answer
       * cached for the previous one — the in-memory probe result and the
       * persisted landing hint — proves nothing about this account, so
       * forget both; boot()'s probe below re-asks the server and, if this
       * account is served, the landing reconciler moves Home to Posts. */
      resetMomentsAvailability()
      db.setSettings({ momentsHome: false })
      if (acct.accountFrozen && acct.notice) toast(acct.notice)
      boot()
      offerNotifications()
      navigate('#/chat')
    } catch {
      toast('Could not reach the server — try again.')
      busy = false; goBtn.disabled = false
    }
  }
  const goBtn = el('button', { class: 'pill ok ob-go', type: 'button', text: 'Sign back in', onclick: go })
  app.appendChild(el('div', { class: 'onboard scroll-y' }, [
    el('div', { class: 'ob-inner' }, [
      el('h1', { text: 'Sign back in' }),
      el('p', { class: 'ob-lede', text: 'Your @username plus the recovery code from your Profile screen. Messages stay on the devices that hold them.' }),
      el('label', { text: 'Username' }),
      el('div', { class: 'ob-username' }, [el('span', { class: 'ob-uat', text: '@' }), user]),
      el('label', { text: 'Recovery code' }),
      code,
      goBtn,
      el('button', { class: 'linkbtn', type: 'button', text: 'Back', onclick: renderOnboarding })
    ])
  ]))
  user.focus()
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
    /* BOOT ANYWAY — a failed wipe must not leave the screen blank.
     *
     * RESETTING keeps render() and boot() standing down while the wipe runs so
     * the old profile never flashes mid-erase. It used to stay up FOREVER when
     * the wipe failed — and on a device where IndexedDB itself is broken (iOS
     * private mode throwing SecurityError, an open that never settles, another
     * tab holding a database) the wipe ALWAYS fails, so every such device sat
     * on a blank screen with no error before onboarding could ever paint. The
     * epoch is deliberately NOT stamped — the reset re-runs next load, exactly
     * like one interrupted half-way — but the app comes up: whoever is holding
     * the phone gets onboarding, or their still-unwiped data, instead of
     * nothing. The wipe itself is bounded (dropDatabase and the blobstore both
     * time out), so this branch is always reached. */
    RESETTING = false
    if (db.ready()) boot()
    render()
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
   * Relay credentials FIRST. The room transport reads the connection config once, at
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
        /* SAY WHAT ACTUALLY HAPPENED, AND SAY IT ONCE.
         *
         * This line used to read "private browsing is the usual cause" for
         * every failure mode there is — a guess, printed as a diagnosis. It was
         * wrong for an evicted store, wrong for a blocked open, wrong for a
         * full device, and there was no way to tell because the exception that
         * knew the answer had already been discarded. `identityFailure()` now
         * carries the real one.
         *
         * And it is honest about what still works: with no IndexedDB this
         * device can still send and receive for as long as the tab is open. It
         * just cannot remember any of it afterwards. Telling someone their app
         * is broken when it is merely forgetful sends them to reinstall, which
         * loses the very thing they were trying to keep. */
        const why = identityFailure()
        toast(why?.advice
          ? `${why.advice} Messages will send, but this device can’t keep them after a reload.`
          : 'This device can’t store anything. Messages will send, but nothing is kept after a reload.')
        // Greppable, PII-free, and the only place the raw reason is recorded.
        // eslint-disable-next-line no-console
        console.warn('STORAGE_UNAVAILABLE', JSON.stringify(why || {}))
      }
    })

  readyRTC().then(() => {
    rooms.connectAll()
    lobby.start()
    reach.joinInbox()
  })

  /* M6: ask the server whether Moments is served to THIS account, and add the
   * Posts tab only if it is. Fire-and-forget — the bar is already painted in
   * its production shape, so a slow or failed probe simply leaves it that way
   * rather than blocking the first frame. */
  refreshFlaggedTabs().catch(() => {})
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

/* M7: any navigation away from the cold-open landing ends the probe's licence
 * to move the screen — the person has chosen where they are, and yanking them
 * to Posts after that would be theft of control, not a default. The landing
 * write itself fires this event with an IDENTICAL hash, which is why the
 * guard compares rather than clearing unconditionally. */
window.addEventListener('hashchange', () => {
  if (coldOpenTab && window.location.hash !== coldOpenTab) { coldOpenTab = null; hintLed = false }
})

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
    // M7: Home is Posts for an account the server last said is served,
    // Chats for everyone else — which for a never-served account is exactly
    // the line that has always been here.
    coldOpenTab = homeTab()
    hintLed = coldOpenTab === '#/posts'
    window.location.hash = coldOpenTab
  }
} else if (!RESETTING && BAR_TABS.has(window.location.hash)) {
  /* M7: a bare bar-tab hash is the REMEMBERED last tab — the URL surviving a
   * reload or a restored tab — not a deeplink. A served account's cold open
   * overrides it and lands Home = Posts; for everyone else it keeps meaning
   * what it always has. Routes with params (`#/posts?m=…`), threads, and
   * every unlisted screen never enter this branch and always win. */
  coldOpenTab = window.location.hash
  if (homeTab() === '#/posts') {
    hintLed = true
    if (coldOpenTab !== '#/posts') {
      coldOpenTab = '#/posts'
      window.location.hash = coldOpenTab
    }
  }
}
render()
