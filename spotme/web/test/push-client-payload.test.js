/**
 * Proves the CLIENT half of push sends what the server actually accepts, and
 * consumes what the server actually sends.
 *
 * `test/push.test.js` covers `api/push.js` — the VAPID signing on the server
 * side. Nothing covered `lib/push.js`, and three defects lived there
 * undisturbed through every green run:
 *
 *   1. `subscribe` sent `{endpoint}` alone while `PushService.subscribe`
 *      requires `keys.p256dh` and `keys.auth`, so every browser registration
 *      was rejected with 'incomplete subscription'. Production has never held
 *      one web-push subscription.
 *   2. `addListener` returns a PROMISE in plugin v6+ and was not awaited before
 *      `register()` fired, so the token event could be missed — surfacing as a
 *      15-second `token-timeout` that looked like a network fault.
 *   3. Nothing listened for `pushNotificationReceived` or
 *      `pushNotificationActionPerformed`, so a push arriving with the app open
 *      displayed nothing and a tray tap never opened the chat.
 *
 * Two of these are also REGRESSION GUARDS against plausible-looking fixes: using
 * `action:'subscribe'` for a native token 400s, and calling `removeAllListeners`
 * during registration silently tears off the payload handlers.
 *
 *   node --experimental-test-module-mocks --no-warnings test/push-client-payload.test.js
 */
import { mock } from 'node:test'

globalThis.window = {
  addEventListener () {},
  location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/', hostname: 'localhost', pathname: '/', protocol: 'http:', host: 'localhost:5173' }
}
globalThis.location = globalThis.window.location
globalThis.document = { addEventListener () {}, visibilityState: 'visible', hidden: false }
globalThis.localStorage = {
  _d: new Map(),
  getItem (k) { return this._d.get(k) ?? null },
  setItem (k, v) { this._d.set(k, String(v)) },
  removeItem (k) { this._d.delete(k) },
  key (i) { return [...this._d.keys()][i] ?? null },
  get length () { return this._d.size }
}

const SRC = '../src/lib/'
const ME = 'u_push_test'

mock.module(`${SRC}db.js`, {
  namedExports: { db: { profile: () => ({ id: ME }) }, ROOM_PREFIX: 'spotme:room:' }
})
mock.module(`${SRC}api.js`, { namedExports: { API_BASE: 'https://api.test' } })
mock.module(`${SRC}auth-headers.js`, {
  namedExports: { authHeaders: async () => ({ 'content-type': 'application/json', authorization: 'Bearer t' }) }
})

/* The Capacitor plugin, faked so the ORDER of attach-vs-register is observable.
 * addListener resolves asynchronously exactly as the real one does; a token is
 * only delivered to listeners that have actually been attached, which is the
 * whole substance of defect 2. */
const plugin = {
  events: [],
  listeners: new Map(),
  removeAllCalled: 0,
  removed: 0,
  permission: 'granted',
  reset () {
    this.events = []; this.listeners = new Map()
    this.removeAllCalled = 0; this.removed = 0
  },
  async checkPermissions () { return { receive: this.permission } },
  async requestPermissions () { return { receive: this.permission } },
  async addListener (name, cb) {
    await Promise.resolve()                   // v6+ returns a promise; so do we
    this.events.push(`attach:${name}`)
    this.listeners.set(name, cb)
    return { remove: async () => { plugin.removed += 1; plugin.listeners.delete(name) } }
  },
  async removeAllListeners () { this.removeAllCalled += 1; this.listeners.clear() },
  async register () {
    this.events.push('register')
    // Deliver to whoever is listening AT THIS MOMENT — nobody, if the code
    // failed to await its addListener calls.
    this.listeners.get('registration')?.({ value: 'fake-fcm-token' })
  },
  emit (name, payload) { this.listeners.get(name)?.(payload) }
}
mock.module('@capacitor/push-notifications', { namedExports: { PushNotifications: plugin } })

/* Network: GET returns the push config, POST is recorded. */
const posts = []
globalThis.fetch = async (url, init) => {
  if (!init || init.method !== 'POST') {
    return { ok: true, json: async () => ({ enabled: true, native: true, publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' }) }
  }
  posts.push(JSON.parse(init.body))
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

const push = await import(`${SRC}push.js`)

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const asNative = (on) => {
  globalThis.Capacitor = on ? { isNativePlatform: () => true, getPlatform: () => 'android' } : undefined
}

/* ============ 1. web subscribe must carry the encryption keys ============= */

asNative(false)
globalThis.Notification = { permission: 'granted' }
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  toJSON: () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    expirationTime: null,
    keys: { p256dh: 'P256DH_VALUE', auth: 'AUTH_VALUE' }
  })
}
// Node 22 exposes `navigator` as a getter-only global, so it is redefined
// rather than assigned — assignment throws before a single check runs.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }) } }
})
globalThis.window.PushManager = function () {}

posts.length = 0
const webResult = await push.subscribePush()
const webBody = posts.find((p) => p.action === 'subscribe')

check('a web subscribe is sent at all', Boolean(webBody))
check('THE BUG: it carries p256dh — the server rejects the subscription without it',
  webBody?.subscription?.keys?.p256dh === 'P256DH_VALUE')
check('...and auth, the other half web-push needs to encrypt the payload',
  webBody?.subscription?.keys?.auth === 'AUTH_VALUE')
check('the endpoint still travels', webBody?.subscription?.endpoint?.includes('fcm.googleapis.com') === true)
check('and the caller still gets the {ok, reason} contract it has always had',
  webResult?.ok === true && 'reason' in webResult)

/* ============ 2. native token: right verb, right order, no leak =========== */

asNative(true)
plugin.reset()
posts.length = 0
const nativeResult = await push.registerNativePush()
const nativeBody = posts.find((p) => p.token)

check('a native registration is sent', Boolean(nativeBody))
check('REGRESSION GUARD: the verb is register-device, not subscribe',
  nativeBody?.action === 'register-device')
check('...because the subscribe branch demands a subscription object and 400s on a token',
  nativeBody?.action !== 'subscribe')
check('the token reaches the server', nativeBody?.token === 'fake-fcm-token')
check('the platform is reported', nativeBody?.platform === 'android')
check('native keeps the {ok, reason} contract too',
  nativeResult?.ok === true && nativeResult?.native === true)

check('THE RACE: both listeners are attached BEFORE register() fires',
  plugin.events.indexOf('register') > plugin.events.indexOf('attach:registration') &&
  plugin.events.indexOf('register') > plugin.events.indexOf('attach:registrationError'))

check('THE LEAK: both handles are removed once registration finishes',
  plugin.removed === 2)

check('REGRESSION GUARD: removeAllListeners is NOT used — it would tear off the payload handlers',
  plugin.removeAllCalled === 0)

/* a second call must not accumulate listeners — subscribePush runs on every launch */
plugin.reset()
await push.registerNativePush()
await push.registerNativePush()
check('repeated registration leaves nothing behind', plugin.listeners.size === 0)

/* ============ 3. the payload is consumed, foreground and on tap ========== */

plugin.reset()
const seen = { foreground: null, opened: null }

/* Called through a guard so that running this file against the PRE-FIX module —
 * where the export does not exist at all — produces a scoreboard of what is
 * missing instead of a TypeError that hides the other twenty checks. */
const hasAttach = typeof push.attachPushHandlers === 'function'
const attachSafe = async (opts) => (hasAttach ? push.attachPushHandlers(opts) : false)

check('attachPushHandlers is exported', hasAttach)

const attached = await attachSafe({
  onForeground: (n) => { seen.foreground = n },
  onOpenRoom: (roomId) => { seen.opened = roomId }
})

check('handlers attach on native', attached === true)
check('a foreground push is delivered to the app', (() => {
  plugin.emit('pushNotificationReceived', { title: 'Spot Me', body: 'New message', data: { tag: 'room-42' } })
  return seen.foreground?.title === 'Spot Me' && seen.foreground?.body === 'New message'
})())
check('...carrying the roomId from data.tag, which is what routes it',
  seen.foreground?.roomId === 'room-42')
check('a tray tap opens the room the notification was about', (() => {
  plugin.emit('pushNotificationActionPerformed', { notification: { data: { tag: 'room-99' } } })
  return seen.opened === 'room-99'
})())
check('a tap with no room does not route anywhere', (() => {
  seen.opened = null
  plugin.emit('pushNotificationActionPerformed', { notification: { data: {} } })
  return seen.opened === null
})())
check('attaching twice does not double-register — boot runs on every launch',
  (await attachSafe({})) === false)

asNative(false)
check('a browser tab attaches nothing: the service worker owns those events',
  (await attachSafe({})) === false)

console.log('\n========================================')
console.log('  push client — payload in, payload out')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
