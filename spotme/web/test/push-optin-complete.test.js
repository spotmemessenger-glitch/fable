/**
 * Proves every path that ASKS for notification permission also SUBSCRIBES.
 *
 * THE BUG THIS PINS, and why the test is structural rather than behavioural.
 * Being reachable takes two steps: `enableNotify()` gets the browser
 * permission, which lets a running tab raise a notification, and
 * `subscribePush()` registers the endpoint that lets the SERVER wake a closed
 * app. Two of the three opt-in paths did both. The third — the "Turn on device
 * notifications" button on the Alerts screen, which is the most discoverable
 * one — stopped at the permission.
 *
 * So a user tapped a button captioned "alerted even from a background tab",
 * granted permission, saw the button disappear because `notifyState()` was now
 * 'granted', and was never subscribed. `main.js` re-claims the subscription at
 * boot, so it repaired itself on the NEXT launch — which on an installed PWA
 * can be days, and which is invisible either way. Production held zero web-push
 * subscriptions.
 *
 * The defect is not in any function's logic; each one is correct. It is that a
 * call site was added without the follow-through, so what has to be pinned is
 * the RELATIONSHIP between the two calls — a behavioural test of either
 * function alone passes against the bug, which is exactly how it shipped.
 *
 *   node test/push-optin-complete.test.js
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname: on Windows the latter yields "/C:/…", which
// join() turns into the non-existent "C:\C:\…" and the whole chain dies here.
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function jsFiles (dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...jsFiles(full))
    // Forward slashes even on Windows, so the endsWith('/lib/notify.js')
    // exclusion and the rel() names below mean the same thing everywhere.
    else if (entry.endsWith('.js')) out.push(full.replace(/\\/g, '/'))
  }
  return out
}

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* Every file that CALLS enableNotify — the definition in notify.js is not a
 * call site, and neither is a bare import. */
const callers = jsFiles(SRC).filter((f) => {
  if (f.endsWith('/lib/notify.js')) return false
  return /enableNotify\s*\(/.test(readFileSync(f, 'utf8'))
})

const rel = (f) => f.slice(SRC.length)

check('there is at least one opt-in path to check', callers.length > 0)

for (const file of callers) {
  const source = readFileSync(file, 'utf8')
  check(
    `${rel(file)} asks for permission AND subscribes to push`,
    /subscribePush\s*\(/.test(source)
  )
}

/* The import has to be real too — a call to an unimported name is a
 * ReferenceError at runtime, which in an onclick handler is swallowed by the
 * console nobody is reading. */
for (const file of callers) {
  const source = readFileSync(file, 'utf8')
  check(
    `${rel(file)} actually imports subscribePush`,
    /import\s*\{[^}]*\bsubscribePush\b[^}]*\}\s*from/.test(source)
  )
}

/* The Alerts screen is called out by name: it is the path that was missing,
 * and the most discoverable of the three, so a regression there is the one
 * that would go unnoticed longest. */
const alerts = callers.find((f) => f.endsWith('/views/notifications.js'))
check('the Alerts-screen opt-in is one of the paths covered', Boolean(alerts))

console.log('\n========================================')
console.log('  push opt-in — permission is only half of it')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
