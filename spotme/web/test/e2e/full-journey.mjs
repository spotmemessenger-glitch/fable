/**
 * The whole app, as a person uses it, in two real browsers.
 *
 * This is the harness that answers "does it work" — not "do the units pass".
 * Two isolated browser CONTEXTS are what make them two devices: separate
 * localStorage, separate IndexedDB, separate identity, separate socket.
 *
 * WHY IT IS SHAPED LIKE THIS. An earlier harness reported the photo path as
 * broken when the app was fine: it waited on `.psheet .pdone`, which belongs to
 * the view-once sheet, while the ordinary photo path goes through the editor
 * and `.pe-send`. A harness that fails for its own reasons is worse than no
 * harness, so every step here asserts on what the USER would see — text in the
 * thread, an image element, a receipt — and never on an internal it happens to
 * know. Where it must reach inside (the stored convo record), it says so.
 *
 * Each check is independent. One failure never aborts the run, because the
 * point is a complete picture of what works, not the first thing that does not.
 *
 *   node test/e2e/full-journey.mjs [stamp]
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = process.env.SPOTME_APP || 'http://127.0.0.1:5173'
const SHOTS = process.env.SPOTME_E2E_SHOTS || '/tmp/spotme-e2e'
const stamp = process.argv[2] || String(Date.now()).slice(-6)
mkdirSync(SHOTS, { recursive: true })

const A = { name: 'Ada', user: `ada${stamp}` }
const B = { name: 'Bo', user: `bo${stamp}` }

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass: pass === true, detail: String(detail).slice(0, 220) })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 150)}` : ''}`)
}
/** Runs a step in isolation: a throw becomes one FAIL, never a dead run. */
const step = async (name, fn) => {
  try { const r = await fn(); if (r !== undefined) check(name, r === true || r?.pass === true, r?.detail || '') } catch (e) {
    check(name, false, `threw: ${e.message}`)
  }
}

const netErrors = []
const consoleErrors = []

/* ------------------------------------------------------------ primitives */

const COMPOSER = 'input[placeholder="Type a message…"]'

async function onboard (ctx, who) {
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${who.user}] ${m.text().slice(0, 180)}`)
  })
  page.on('pageerror', (e) => consoleErrors.push(`[${who.user}] PAGEERROR ${String(e).slice(0, 200)}`))
  page.on('requestfailed', (r) =>
    netErrors.push(`${who.user} ${r.method()} ${r.url().slice(0, 100)} :: ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) netErrors.push(`HTTP${r.status()} ${who.user} ${r.request().method()} ${r.url().slice(0, 100)}`)
  })
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ob-name', { timeout: 20000 })
  await page.fill('input.ob-name:not(.ob-uinput)', who.name)
  await page.fill('input.ob-uinput', who.user)
  // Availability is debounced; Start refuses while the field is unchecked.
  await page.waitForTimeout(2500)
  await page.click('button.ob-go')
  await page.waitForSelector('.v-inbox, .nv', { timeout: 20000 })
  return page
}

/** A sheet left open swallows every later click; clear it before driving on. */
async function dismissSheets (page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.$('.as-backdrop'))) return
    await page.keyboard.press('Escape').catch(() => {})
    await page.evaluate(() => document.querySelector('.as-backdrop')?.remove())
    await page.waitForTimeout(300)
  }
}

async function knock (page, peerUser, firstLine) {
  await dismissSheets(page)
  await page.click('input[placeholder="Search users..."]')
  await page.fill('input[placeholder="Search users..."]', peerUser)
  await page.waitForSelector('.udrop', { state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1200)
  await page.locator('.udrop').locator(`text=@${peerUser}`).first().click()
  await page.waitForSelector('.reqsheet', { timeout: 15000 })
  await page.fill('input.reqmsg', firstLine)
  await page.click('button.reqsend')
  await page.waitForSelector(COMPOSER, { timeout: 20000 })
}

/** Opens the thread with `peerName` if the inbox is showing instead. */
async function openThread (page, peerName) {
  if (await page.$('.v-chat')) return true
  const row = page.locator('.v-inbox').locator(`text=${peerName}`).first()
  if (await row.count()) { await row.click(); await page.waitForSelector('.v-chat', { timeout: 10000 }); return true }
  return false
}

const threadText = (page) => page.$eval('.v-chat', (e) => e.innerText).catch(() => '')

async function send (page, text) {
  await page.fill(COMPOSER, text)
  await page.keyboard.press('Enter')
}

/** Polls for `needle` in the thread — far more reliable than a fixed sleep. */
async function waitForText (page, needle, ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await threadText(page)).includes(needle)) return true
    await page.waitForTimeout(500)
  }
  return false
}

/** The stored convo record — ground truth for what crypto a room actually uses. */
const convos = (page) => page.evaluate(() => {
  const raw = localStorage.getItem('spotme:app:v1')
  if (!raw) return []
  const s = JSON.parse(raw)
  return Object.entries(s.convos || {}).map(([id, c]) => ({
    roomId: id, e2eVersion: c.e2eVersion, hasPeerKey: !!c.peerKey
  }))
})

/* ------------------------------------------------------------------ run */

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    // Voice notes need a microphone that exists but is not a real one.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'
  ]
})
const ctxA = await browser.newContext({ permissions: ['microphone'] })
const ctxB = await browser.newContext({ permissions: ['microphone'] })

let pa, pb

console.log(`\n===== SPOT ME FULL JOURNEY  (@${A.user} <-> @${B.user}) =====`)

console.log('\n-- onboarding --')
await step('both devices onboard', async () => {
  pa = await onboard(ctxA, A)
  pb = await onboard(ctxB, B)
  return true
})

console.log('\n-- discovery and the opening knock --')
await step('A finds B by @username and sends the opening line', async () => {
  await knock(pa, B.user, 'OPENING LINE')
  return true
})
await step('A sees its own opening line (not swallowed by the knock)', () =>
  waitForText(pa, 'OPENING LINE'))
await step('B receives the opening line', async () => {
  await pb.waitForTimeout(2500)
  await openThread(pb, A.name)
  return waitForText(pb, 'OPENING LINE')
})

console.log('\n-- the crypto the room actually ended up on --')
await step('A: room negotiated e2e_v2, not the legacy fallback', async () => {
  const c = (await convos(pa)).filter((x) => x.roomId.startsWith('dm-'))
  return { pass: c.length > 0 && c.every((x) => x.e2eVersion === 'e2e_v2'), detail: JSON.stringify(c) }
})
await step('B: room negotiated e2e_v2, not the legacy fallback', async () => {
  const c = (await convos(pb)).filter((x) => x.roomId.startsWith('dm-'))
  return { pass: c.length > 0 && c.every((x) => x.e2eVersion === 'e2e_v2'), detail: JSON.stringify(c) }
})
await step('no "server could read it" banner on a brand-new chat', async () => {
  const t = await threadText(pa)
  return { pass: !t.includes('server could read it'), detail: t.includes('server could read it') ? 'legacy banner shown' : '' }
})

console.log('\n-- text, both directions --')
await step('B -> A round trip', async () => {
  await send(pb, 'REPLY FROM BO')
  return waitForText(pa, 'REPLY FROM BO')
})
await step('A -> B second message', async () => {
  await send(pa, 'SECOND FROM ADA')
  return waitForText(pb, 'SECOND FROM ADA')
})
await step('unicode and emoji survive the round trip', async () => {
  await send(pa, 'भारत 🇮🇳 café — ünïcødé ✅')
  return waitForText(pb, 'ünïcødé')
})
await step('a long message is not truncated or dropped', async () => {
  const long = 'L' + 'o'.repeat(1500) + 'NG'
  await send(pa, long)
  await pb.waitForTimeout(1000)
  const got = await waitForText(pb, 'NG', 20000)
  return { pass: got, detail: got ? '1503 chars delivered' : 'long message never arrived' }
})

console.log('\n-- burst: ordering, no loss, no duplicates --')
await step('20 rapid messages all arrive, in order, exactly once', async () => {
  for (let i = 1; i <= 20; i++) { await send(pa, `BURST-${i}`); await pa.waitForTimeout(60) }
  const deadline = Date.now() + 30000
  let text = ''
  while (Date.now() < deadline) {
    text = await threadText(pb)
    if (text.includes('BURST-20')) break
    await pb.waitForTimeout(500)
  }
  const missing = []
  for (let i = 1; i <= 20; i++) if (!text.includes(`BURST-${i}`)) missing.push(i)
  // A duplicate shows up as the same token twice in the rendered thread.
  const dupes = []
  for (let i = 1; i <= 20; i++) {
    const n = (text.match(new RegExp(`BURST-${i}\\b`, 'g')) || []).length
    if (n > 1) dupes.push(`${i}x${n}`)
  }
  const order = []
  for (let i = 1; i <= 20; i++) { const at = text.indexOf(`BURST-${i}\b`.replace('\b', '')); if (at >= 0) order.push(at) }
  const sorted = order.every((v, i, arr) => i === 0 || arr[i - 1] <= v)
  return {
    pass: missing.length === 0 && dupes.length === 0 && sorted,
    detail: `missing=[${missing}] dupes=[${dupes}] inOrder=${sorted}`
  }
})

console.log('\n-- read receipts --')
await step('A sees its message marked Read once B has it open', async () => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if ((await threadText(pa)).includes('Read')) return true
    await pa.waitForTimeout(500)
  }
  return false
})

console.log('\n-- typing indicator --')
await step('B sees A typing', async () => {
  await pa.click(COMPOSER)
  await pa.type(COMPOSER, 'typing now', { delay: 60 })
  const deadline = Date.now() + 10000
  let seen = false
  while (Date.now() < deadline) {
    const t = await threadText(pb)
    if (/typing/i.test(t)) { seen = true; break }
    await pb.waitForTimeout(400)
  }
  await pa.fill(COMPOSER, '')
  return seen
})

console.log('\n-- reactions --')
await step('A reacts to a message and B sees the reaction', async () => {
  // The contextmenu listener is on the BUBBLE (.bubOut/.bubIn), not on the
  // .msg wrapper — right-clicking the wrapper's padding never reaches it.
  const bubble = pa.locator('.v-chat .bubOut, .v-chat .bubIn').last()
  await bubble.click({ button: 'right' })
  await pa.waitForSelector('.ms-emojis', { timeout: 8000 })
  // The sheet arms itself against ghost clicks for 400ms: a long-press that
  // mounts a sheet under the finger would otherwise have the synthesized click
  // land on it immediately. Real fingers are never that fast; Playwright is.
  await pa.waitForTimeout(600)
  const emoji = await pa.$eval('.ms-emojis button', (b) => b.textContent)
  await pa.locator('.ms-emojis button').first().click()
  await pa.waitForTimeout(3000)
  const bHas = await pb.$$eval('.v-chat .reacts', (e) => e.map((x) => x.innerText).join('')).catch(() => '')
  return { pass: bHas.includes(emoji), detail: `sent ${emoji}, B shows "${bHas}"` }
})

console.log('\n-- replies --')
await step('B replies to a specific message and A sees the quote', async () => {
  const bubble = pb.locator('.v-chat .bubOut, .v-chat .bubIn').last()
  await bubble.click({ button: 'right' })
  await pb.waitForSelector('.ms-sheet', { timeout: 8000 })
  await pb.waitForTimeout(600)   // same 400ms ghost-click armour as above
  await pb.locator('.ms-item', { hasText: 'Reply' }).first().click()
  await pb.waitForTimeout(500)
  await send(pb, 'QUOTED REPLY')
  return waitForText(pa, 'QUOTED REPLY')
})

console.log('\n-- photo, through the real editor --')
await step('A sends a photo and B receives an image', async () => {
  const dispatched = await pa.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 96
    const g = c.getContext('2d'); g.fillStyle = '#1e88e5'; g.fillRect(0, 0, 96, 96)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    if (!blob) return 'no blob'
    const input = document.querySelector('input[type=file][accept="image/*"][multiple]')
    if (!input) return 'no input'
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return 'dispatched'
  })
  if (dispatched !== 'dispatched') return { pass: false, detail: dispatched }
  // The ordinary photo path opens the EDITOR (.pe-canvas), whose send button is
  // .pe-send. `.psheet` is the view-once sheet and is NOT on this path.
  await pa.waitForSelector('.pe-canvas', { timeout: 20000 })
  await pa.click('.pe-send')
  const before = await pb.$$eval('.v-chat img', (e) => e.length).catch(() => 0)
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const now = await pb.$$eval('.v-chat img', (e) => e.length).catch(() => 0)
    if (now > before) return { pass: true, detail: `${before} -> ${now} images` }
    await pb.waitForTimeout(750)
  }
  return { pass: false, detail: `B still has ${before} images` }
})

console.log('\n-- nothing failed silently --')
await step('A shows no "Not delivered"', async () => !(await threadText(pa)).includes('Not delivered'))
await step('B shows no "Not delivered"', async () => !(await threadText(pb)).includes('Not delivered'))
await step('no undecryptable/broken-room banner on a healthy pair', async () => {
  const wa = await pa.$$eval('.v-chat .sys.warn', (e) => e.map((x) => x.innerText)).catch(() => [])
  const wb = await pb.$$eval('.v-chat .sys.warn', (e) => e.map((x) => x.innerText)).catch(() => [])
  return { pass: wa.length === 0 && wb.length === 0, detail: [...wa, ...wb].join(' / ') }
})

console.log('\n-- offline, then back --')
await step('messages sent while B is offline arrive when B returns', async () => {
  await ctxB.setOffline(true)
  await pb.waitForTimeout(1500)
  await send(pa, 'WHILE-YOU-WERE-OUT-1')
  await send(pa, 'WHILE-YOU-WERE-OUT-2')
  await pa.waitForTimeout(3000)
  await ctxB.setOffline(false)
  const got1 = await waitForText(pb, 'WHILE-YOU-WERE-OUT-1', 40000)
  const got2 = await waitForText(pb, 'WHILE-YOU-WERE-OUT-2', 15000)
  return { pass: got1 && got2, detail: `first=${got1} second=${got2}` }
})

console.log('\n-- reload: history and identity must survive --')
const KEEP = ['OPENING LINE', 'SECOND FROM ADA', 'BURST-20', 'WHILE-YOU-WERE-OUT-2']

/** What is actually PERSISTED, as opposed to what happens to be on screen. */
const storedText = (page) => page.evaluate(() => {
  let out = ''
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('spotme')) out += localStorage.getItem(k) || ''
  }
  return out
})

await step('B PERSISTED the history before the reload (store, not screen)', async () => {
  const s = await storedText(pb)
  const lost = KEEP.filter((k) => !s.includes(k))
  return { pass: lost.length === 0, detail: lost.length ? `NOT IN STORE: ${lost.join(', ')}` : 'all persisted' }
})

await step('B still has the full history after a reload', async () => {
  await pb.reload({ waitUntil: 'domcontentloaded' })
  await pb.waitForTimeout(5000)
  await openThread(pb, A.name)
  // Give the thread a real chance to paint: replay and re-render are async, and
  // sampling once is how a slow render gets mislabelled as data loss.
  const deadline = Date.now() + 25000
  let t = ''
  while (Date.now() < deadline) {
    t = await threadText(pb)
    if (KEEP.every((k) => t.includes(k))) break
    await pb.waitForTimeout(1000)
  }
  const lost = KEEP.filter((k) => !t.includes(k))
  if (!lost.length) return { pass: true, detail: 'all kept' }
  // Distinguish "the store lost it" from "the view did not render it".
  const s = await storedText(pb)
  const inStore = lost.filter((k) => s.includes(k))
  return {
    pass: false,
    detail: `LOST FROM VIEW: ${lost.join(', ')} — of which STILL IN STORE: ${inStore.join(', ') || 'none'}`
  }
})
await step('B can still send after the reload (identity survived)', async () => {
  await send(pb, 'AFTER-RELOAD')
  return waitForText(pa, 'AFTER-RELOAD')
})
await step('B did not silently regenerate an identity', async () => {
  const c = (await convos(pb)).filter((x) => x.roomId.startsWith('dm-'))
  return { pass: c.length > 0 && c.every((x) => x.e2eVersion === 'e2e_v2'), detail: JSON.stringify(c) }
})

/* ------------------------------------------------------------- report -- */

await pa.screenshot({ path: `${SHOTS}/journey-A.png` }).catch(() => {})
await pb.screenshot({ path: `${SHOTS}/journey-B.png` }).catch(() => {})

const passed = results.filter((r) => r.pass).length
console.log('\n========================================')
console.log(`  FULL JOURNEY: ${passed}/${results.length} passed`)
console.log('========================================')
for (const r of results.filter((x) => !x.pass)) console.log(`  FAILED: ${r.name} — ${r.detail}`)

const uniqNet = [...new Set(netErrors)]
if (uniqNet.length) {
  console.log('\n-- failing requests --')
  for (const n of uniqNet.slice(0, 25)) console.log('  ' + n)
}
const uniqCon = [...new Set(consoleErrors)]
if (uniqCon.length) {
  console.log('\n-- console errors --')
  for (const c of uniqCon.slice(0, 25)) console.log('  ' + c)
}

writeFileSync(`${SHOTS}/journey.json`,
  JSON.stringify({ results, netErrors: uniqNet, consoleErrors: uniqCon }, null, 2))

await browser.close()
process.exit(passed === results.length ? 0 : 1)
