/**
 * Two real browsers, the real Spot Me UI, a real backend.
 *
 * Drives what a person actually does: onboard, search the other user by
 * @username, start the chat, send text both ways, send a photo, reload, and
 * check what is on screen. No module fakes anywhere — this is the app.
 *
 * Isolated browser CONTEXTS, which is what makes them two devices: separate
 * localStorage, separate IndexedDB, separate identity.
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const APP = 'http://127.0.0.1:5173'
const SHOTS = process.env.SPOTME_E2E_SHOTS || '/tmp/spotme-e2e'
const stamp = process.argv[2] || String(Date.now()).slice(-6)
const A = { name: 'Alice', user: `alice${stamp}` }
const B = { name: 'Bobby', user: `bobby${stamp}` }

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass: pass === true, detail })
  console.log(`  ${pass === true ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** A 2x2 red PNG as a data URL, small enough to paste into a file input. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64')

async function onboard (ctx, who) {
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`    [${who.user} console.error] ${m.text().slice(0, 160)}`) })
  page.on('pageerror', (e) => console.log(`    [${who.user} PAGEERROR] ${String(e).slice(0, 200)}`))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ob-name', { timeout: 20000 })
  await page.fill('input.ob-name:not(.ob-uinput)', who.name)
  await page.fill('input.ob-uinput', who.user)
  // The username availability check is debounced; Start refuses while it is
  // still 'taken' or unchecked, so wait for the field to settle.
  await page.waitForTimeout(2500)
  await page.click('button.ob-go')
  await page.waitForSelector('.v-inbox, .nv', { timeout: 20000 })
  return page
}

async function startChatWith (page, peerUser, firstLine) {
  await page.click('input[placeholder="Search users..."]')
  await page.fill('input[placeholder="Search users..."]', peerUser)
  await page.waitForSelector('.udrop', { state: 'visible', timeout: 15000 })
  await page.waitForTimeout(1200)
  const row = page.locator('.udrop').locator(`text=@${peerUser}`).first()
  await row.waitFor({ timeout: 15000 })
  await row.click()
  await page.waitForSelector('.reqsheet', { timeout: 15000 })
  await page.fill('input.reqmsg', firstLine)
  await page.click('button.reqsend')
  await page.waitForSelector('input[placeholder="Type a message…"]', { timeout: 20000 })
}

const bubbles = (page) =>
  page.$$eval('.v-chat .msg, .v-chat .bub, .v-chat .row', (els) =>
    els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean))

/** Every text visible in the thread — resilient to class-name drift. */
const threadText = (page) =>
  page.$eval('.v-chat', (e) => e.innerText).catch(() => '')

const main = async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
  const ctxA = await browser.newContext({ permissions: [] })
  const ctxB = await browser.newContext({ permissions: [] })

  console.log(`\n== onboarding @${A.user} and @${B.user} ==`)
  const pa = await onboard(ctxA, A)
  const pb = await onboard(ctxB, B)
  check('both devices onboarded', true)

  console.log('\n== A starts a chat with B ==')
  await startChatWith(pa, B.user, 'HELLO FROM ALICE')
  await pa.waitForTimeout(4000)
  const aThread1 = await threadText(pa)
  check('A sees its own first message', aThread1.includes('HELLO FROM ALICE'), aThread1.slice(0, 80).replace(/\n/g, ' | '))

  console.log('\n== B should have received it ==')
  await pb.waitForTimeout(3000)
  // The chat may be in the inbox list rather than open — open it.
  const opened = await pb.$('.v-chat')
  if (!opened) {
    const chatRow = pb.locator('.v-inbox').locator(`text=${A.name}`).first()
    if (await chatRow.count()) { await chatRow.click(); await pb.waitForTimeout(2000) }
  }
  await pb.waitForTimeout(3000)
  const bThread1 = await threadText(pb)
  check('B RECEIVED the first message', bThread1.includes('HELLO FROM ALICE'),
    bThread1 ? bThread1.slice(0, 120).replace(/\n/g, ' | ') : '(no chat open)')

  console.log('\n== B replies ==')
  if (await pb.$('input[placeholder="Type a message…"]')) {
    await pb.fill('input[placeholder="Type a message…"]', 'REPLY FROM BOBBY')
    await pb.keyboard.press('Enter')
    await pb.waitForTimeout(4000)
  }
  const aThread2 = await threadText(pa)
  check('A RECEIVED the reply (round trip)', aThread2.includes('REPLY FROM BOBBY'),
    aThread2.slice(0, 140).replace(/\n/g, ' | '))

  console.log('\n== does anything read "Not delivered"? ==')
  check('A shows no failed sends', !aThread2.includes('Not delivered'))
  const bThread2 = await threadText(pb)
  check('B shows no failed sends', !bThread2.includes('Not delivered'))

  console.log('\n== no false key warnings on a healthy pair ==')
  const warnA = await pa.$$eval('.v-chat .sys.warn', (e) => e.map((x) => x.innerText)).catch(() => [])
  const warnB = await pb.$$eval('.v-chat .sys.warn', (e) => e.map((x) => x.innerText)).catch(() => [])
  check('A shows no key/room warning', warnA.length === 0, warnA.join(' / '))
  check('B shows no key/room warning', warnB.length === 0, warnB.join(' / '))

  console.log('\n== photo from A to B ==')
  let photoSent = false
  // The photo picker is one of FOUR file inputs, and it opens a preview sheet
  // that must be confirmed — setting the file alone sends nothing.
  // Let the PAGE make the image: a canvas -> blob -> File dispatched through a
  // real change event. Closer to what a picker does than injecting bytes, and
  // it sidesteps hand-rolled PNG encoding entirely.
  const made = await pa.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64
    const g = c.getContext('2d'); g.fillStyle = '#e5342b'; g.fillRect(0, 0, 64, 64)
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
  console.log('    photo input:', made)
  await pa.waitForSelector('.psheet .pdone', { timeout: 20000 }).catch(() => {})
  const done = await pa.$('.psheet .pdone')
  if (done) { await done.click(); photoSent = true }
  await pa.waitForTimeout(9000)
  check('A had a file input to send a photo with', photoSent)
  if (photoSent) {
    await pb.waitForTimeout(5000)
    const bImgs = await pb.$$eval('.v-chat img', (e) => e.length).catch(() => 0)
    check('B RECEIVED the photo', bImgs > 0, `${bImgs} image element(s) in B's thread`)
    const aFail = await threadText(pa)
    check('the photo did not report "Not delivered"', !aFail.includes('Not delivered'))
  }

  console.log('\n== reload B: history must survive ==')
  await pb.reload({ waitUntil: 'domcontentloaded' })
  await pb.waitForTimeout(6000)
  const openedAfter = await pb.$('.v-chat')
  if (!openedAfter) {
    const row = pb.locator('.v-inbox').locator(`text=${A.name}`).first()
    if (await row.count()) { await row.click(); await pb.waitForTimeout(3000) }
  }
  const bAfter = await threadText(pb)
  check('B still has the message after a reload', bAfter.includes('HELLO FROM ALICE'),
    bAfter.slice(0, 120).replace(/\n/g, ' | '))

  console.log('\n== cursor sanity: nothing held back on a healthy room ==')
  const cursors = await pb.evaluate(() =>
    Object.entries(localStorage).filter(([k]) => k.startsWith('spotme.cursor.')).map(([k, v]) => `${k}=${v}`))
  check('B has a replay cursor recorded', cursors.length > 0, cursors.join(', '))

  await pa.screenshot({ path: `${SHOTS}/A.png`, fullPage: false }).catch(() => {})
  await pb.screenshot({ path: `${SHOTS}/B.png`, fullPage: false }).catch(() => {})

  const passed = results.filter((r) => r.pass).length
  console.log('\n========================================')
  console.log(`  REAL BROWSER E2E: ${passed}/${results.length} passed`)
  console.log('========================================')
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAILED: ${r.name} — ${r.detail}`)
  writeFileSync(`${SHOTS}/result.json`, JSON.stringify(results, null, 2))

  await browser.close()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => { console.error('E2E HARNESS ERROR:', e.message); process.exit(2) })
