/**
 * Spot Me — push subscription (client half).
 *
 * The server half is api/push.js; read its header first — it explains why a
 * push here carries no message text.
 *
 * ---------------------------------------------------------------------------
 * HOW A CLOSED PHONE GETS ALERTED WITHOUT A SERVER HOLDING MESSAGES
 *
 * Nothing server-side knows a message exists — that is the whole design. So
 * the SENDER raises the alarm: when a message cannot be handed to a live peer,
 * the sender's own device asks the server to poke the recipient's phone. The
 * recipient opens Spot Me, the peer connection forms, and the message arrives
 * directly, as it always would have.
 *
 * THE LIMIT THIS LEAVES, SAID OUT LOUD
 *
 * The poke can only happen while the SENDER still has the app open. If Alice
 * writes and immediately closes Spot Me, Bob's phone lights up but the message
 * waits until they are both online again. Closing that last gap needs the
 * always-on relay peer; this is the honest most a pure peer-to-peer app can
 * do, and it is a great deal better than silence.
 * ------------------------------------------------------------------------- */
import { db } from './db.js'

import { API_BASE as API_ORIGIN } from './api.js'

const ENDPOINT = `${API_ORIGIN}/api/push`

/** Server config, fetched once — the key can be rotated without a rebuild. */
let configPromise = null

function config () {
  if (!configPromise) {
    configPromise = fetch(ENDPOINT)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return configPromise
}

/** True when the deployment actually has keys and a store behind it. */
export const pushAvailable = async () => Boolean((await config())?.enabled || (await config())?.native)

/** Running inside the Capacitor shell rather than a browser tab.
 *  Exported because callers must NOT gate push on `Notification.permission`:
 *  that object does not exist in the WebView, so a browser-shaped guard skips
 *  native registration entirely and the phone is never wakeable. */
export const isNative = () => Boolean(globalThis.Capacitor?.isNativePlatform?.())

/**
 * Native push (FCM on Android, APNs on iOS).
 *
 * The packaged app cannot use Web Push — its WebView exposes no PushManager
 * and no Notification API — so this is the ONLY way a closed phone gets woken.
 * The plugin is imported lazily so the browser build never pulls in native
 * code it cannot run.
 */
export async function registerNativePush () {
  const me = db.profile()?.id
  if (!me) return { ok: false, reason: 'no-profile' }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    let permission = await PushNotifications.checkPermissions()
    if (permission.receive !== 'granted') permission = await PushNotifications.requestPermissions()
    if (permission.receive !== 'granted') return { ok: false, reason: 'no-permission' }

    // The token arrives asynchronously via an event, so registration is only
    // complete once it has been handed to the server — resolving earlier would
    // report success for a device the server still cannot reach.
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('token-timeout')), 15000)
      PushNotifications.addListener('registration', (t) => { clearTimeout(timer); resolve(t.value) })
      PushNotifications.addListener('registrationError', (e) => { clearTimeout(timer); reject(new Error(String(e?.error || 'registration-error'))) })
      PushNotifications.register()
    })

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'register-device',
        userId: me,
        token,
        platform: globalThis.Capacitor?.getPlatform?.() === 'ios' ? 'ios' : 'android'
      })
    })
    return { ok: response.ok, reason: response.ok ? null : 'server', native: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error?.name || 'failed') }
  }
}

/** applicationServerKey wants raw bytes, not the base64url the server sends. */
function decodeKey (base64url) {
  const padded = (base64url + '='.repeat((4 - base64url.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/**
 * Register this device to be woken.
 *
 * Safe to call repeatedly: an existing subscription is REUSED rather than
 * churned, because subscribing afresh invalidates the endpoint the server
 * holds and would quietly break alerts until the next call.
 */
export async function subscribePush () {
  // Inside the packaged app there is no Push API at all — the WebView has no
  // PushManager and no Notification (verified on-device). Web Push cannot work
  // there under any configuration, so the native path is the whole story.
  if (isNative()) return registerNativePush()

  const settings = await config()
  if (!settings?.publicKey || !settings.enabled) return { ok: false, reason: 'not-configured' }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' }
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { ok: false, reason: 'no-permission' }
  }
  const me = db.profile()?.id
  if (!me) return { ok: false, reason: 'no-profile' }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
      || await registration.pushManager.subscribe({
        // Chrome refuses a subscription without this: a push that could show
        // nothing is a push that can be used to track silently.
        userVisibleOnly: true,
        applicationServerKey: decodeKey(settings.publicKey)
      })
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'subscribe',
        userId: me,
        // Only the endpoint travels. The p256dh/auth keys in the subscription
        // are for encrypting payloads, and there are none.
        subscription: { endpoint: subscription.endpoint }
      })
    })
    return { ok: response.ok, reason: response.ok ? null : 'server' }
  } catch (error) {
    return { ok: false, reason: String(error?.name || 'failed') }
  }
}

/** Stop being woken on this device. */
export async function unsubscribePush () {
  const me = db.profile()?.id
  try {
    const registration = await navigator.serviceWorker?.ready
    const subscription = await registration?.pushManager?.getSubscription()
    await subscription?.unsubscribe()
  } catch { /* already gone */ }
  if (!me) return
  await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unsubscribe', userId: me })
  }).catch(() => {})
}

/**
 * Ask the server to wake someone whose device we could not reach directly.
 *
 * Fire-and-forget on purpose: a message must never wait on, or fail because
 * of, a courtesy notification. The server rate-limits per recipient, so a
 * burst of messages cannot become a burst of buzzes.
 */
export function pokePeer (userId) {
  if (!userId) return
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'notify', toUserId: userId })
  }).catch(() => {})
}
