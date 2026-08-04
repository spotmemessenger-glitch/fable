/**
 * ADR-032 — Turnstile client half: the presence gate and the not-shipped
 * posture. This runs in BARE NODE (no DOM, no vite define), which is itself
 * the proof of structural bypass: with no TURNSTILE_SITE_KEY every export
 * must be an inert no-op that never touches document or the network.
 *
 *   node test/turnstile-gate.test.js
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const { turnstileSiteKey, turnstileEnabled, turnstileToken, withTurnstileHeader, mountTurnstile, TURNSTILE_HEADER } =
  await import('../src/lib/turnstile.js')

/* --- 1. structural bypass without a key (and without a DOM) -------------- */

check('no site key: turnstileSiteKey() is empty', turnstileSiteKey() === '')
check('no site key: turnstileEnabled() is false', turnstileEnabled() === false)
check('no site key: turnstileToken() resolves null', (await turnstileToken()) === null)
check('no site key: mountTurnstile() is a no-op returning null', (await mountTurnstile({})) === null)
check('no script tag side effects: module import left no globals behind', !globalThis.turnstile)

/* --- 2. the header contract --------------------------------------------- */

check('header name matches the backend gate', TURNSTILE_HEADER === 'cf-turnstile-response')
{
  const h = withTurnstileHeader({ 'Content-Type': 'application/json' }, null)
  check('null token: header object is untouched', !(TURNSTILE_HEADER in h) && h['Content-Type'] === 'application/json')
  const h2 = withTurnstileHeader({}, 'tok-1')
  check('token present: header attached', h2[TURNSTILE_HEADER] === 'tok-1')
}

/* --- 3. not-shipped fence over the source tree --------------------------- */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.js$/.test(entry)) out.push(full)
  }
  return out
}
const srcBodies = walk(join(ROOT, 'src')).map((f) => ({ f, body: readFileSync(f, 'utf8') }))

// The secret key name belongs to the SERVER only — it must never appear in
// client source (the client sees only the publishable site key name).
check('no TURNSTILE_SECRET_KEY reference anywhere in web src',
  srcBodies.every(({ body }) => !body.includes('TURNSTILE_SECRET_KEY')))

// No secret-shaped literal: the site key arrives via the build define, never
// hardcoded. (0x4AAA… is the shape of real Turnstile site keys.)
check('no hardcoded turnstile key literal in web src',
  srcBodies.every(({ body }) => !/0x4[A-Za-z0-9_-]{20,}/.test(body)))

// The wiring exists (fence is not vacuous): onboarding mounts the widget and
// guest auth attaches the header.
check('onboarding mounts the widget host',
  readFileSync(join(ROOT, 'src/main.js'), 'utf8').includes('mountTurnstile(turnstileHost)'))
check('guest auth attaches the token header',
  readFileSync(join(ROOT, 'src/lib/socket-transport.js'), 'utf8').includes('withTurnstileHeader'))

/* --- report -------------------------------------------------------------- */

let failed = 0
for (const name of names) {
  const ok = results[name]
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
console.log(`turnstile-gate: ${names.length - failed}/${names.length} passed`)
process.exit(failed === 0 ? 0 : 1)
