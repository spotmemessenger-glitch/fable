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
// `/api/push` derives the subscriber from the token now, not from a userId in
// the body — an unauthenticated POST there could unsubscribe anyone by id.
import { authHeaders } from './auth-headers.js'

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
/**
 * Hand the FCM/APNs token to the server.
 *
 * `register-device`, NOT `subscribe`. The controller's subscribe branch demands
 * a `subscription` object and 400s on a bare token, so sending the wrong verb
 * here breaks native push entirely while looking correct.
 *
 * Split out so the listener cleanup below can sit in a `finally` without
 * wrapping the network call in it too.
 */
async function sendToken (token, me) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      action: 'register-device',
      userId: me,
      token,
      platform: globalThis.Capacitor?.getPlatform?.() === 'ios' ? 'ios' : 'android'
    })
  })
  return { ok: response.ok, reason: response.ok ? null : 'server', native: true }
}

export async function registerNativePush () {
  const me = db.profile()?.id
  if (!me) return { ok: false, reason: 'no-profile' }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    let permission = await PushNotifications.checkPermissions()
    if (permission.receive !== 'granted') permission = await PushNotifications.requestPermissions()
    if (permission.receive !== 'granted') return { ok: false, reason: 'no-permission' }

    /* The token arrives asynchronously via an event, so registration is only
     * complete once it has been handed to the server — resolving earlier would
     * report success for a device the server still cannot reach.
     *
     * TWO FAULTS LIVED IN THE OLD FOUR LINES.
     *
     * `addListener` returns a PROMISE in plugin v6+ (this is v8). It was not
     * awaited, and `register()` fired on the next line — so the token event
     * could land before the listener existed. The only symptom was
     * `token-timeout` fifteen seconds later, which reads like a network fault
     * rather than a race, and it would come and go with device speed.
     *
     * And the handles were never removed, while `subscribePush()` documents
     * itself as safe to call repeatedly and runs from four call sites. Every
     * native call leaked two more listeners, the timeout path included.
     *
     * Cleanup removes ONLY the two handles created here — deliberately not
     * `removeAllListeners()`, which would also tear off the payload handlers
     * `attachPushHandlers` installs and silently kill foreground alerts and
     * tap-routing. That keeps the two functions order-independent. */
    const handles = []
    let timer = null
    try {
      const token = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('token-timeout')), 15000)
        Promise.all([
          PushNotifications.addListener('registration', (t) => resolve(t.value)),
          PushNotifications.addListener('registrationError',
            (e) => reject(new Error(String(e?.error || 'registration-error'))))
        ])
          .then((attached) => { handles.push(...attached); return PushNotifications.register() })
          .catch(reject)
      })
      return await sendToken(token, me)
    } finally {
      clearTimeout(timer)
      await Promise.all(handles.map((h) => h?.remove?.())).catch(() => {})
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error?.name || 'failed') }
  }
}

/**
 * Consume the push payload — the half that was never built.
 *
 * `PushService.notifyNative` attaches `data:{title,body,tag}` to every FCM
 * message, with the comment "the data block rides along so the app can route
 * the tap when it IS alive", and `tag` IS the roomId. Nothing ever read it, so
 * two states did nothing at all:
 *
 *   FOREGROUND — Android hands a notification to the running app instead of
 *   drawing it in the tray, so an arriving message showed NOTHING while Spot Me
 *   was open.
 *   TAP — opening a tray notification launched the app on whatever screen it
 *   was last on, never the chat the notification was about.
 *
 * Idempotent: called on every launch, attaches once. Web push does not come
 * through here — the service worker owns those events (public/sw.js).
 */
let handlersAttached = false

export async function attachPushHandlers ({ onForeground, onOpenRoom } = {}) {
  if (!isNative() || handlersAttached) return false
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.addListener('pushNotificationReceived', (n) => {
      onForeground?.({
        title: n?.title || 'New message',
        body: n?.body || '',
        roomId: n?.data?.tag || null
      })
    })
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const roomId = a?.notification?.data?.tag
      if (roomId) onOpenRoom?.(roomId)
    })
    handlersAttached = true
    return true
  } catch {
    // A missing plugin must never stop boot; push simply stays silent.
    return false
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
      headers: await authHeaders(),
      body: JSON.stringify({
        action: 'subscribe',
        userId: me,
        /* THE KEYS MUST TRAVEL. This used to send the endpoint alone, on the
         * stated grounds that "the p256dh/auth keys are for encrypting
         * payloads, and there are none" — which is simply not true of this
         * server: `notifyWeb` sends `JSON.stringify({title, body, tag})` as a
         * real body, so web-push encrypts it and needs both halves.
         *
         * `PushService.subscribe` therefore threw `incomplete subscription` on
         * EVERY browser registration, which is why production has never held a
         * single web-push subscription. `toJSON()` is the spec-defined shape:
         * { endpoint, expirationTime, keys: { p256dh, auth } }. */
        subscription: subscription.toJSON()
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
    headers: await authHeaders(),
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
  // Still fire-and-forget, just with the token attached — hence the .then
  // rather than an await, which this function's signature cannot take.
  authHeaders().then((headers) => fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'notify', toUserId: userId })
  })).catch(() => {})
}
