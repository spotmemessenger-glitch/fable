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

const API_ORIGIN = (location.hostname === 'localhost' || /^[\d.:[\]]+$/.test(location.hostname))
  ? 'https://spotme-messenger.vercel.app'
  : ''

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
export const pushAvailable = async () => Boolean((await config())?.enabled)

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
