/**
 * BOOT MUST NOT BLOCK ON INDEXEDDB — the iOS-private-mode blank screen.
 *
 * THE BUG THIS PINS. A device whose localStorage lacks the reset epoch (every
 * FIRST visit, and all of iOS private mode) takes the `RESETTING` path:
 * render() and boot() stand down while `maybeFreshStart()` awaits
 * `wipeDevice()`. On a device where IndexedDB is broken — `open()` throwing
 * SecurityError, an open that never settles, `blocked` from another tab — the
 * wipe ALWAYS reports failure, and the failure branch used to just toast and
 * return. Nothing ever lifted RESETTING, so render() stood down FOREVER:
 * blank screen, no console error, no paint. Onboarding never had a chance.
 *
 * All three failure shapes converge on the same `!wiped.ok` branch (the wipe
 * itself is bounded — storage-degrade.test.js already pins that a hung open
 * settles), so ONE shape through the REAL main.js is the fence: the throwing
 * shape, which is the iOS lockdown one. This boots the actual module graph
 * with a minimal DOM and asserts a person sees onboarding, not a void.
 *
 *   node test/boot-blank-screen.test.js
 */

import { registerHooks } from 'node:module'

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

/* main.js imports its stylesheets and reads `import.meta.env`; Node has
 * neither. Stub the .css modules and rewrite the Vite-only env object — both
 * are build-tool surface, not app behaviour. */
registerHooks({
  load (url, context, nextLoad) {
    if (url.split('?')[0].endsWith('.css')) {
      return { format: 'module', source: 'export default {}', shortCircuit: true }
    }
    const out = nextLoad(url, context)
    if (url.includes('/src/') && url.split('?')[0].endsWith('.js') && out.source) {
      const source = out.source.toString().replaceAll('import.meta.env', '(globalThis.__VITE_ENV__ ?? {})')
      return { ...out, source }
    }
    return out
  }
})

/* ---- the DOM surface ui.js and renderOnboarding actually touch ---------- */
class FakeNode {
  constructor (tag) {
    this.tagName = String(tag || '').toUpperCase()
    this.children = []
    this.childNodes = []
    this.parentNode = null
    this.attributes = {}
    this.dataset = {}
    this.style = { cssText: '', display: '' }
    this.className = ''
    this.textContent = ''
    this.innerHTML = ''
    this.value = ''
    this.disabled = false
    this.classList = { add () {}, remove () {}, toggle () {}, contains: () => false }
  }
  appendChild (c) { c.parentNode = this; this.children.push(c); this.childNodes.push(c); return c }
  removeChild (c) {
    this.children = this.children.filter((x) => x !== c)
    this.childNodes = this.childNodes.filter((x) => x !== c)
    c.parentNode = null
    return c
  }
  get firstChild () { return this.childNodes[0] || null }
  get firstElementChild () { return this.children[0] || null }
  remove () { this.parentNode?.removeChild(this) }
  replaceWith (n) {
    const p = this.parentNode
    if (!p) return
    const i = p.children.indexOf(this)
    p.children[i] = n
    const j = p.childNodes.indexOf(this)
    p.childNodes[j] = n
    n.parentNode = p
    this.parentNode = null
  }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  removeAttribute (k) { delete this.attributes[k] }
  getAttribute (k) { return k in this.attributes ? this.attributes[k] : null }
  addEventListener () {}
  removeEventListener () {}
  querySelector () { return null }
  querySelectorAll () { return [] }
  contains () { return false }
  focus () {}
  click () {}
}

const app = new FakeNode('div')

globalThis.document = {
  body: new FakeNode('body'),
  documentElement: new FakeNode('html'),
  hidden: false,
  getElementById: (id) => (id === 'app' ? app : new FakeNode('div')),
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = t; return n },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener () {},
  removeEventListener () {}
}

const winListeners = {}
const location = {
  href: 'http://localhost/',
  search: '',
  get hash () { return this._h || '' },
  set hash (v) {
    const next = String(v).startsWith('#') ? String(v) : `#${v}`
    if (next === this._h) return
    this._h = next
    this.href = `http://localhost/${next}`
    queueMicrotask(() => (winListeners.hashchange || []).forEach((fn) => fn({})))
  },
  reload () {},
  replace () {}
}
globalThis.window = {
  location,
  addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn) },
  removeEventListener () {},
  matchMedia: () => ({ matches: false, addEventListener () {}, removeEventListener () {} }),
  setTimeout,
  clearTimeout
}

/* EMPTY localStorage: no epoch stamp, which is exactly what puts a first
 * visit (and every iOS-private-mode visit) on the RESETTING path. */
globalThis.localStorage = {
  _m: new Map(),
  get length () { return this._m.size },
  key (i) { return [...this._m.keys()][i] ?? null },
  getItem (k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem (k, v) { this._m.set(k, String(v)) },
  removeItem (k) { this._m.delete(k) }
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'node-test',
    language: 'en',
    storage: { persist: async () => false, estimate: async () => ({ quota: 0, usage: 0 }), persisted: async () => false }
  }
})

/* The iOS lockdown shape: the API exists and every call on it THROWS. */
const insecure = () => Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' })
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: {
    open () { throw insecure() },
    deleteDatabase () { throw insecure() }
  }
})

/* No network in this test — anything that reaches out gets a clean refusal. */
globalThis.fetch = async () => { throw new Error('offline (test)') }

console.log('\n========================================')
console.log('  boot without IndexedDB paints onboarding')
console.log('========================================')

await import('../src/main.js')

/* The wipe fails fast in the throwing shape; give the resume a generous
 * window anyway. Against the unfixed code this loop runs out with app empty. */
const deadline = Date.now() + 4000
while (Date.now() < deadline && app.children.length === 0) {
  await new Promise((r) => setTimeout(r, 25))
}

check('SOMETHING paints — the app is not a blank screen', app.children.length > 0)
check('…and it is onboarding, the screen a fresh device must reach',
  /\bonboard\b/.test(app.firstElementChild?.className || ''))
check('the reset is NOT stamped done — it re-runs next load like any interrupted wipe',
  localStorage.getItem('spotme:epoch') === null)

console.log('\n========================================')
console.log(`  ${pass}/${pass + fail} passed`)
console.log('========================================\n')

process.exit(fail > 0 ? 1 : 0)
