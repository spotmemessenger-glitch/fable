/**
 * Spot Me — React Native side of the Bare bridge.
 *
 * The UI never imports Hypercore. It calls methods here, which become JSON
 * lines over IPC to the Bare worklet, which owns every core and socket. That
 * boundary is not stylistic: RN's JS engine cannot do raw UDP, so Hyperswarm
 * physically cannot run on this side.
 *
 * Every call is a promise resolved by a matching reply id. Unsolicited events
 * (`update`, `peer`) arrive out of band and go to subscribers.
 */
import { Worklet } from 'react-native-bare-kit'
// The `.bundle.mjs` suffix is load-bearing: bare-pack only emits a JS module
// (`export default "..."`) when the output filename ends exactly that way.
// Any other extension writes a raw binary bundle, which Metro then tries to
// parse as source and fails on with a bare "Missing semicolon".
import bundle from '../worklet/app.bundle.mjs'

/** A P2P call crossing a runtime boundary should not hang the UI forever. */
const CALL_TIMEOUT_MS = 20000

class P2P {
  #worklet = null
  #ipc = null
  #pending = new Map()
  #listeners = new Map()
  #nextId = 1
  #buffer = ''
  #started = false

  get started () {
    return this.#started
  }

  /** Boot the Bare runtime. Safe to call more than once. */
  async start () {
    if (this.#started) return

    this.#worklet = new Worklet()
    await this.#worklet.start('/app.bundle', bundle)
    this.#ipc = this.#worklet.IPC

    this.#ipc.on('data', (chunk) => this.#onData(chunk))
    this.#started = true
  }

  #onData (chunk) {
    this.#buffer += chunk.toString()

    let index
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line) continue

      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue // a truncated line is not worth tearing the bridge down
      }

      if (message.event) {
        this.#dispatch(message.event, message)
        continue
      }

      const pending = this.#pending.get(message.id)
      if (!pending) continue
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)

      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    }
  }

  #dispatch (event, payload) {
    const handlers = this.#listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) handler(payload)
  }

  /** Subscribe to `ready`, `update`, `peer` or `error`. Returns an unsubscribe. */
  on (event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set())
    this.#listeners.get(event).add(handler)
    return () => this.#listeners.get(event)?.delete(handler)
  }

  #call (cmd, args = {}) {
    if (!this.#started) return Promise.reject(new Error('p2p: start() first'))

    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`p2p: "${cmd}" timed out after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)

      this.#pending.set(id, { resolve, reject, timer })
      this.#ipc.write(JSON.stringify({ id, cmd, args }) + '\n')
    })
  }

  create (storagePath, identity) { return this.#call('create', { storagePath, identity }) }
  join (storagePath, roomKey, identity) { return this.#call('join', { storagePath, roomKey, identity }) }
  post (text, lang, opts = {}) { return this.#call('post', { text, lang, ...opts }) }
  react (target, emoji) { return this.#call('react', { target, emoji }) }
  remove (target) { return this.#call('remove', { target }) }
  invite (writerKey) { return this.#call('invite', { writerKey }) }
  transcript () { return this.#call('transcript') }
  status () { return this.#call('status') }
}

export default new P2P()
