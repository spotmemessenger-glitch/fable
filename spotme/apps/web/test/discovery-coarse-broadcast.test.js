/**
 * P0 REGRESSION GUARD — the discovery lobby must NEVER broadcast the precise
 * GPS fix. The header of discovery.js has always promised "~110 m rounding +
 * stable per-person jitter before anything leaves the device"; until this fix
 * the broadcast path sent `position.lat/lon` raw. This test drives the REAL
 * announcement path (mocked transport, stubbed geolocation) and fails if raw
 * coordinates are ever restored to the payload.
 *
 *   node --experimental-test-module-mocks test/discovery-coarse-broadcast.test.js
 */
import { mock } from 'node:test'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* --- browser globals the module graph expects ---------------------------- */
globalThis.window = { addEventListener () {}, location: { origin: 'http://localhost:5173', hostname: 'localhost' } }
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }

// A precise fix a phone would report. The exact strings must never hit the wire.
const PRECISE = { lat: 12.971598, lon: 77.594566 }

// Stub geolocation so acquirePosition() receives our precise fix synchronously.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    geolocation: {
      getCurrentPosition (ok) { ok({ coords: { latitude: PRECISE.lat, longitude: PRECISE.lon } }) },
      watchPosition () { return 1 },
      clearWatch () {}
    }
  }
})

/* --- module mocks: the lobby's real deps, minus browser/network ----------- */
const SRC = new URL('../src/', import.meta.url).href

const settings = { showOnMap: true, lastSeen: 'everyone' }
mock.module(`${SRC}lib/db.js`, {
  namedExports: {
    db: {
      ready: () => true,
      profile: () => ({ id: 'coarse-test-id', name: 'T', username: null, avatar: null, lang: 'en' }),
      settings: () => settings,
      isBlocked: () => false,
      convos: () => []
    }
  }
})
mock.module(`${SRC}net.js`, { namedExports: { RTC_CONFIG: {}, readyRTC: async () => {} } })
mock.module(`${SRC}lib/notify.js`, { namedExports: { pushNote: () => {} } })

// Fake lobby room: capture everything hello.send() puts on the wire.
const sent = []
mock.module(`${SRC}lib/transport/room.js`, {
  namedExports: {
    joinRoom: () => ({
      makeAction: () => ({ send (payload) { sent.push(payload); return Promise.resolve() } }),
      leave () {}
    })
  }
})

const { lobby, coarse } = await import(`${SRC}lib/discovery.js`)

lobby.start()
// start() defers once behind readyRTC(); let the microtask queue drain, then
// the stubbed getCurrentPosition has already applied the precise fix.
await new Promise((resolve) => setImmediate(resolve))
lobby.announce()
lobby.announce()

const payloads = sent.filter((p) => p && p.lat != null && p.lon != null)
const expected = coarse(PRECISE.lat, PRECISE.lon, 'coarse-test-id')

check('the lobby actually announced with coordinates (test is not vacuous)',
  payloads.length >= 2)

check('discovery broadcast never contains raw device coordinates',
  sent.every((p) => p.lat !== PRECISE.lat && p.lon !== PRECISE.lon &&
                    !JSON.stringify(p).includes(String(PRECISE.lat)) &&
                    !JSON.stringify(p).includes(String(PRECISE.lon))))

check('discovery broadcast equals coarse() output and is stable across calls',
  payloads.length >= 2 &&
  payloads.every((p) => p.lat === expected.lat && p.lon === expected.lon) &&
  payloads.every((p) => p.lat === payloads[0].lat && p.lon === payloads[0].lon))

check('coarse() itself moves the point (guards against a no-op helper)', (() => {
  return (expected.lat !== PRECISE.lat || expected.lon !== PRECISE.lon)
})())

// Ghost mode: flipping showOnMap off must withhold position entirely.
settings.showOnMap = false
lobby.announce()
const ghost = sent[sent.length - 1]
check('ghost mode transmits NO coordinates (lat/lon null)',
  ghost.ghost === true && ghost.lat === null && ghost.lon === null)

lobby.stop()

console.log('\n========================================')
console.log('  discovery broadcast — precise GPS never leaves the device')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
