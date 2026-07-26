/**
 * Spot Me — message alerts (web tier).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CAN HONESTLY DO
 *
 * A tone, a haptic and a system notification whenever a message arrives that
 * you are not already looking at — the tab may be in the background, behind
 * another window, or on another screen of the app. Tapping the notification
 * opens that conversation.
 *
 * WHAT IT CANNOT DO, AND WHY
 *
 * Nothing fires when Spot Me is CLOSED. That is not an oversight to be fixed
 * with more code here: messages travel directly between the two devices, so
 * with no tab open there is no connection, nothing has been received, and
 * there is nothing to announce. WhatsApp and Telegram can alert a closed app
 * because their servers hold the message and push it — the very thing this app
 * refuses to do with message content.
 *
 * Closing that gap needs the always-on relay peer (see PUSH.md and sw.js,
 * which are deliberately not wired up): it would hold undelivered messages and
 * send a CONTENTLESS push — "someone sent you something" — with the text still
 * fetched peer-to-peer once the app opens. Until that exists, promising
 * closed-app alerts in the UI would be a lie.
 * ------------------------------------------------------------------------- */
import { db } from './db.js'

/**
 * Rapid messages from one person collapse into one alert, but only just.
 *
 * The old three-minute window was borrowed from "someone is nearby" pings and
 * was badly wrong for chat: a reply two minutes into a conversation arrived in
 * silence. Messengers ding per message; this only swallows a burst typed
 * faster than a person could register two separate sounds.
 */
const MESSAGE_THROTTLE_MS = 1200

/** Presence pings are ambient, not conversational — they stay infrequent. */
export const AMBIENT_THROTTLE_MS = 3 * 60_000

const recent = new Map()   // tag -> last fired ts, so one person cannot spam

/* Held once resolved so the synchronous alert path can use it without waiting.
 * Null until the worker is active, which is why show() keeps a fallback. */
let swRegistration = null

/**
 * Bring the service worker up, so notifications land in the phone's own
 * notification tray rather than being tied to a browser tab.
 *
 * Registering it does NOT by itself deliver anything to a closed app — that
 * still needs a push service and the relay peer (see the header). What it buys
 * today is the tray on iOS, where the page-level API does not exist, and a
 * notification on Android that outlives the tab that raised it.
 */
let notifierStarted = null

export function startNotifier () {
  if (notifierStarted) return notifierStarted
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  notifierStarted = navigator.serviceWorker.register('/sw.js')
    .then(async (reg) => {
      // register() resolves before the worker controls anything; showNotification
      // needs an ACTIVE one, so wait for it rather than racing the first message.
      await navigator.serviceWorker.ready
      swRegistration = reg
      return reg
    })
    .catch(() => null)   // private mode, http, or an unsupported browser
  return notifierStarted
}

export const canNotify = () => typeof Notification !== 'undefined'

export const notifyState = () => (canNotify() ? Notification.permission : 'unsupported')

/** True when the app is running as an installed app rather than in a tab. */
export const isInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/**
 * Why notifications are unavailable, in the user's terms.
 *
 * iOS is the case worth naming: Safari grants notifications ONLY to a site
 * added to the Home Screen, and silently has no Notification API otherwise.
 * "Not supported" would read as "this phone can't", when the real answer is
 * one install away.
 */
export function notifyBlockedReason () {
  if (canNotify()) return null
  if (isIOS() && !isInstalled()) return 'ios-needs-install'
  return 'unsupported'
}

export async function enableNotify () {
  if (!canNotify()) return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    // The permission prompt is a user gesture — the one moment audio is
    // certain to be unlockable. Take it, or the first alert plays silently.
    primeAudio()
    return result
  } catch { return Notification.permission }
}

/* -------------------------------------------------------------------- sound */

/**
 * The tone is SYNTHESISED rather than loaded from a file.
 *
 * An audio file is a network request that can fail exactly when it matters
 * (offline, cold cache, flaky mobile data), and an alert that sometimes makes
 * no sound is worse than one that never does. Two short notes from an
 * oscillator always play and cost nothing to ship.
 */
let audioCtx = null

function context () {
  if (audioCtx) return audioCtx
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  if (!Ctor) return null
  try { audioCtx = new Ctor() } catch { return null }
  return audioCtx
}

/**
 * Browsers refuse to start audio until the user has interacted with the page,
 * and a message can arrive before they ever have. Resuming inside a real
 * gesture leaves the context ready for alerts that arrive later on their own.
 */
export function primeAudio () {
  const ctx = context()
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {})
}

/** Two rising notes — short, soft, and unmistakably "message". */
export function chime () {
  if (db.settings().sound === false) return
  const ctx = context()
  if (!ctx) return
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  if (ctx.state !== 'running') return   // never unlocked; stay silent, not broken
  try {
    const now = ctx.currentTime
    const bus = ctx.createGain()
    bus.connect(ctx.destination)
    for (const [at, freq] of [[0, 880], [0.11, 1320]]) {
      const osc = ctx.createOscillator()
      const voice = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + at)
      // Ramped, not switched: an abrupt start reads as a click. Peak is held
      // low deliberately — an alert should be noticeable, not startling.
      voice.gain.setValueAtTime(0.0001, now + at)
      voice.gain.exponentialRampToValueAtTime(0.16, now + at + 0.012)
      voice.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16)
      osc.connect(voice)
      voice.connect(bus)
      osc.start(now + at)
      osc.stop(now + at + 0.18)
    }
  } catch { /* audio is a courtesy — never let it break message handling */ }
}

/** A short double tap, matching the two notes. */
function buzz () {
  if (db.settings().vibrate === false) return
  try { navigator.vibrate?.([18, 60, 18]) } catch { /* not supported */ }
}

/* ------------------------------------------------------------ notifications */

function show (title, body, tag, roomId) {
  if (!canNotify() || Notification.permission !== 'granted') return
  const options = {
    body: String(body || '').slice(0, 160),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    // Same tag replaces rather than stacks — ten messages from one person
    // should be one line in the shade, not ten. renotify makes the
    // replacement still announce itself instead of updating in silence.
    renotify: Boolean(tag),
    // The tone is ours: the platform's own would double up with chime().
    silent: true,
    // Read by the worker's notificationclick handler. A path, not a bare
    // fragment: the worker may have to open a window from nothing.
    data: { url: roomId ? `/#/thread/${roomId}` : '/' }
  }

  /**
   * Prefer the SERVICE WORKER. This is not a detail:
   *
   *   - on iOS it is the only thing that works at all — Safari has no page
   *     Notification constructor, so `new Notification()` throws there and the
   *     phone shows nothing;
   *   - the notification belongs to the worker rather than to one tab, so it
   *     survives that tab being discarded and still opens the right chat;
   *   - it is the same surface a real push will use once the relay peer lands,
   *     so there will be one click path to maintain, not two.
   */
  if (swRegistration?.showNotification) {
    swRegistration.showNotification(title, options).catch(() => showInPage(title, options, roomId))
    return
  }
  // Not up yet (or not started). Show this one in-page so nothing is lost, and
  // get the worker going so every later alert takes the better path.
  startNotifier()
  showInPage(title, options, roomId)
}

/** Fallback for browsers with notifications but no usable worker. */
function showInPage (title, options, roomId) {
  try {
    const note = new Notification(title, options)
    note.onclick = () => {
      try { window.focus() } catch { /* not permitted from here */ }
      // Setting the hash rather than importing the router keeps this module
      // free of a cycle (main -> rooms -> notify -> main).
      if (roomId) window.location.hash = `#/thread/${roomId}`
      note.close()
    }
  } catch { /* blocked by the platform — the in-app bell still has it */ }
}

function throttled (tag, throttleMs) {
  if (!tag) return false
  const last = recent.get(tag) || 0
  if (Date.now() - last < throttleMs) return true
  recent.set(tag, Date.now())
  return false
}

/**
 * Ambient notice (someone nearby, a chat request). Quiet and infrequent:
 * visible only when the tab is hidden, and never worth a tone.
 */
export function pushNote (title, body, tag, { throttleMs = AMBIENT_THROTTLE_MS } = {}) {
  if (!document.hidden) return
  if (throttled(tag, throttleMs)) return
  show(title, body, tag, null)
}

/**
 * A message arrived. Alert unless the user is already looking at it.
 *
 * "Looking at it" is narrower than the old test of `document.hidden`, which
 * meant a message landing in another conversation — while you sat on the inbox,
 * or in any other chat — passed in complete silence. The thread actually on
 * screen is the only case that genuinely needs no announcement.
 */
export function alertMessage ({ roomId, title, body, muted = false }) {
  if (muted) return
  const reading = !document.hidden && db.openRoom() === roomId
  if (reading) return
  if (throttled(`msg:${roomId}`, MESSAGE_THROTTLE_MS)) return
  chime()
  buzz()
  // A system notification only means anything once the app is out of sight;
  // on screen the tone plus the growing unread badge already say it.
  if (document.hidden) show(title, body, `msg:${roomId}`, roomId)
}
