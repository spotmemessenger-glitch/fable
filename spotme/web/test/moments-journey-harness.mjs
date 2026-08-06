/**
 * The Moments journey harness — drive the gate, the media pipeline and the
 * feed in a real browser, on a phone viewport, and assert on the bytes that
 * actually reached the object store.
 *
 * WHY THIS IS SEPARATE from `phone-harness.mjs`: that one proves identity, the
 * 18+ gate and perf. This one needs three things it does not: an allowlisted
 * account (so it runs the grant script itself), a location fix, and read access
 * to the object store so the media legs can open what the server WROTE. A
 * transcode that runs is not a transcode that strips, and only the stored bytes
 * settle that.
 *
 * RUN IT:
 *   # API on :4599 with a local object store, web on :5199
 *   STORAGE_PROVIDER=local STORAGE_LOCAL_DIR=/tmp/spotme-store \
 *     DATABASE_URL=... JWT_ACCESS_SECRET=... PORT=4599 node dist/main.js
 *
 *   cd spotme/web && npm i -D playwright
 *   WEB=http://127.0.0.1:5199 STORE=/tmp/spotme-store \
 *     BACKEND=../backend node test/moments-journey-harness.mjs
 *
 * In a container that ships its own Chromium, `npx playwright install` may pull
 * a build the installed playwright does not expect. Point CHROMIUM_PATH at the
 * one that is already there instead (e.g. /opt/pw-browsers/chromium).
 *
 * It creates guest accounts and posts, and it is destructive to nothing it did
 * not create — but it is written for a DISPOSABLE database. Do not aim it at
 * production.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = process.env.WEB || 'http://127.0.0.1:5199';
const STORE = process.env.STORE || '/tmp/spotme-store';
const BACKEND = resolve(HERE, '..', '..', process.env.BACKEND || 'backend');
const FIX = resolve(BACKEND, 'test', 'fixtures');
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
const SCRATCH = mkdtempSync(join(osTmpdir(), 'moments-journey-'));

const results = [];
async function step(name, fn) {
  try {
    const ev = await fn();
    results.push({ name, ok: true, ev: String(ev) });
    console.log(`  PASS  ${name}\n        ${String(ev).slice(0, 300)}`);
  } catch (e) {
    results.push({ name, ok: false, ev: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message.slice(0, 1500)}`);
  }
}
function skip(name, why) {
  results.push({ name, ok: null, ev: why });
  console.log(`  SKIP  ${name}\n        ${why}`);
}

const uniq = () => Math.random().toString(36).slice(2, 8);
const adultYm = () => `${new Date().getUTCFullYear() - 30}-01`;
const minorYm = () => `${new Date().getUTCFullYear() - 10}-01`;

/** Every file under the object store, newest first. */
function storeFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const s = statSync(p);
      if (s.isDirectory()) walk(p); else out.push({ path: p, mtime: s.mtimeMs, size: s.size });
    }
  };
  try { walk(STORE); } catch { /* not created yet */ }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Container tags exactly as ffprobe parses them (mp4 keeps GPS in BINARY). */
const probe = (p) => execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format_tags', '-of', 'default=noprint_wrappers=1', p,
]).toString().trim();

const EXIF = Buffer.from('Exif\0\0', 'latin1');
const GPSTAG = Buffer.from([0x88, 0x25]);

/**
 * The JPEG marker segments present before SOS.
 *
 * Scanning raw bytes for the GPS IFD tag (0x8825) is NOT a sound test for a
 * JPEG and produces false positives: it is only two bytes, so it turns up by
 * chance in entropy-coded pixel data. Measured on this very drive — a
 * correctly stripped 16 KB JPEG contained 0x8825 once, at offset 15175, well
 * past SOS at 329. What actually proves the strip is that no APP1..APP15 or
 * COM segment survived.
 */
function jpegSegments(d) {
  const segs = [];
  let i = 2;
  while (i + 4 <= d.length && d[i] === 0xff) {
    const m = d[i + 1];
    if (m === 0xd9) break;
    if (m === 0xda) { segs.push({ marker: 'SOS', at: i }); break; }
    segs.push({ marker: m, at: i });
    i += 2 + d.readUInt16BE(i + 2);
  }
  return segs;
}
const metadataSegments = (d) => jpegSegments(d)
  .filter((s) => typeof s.marker === 'number' && ((s.marker >= 0xe1 && s.marker <= 0xef) || s.marker === 0xfe))
  .map((s) => '0x' + s.marker.toString(16));


/**
 * Splice a structurally valid EXIF APP1 segment carrying a GPS IFD into a real
 * JPEG. Not a look-alike: the strip has to have something genuine to remove,
 * or the assertion that it removed it proves nothing.
 */
function buildGpsJpeg(src) {
  const U16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const U32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const entry = (tag, type, count, v) =>
    Buffer.concat([U16(tag), U16(type), U32(count), Buffer.isBuffer(v) ? v : U32(v)]);
  const rationals = (t) => Buffer.concat(t.map(([n, d]) => Buffer.concat([U32(n), U32(d)])));

  const tiffHeader = Buffer.concat([Buffer.from('MM'), U16(42), U32(8)]);
  const gpsIfdOffset = 8 + (2 + 12 + 4);
  const ifd0 = Buffer.concat([U16(1), entry(0x8825, 4, 1, gpsIfdOffset), U32(0)]);
  const gpsIfdSize = 2 + 12 * 4 + 4;
  const latOff = gpsIfdOffset + gpsIfdSize;
  const lonOff = latOff + 24;
  const gpsIfd = Buffer.concat([
    U16(4),
    entry(0x0001, 2, 2, Buffer.from('N\0\0\0')),
    entry(0x0002, 5, 3, latOff),
    entry(0x0003, 2, 2, Buffer.from('E\0\0\0')),
    entry(0x0004, 5, 3, lonOff),
    U32(0),
  ]);
  const tiff = Buffer.concat([tiffHeader, ifd0, gpsIfd,
    rationals([[12, 1], [58, 1], [1776, 100]]), rationals([[77, 1], [35, 1], [3406, 100]])]);
  const body = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), U16(body.length + 2), body]);

  let at = 2;
  if (src[2] === 0xff && src[3] === 0xe0) at = 4 + src.readUInt16BE(4);
  return Buffer.concat([src.subarray(0, at), app1, src.subarray(at)]);
}

const LAUNCH = {
  headless: true,
  ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH, channel: 'chromium' } : {}),
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  // WITHOUT THIS the whole media journey is a dead end. The composer defaults
  // to 'nearby' visibility, and the nearby feed query filters on
  // `geog IS NOT NULL` + ST_DWithin — so a post made with no location fix gets
  // a NULL geog and is invisible in every feed, to everyone, permanently.
  permissions: ['geolocation'],
  geolocation: { latitude: 12.9716, longitude: 77.5946 },
};

const main = async () => {
  const { chromium } = await import('/home/user/fable/spotme/web/node_modules/playwright/index.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  console.log(`\njourney — WEB=${WEB} viewport=390x844 isMobile store=${STORE}\n`);

  const profile = await mkdtemp(join(tmpdir(), 'journey-'));
  let ctx = await chromium.launchPersistentContext(profile, LAUNCH);
  let page = ctx.pages()[0] || (await ctx.newPage());
  const errors = [];
  const wire = (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
  };
  wire(page);

  const onboard = async (p, { name, handle, ym }) => {
    await p.goto(WEB, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.ob-go', { timeout: 20000 });
    await p.fill('.ob-name >> nth=0', name);
    await p.fill('.ob-uinput', handle);
    await p.fill('input[placeholder="YYYY-MM"]', ym);
    await p.click('.ob-go');
  };
  const reopen = async () => {
    await ctx.close();
    ctx = await chromium.launchPersistentContext(profile, LAUNCH);
    page = ctx.pages()[0] || (await ctx.newPage());
    wire(page);
  };

  console.log('— identity & the 18+ gate —');

  await step('signup with the 18+ gate: an under-18 month is REFUSED', async () => {
    await onboard(page, { name: 'Minor Probe', handle: 'mn' + uniq(), ym: minorYm() });
    await page.waitForTimeout(2500);
    if (!(await page.locator('.ob-go').count())) throw new Error('an under-18 birth month was ACCEPTED');
    return 'still on onboarding after an under-18 declaration';
  });

  const OWNER = 'own' + uniq();
  await step('signup with the 18+ gate: an adult completes', async () => {
    await ctx.close();
    await rm(profile, { recursive: true, force: true });
    ctx = await chromium.launchPersistentContext(profile, LAUNCH);
    page = ctx.pages()[0] || (await ctx.newPage());
    wire(page);
    await onboard(page, { name: 'Owner Proof', handle: OWNER, ym: adultYm() });
    await page.waitForTimeout(5000);
    if (await page.locator('.ob-go').count()) throw new Error('still on onboarding after an adult signup');
    return `signed up as @${OWNER}`;
  });

  await step('identity survives a full close and reopen', async () => {
    await reopen();
    await page.goto(WEB, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);
    if (await page.locator('.ob-go').count()) throw new Error('reopened into onboarding — identity did NOT survive');
    return 'browser genuinely closed and relaunched; reopened straight into the app';
  });

  skip('chat A↔B readable both ways',
    'needs two live peers over the realtime seam the calls session owns — stayed off it as instructed');

  console.log('\n— the Moments gate —');

  await step('BEFORE the grant, this account has NO Posts tab', async () => {
    await page.goto(WEB, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    if (await page.locator('.nv[data-path="#/posts"]').count()) throw new Error('Posts tab present WITHOUT an allowlist row — the gate leaked');
    const tabs = await page.locator('.nv').evaluateAll((els) => els.map((e) => e.dataset.path));
    return `gate shut; bar shows ${JSON.stringify(tabs)}`;
  });

  await step('the grant allowlists exactly this account (owner 200 / stranger 404)', async () => {
    const out = execFileSync('node', ['dist/scripts/wave1d/owner-grant-moments.js'], {
      cwd: BACKEND,
      env: { ...process.env, MOMENTS_OWNER_USERNAME: OWNER, PORT: '4599' },
    }).toString();
    const r = JSON.parse(out);
    if (r.status !== 'OK') throw new Error(`grant status ${r.status}: ${r.detail || ''}`);
    return `moments_rows=${r.post_domainAllowlist_rows_moments} owner_feed=${r.owner_feed_status} stranger_feed=${r.non_allowlisted_feed_status} runtimeFlag_present=${r.post_runtimeFlag_moments_present}`;
  });

  await step('AFTER the grant, the account GETS the Posts tab', async () => {
    await page.goto(WEB, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    if (!(await page.locator('.nv[data-path="#/posts"]').count())) {
      const tabs = await page.locator('.nv').evaluateAll((els) => els.map((e) => e.dataset.path));
      throw new Error(`no Posts tab after the grant; bar shows ${JSON.stringify(tabs)}`);
    }
    await page.click('.nv[data-path="#/posts"]');
    await page.waitForTimeout(4000);
    return 'Posts tab present and opened';
  });

  console.log('\n— posting media, and what actually landed on disk —');

  /** Post one file through the composer UI and return the newly stored object. */
  async function postFile(path, caption) {
    const before = new Set(storeFiles().map((f) => f.path));
    // `.mo-new` is the composer trigger ('＋', aria-label "New post"). The
    // empty-state "Create a post" pill is only present while the feed is empty,
    // so it cannot be the primary selector.
    await page.waitForSelector('.mo-new', { timeout: 20000 });
    await page.locator('.mo-new').first().click({ force: true });
    await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 20000 });
    await page.setInputFiles('input[type=file]', path);
    // The composer renders a local preview once the file is read; posting
    // before that races the upload and silently creates a TEXT moment.
    await page.waitForSelector('.mo-prevmedia', { timeout: 20000 }).catch(() => {});
    await page.fill('.mo-cap', caption);
    await page.locator('.pill.ok', { hasText: /^Post$/ }).first().click({ force: true });
    // Poll for the object rather than guessing at a sleep: video also has to
    // clear the transcode before its derived renditions land.
    const deadline = Date.now() + 60000;
    let added = [];
    while (Date.now() < deadline) {
      added = storeFiles().filter((f) => !before.has(f.path));
      if (added.length) { await page.waitForTimeout(4000); added = storeFiles().filter((f) => !before.has(f.path)); break; }
      await page.waitForTimeout(1000);
    }
    if (!added.length) throw new Error('nothing was written to the object store within 60s');
    // Leave the composer closed for the next leg.
    await page.goto(`${WEB}/#/posts`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    return added;
  }

  await step('post a JPEG — and the STORED bytes carry no EXIF/GPS', async () => {
    // Built here rather than committed: a GPS-tagged JPEG is reconstructible in
    // two ffmpeg/Node calls, and the HEIC and .mov fixtures already justify
    // their bytes in the tree.
    const src = join(SCRATCH, 'gps.jpg');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc=size=480x360:rate=1:duration=1', '-frames:v', '1', join(SCRATCH, 'plain.jpg')]);
    writeFileSync(src, buildGpsJpeg(readFileSync(join(SCRATCH, 'plain.jpg'))));
    const raw = readFileSync(src);
    if (!raw.includes(EXIF) || !raw.includes(GPSTAG)) throw new Error('fixture is not GPS-tagged — test would be vacuous');
    const added = await postFile(src, 'jpeg from the drive');
    const obj = added[0];
    const b = readFileSync(obj.path);
    const meta = metadataSegments(b);
    if (b.includes(EXIF)) throw new Error('STORED JPEG STILL CARRIES AN Exif MARKER');
    if (meta.length) throw new Error(`STORED JPEG STILL CARRIES METADATA SEGMENTS: ${meta.join(',')}`);
    return `source had Exif+GPS; stored ${obj.size}B → no Exif marker, metadata segments ${JSON.stringify(meta)}, kept ${JSON.stringify(jpegSegments(b).map((s) => typeof s.marker === 'number' ? '0x' + s.marker.toString(16) : s.marker))}`;
  });

  await step('post a HEIC — stored as JPEG, no EXIF/GPS in the stored bytes', async () => {
    const src = join(FIX, 'iphone-gps.heic');
    const raw = readFileSync(src);
    if (!raw.includes(EXIF) || !raw.includes(GPSTAG)) throw new Error('HEIC fixture is not GPS-tagged — vacuous');
    const added = await postFile(src, 'heic from the drive');
    const obj = added[0];
    const b = readFileSync(obj.path);
    if (b.readUInt16BE(0) !== 0xffd8) throw new Error(`stored object is not a JPEG (magic ${b.subarray(0, 4).toString('hex')})`);
    const meta = metadataSegments(b);
    if (b.includes(EXIF)) throw new Error('STORED HEIC→JPEG STILL CARRIES AN Exif MARKER');
    if (meta.length) throw new Error(`STORED HEIC→JPEG STILL CARRIES METADATA SEGMENTS: ${meta.join(',')}`);
    if (b.includes(Buffer.from('ftyp', 'latin1'))) throw new Error('HEIC container bytes reached the store');
    return `source HEIC had Exif+GPS; stored is JPEG ${obj.size}B → no Exif marker, metadata segments ${JSON.stringify(meta)}, no HEIC ftyp`;
  });

  await step('post an iPhone .mov — stored as mp4, no location tag in the stored bytes', async () => {
    const src = join(FIX, 'iphone-gps.mov');
    if (!probe(src).includes('location')) throw new Error('.mov fixture has no location tag — vacuous');
    const added = await postFile(src, 'mov from the drive');
    // The ORIGINAL object, not a derived variant: derived keys carry -720p/-480p/-poster.
    const original = added.find((f) => !/-(720p|480p|poster)$/.test(f.path)) || added[0];
    const tags = probe(original.path);
    if (/location/i.test(tags)) throw new Error(`STORED VIDEO STILL LEAKS: ffprobe reports ${tags.replace(/\n/g, ' | ')}`);
    if (!/major_brand/.test(tags)) throw new Error(`ffprobe could not parse the stored object: ${tags}`);
    const derived = added.filter((f) => /-(720p|480p|poster)$/.test(f.path)).map((f) => f.path.split('/').pop());
    return `source .mov had a location tag; stored original ${original.size}B → ffprobe tags [${tags.replace(/\n/g, ', ')}]; derived: ${JSON.stringify(derived)}`;
  });

  console.log('\n— the rest of the journey —');

  await step('the feed shows the posts that were just created', async () => {
    await page.goto(`${WEB}/#/posts`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const n = await page.locator('.mo-card').count();
    if (!n) throw new Error('no cards in the feed after posting');
    return `${n} card(s) in the feed`;
  });

  let firstId = null;
  await step('share deeplink #/posts?m=<id> opens THAT post', async () => {
    firstId = await page.locator('.mo-card').first().getAttribute('data-moment-id');
    if (!firstId) throw new Error('no data-moment-id on the card');
    await page.goto(`${WEB}/#/posts?m=${encodeURIComponent(firstId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    const lit = await page.locator('.nv[aria-current="page"]').getAttribute('data-path').catch(() => null);
    const focused = await page.locator(`.mo-card[data-moment-id="${firstId}"]`).count();
    if (!focused) throw new Error('the shared post is not present on the surface');
    if (lit !== '#/posts') throw new Error(`landed with the wrong tab lit: ${lit}`);
    return `lit tab ${lit}; the shared card is on screen (id ${firstId.slice(0, 12)}…)`;
  });

  await step('react to a post', async () => {
    const card = page.locator('.mo-card').first();
    const btn = card.locator('[aria-label="React"]').first();
    if (!(await btn.count())) throw new Error('no React control on the card');
    const before = await btn.getAttribute('class');
    await btn.click({ force: true });
    await page.waitForTimeout(1500);
    const opt = page.locator('button', { hasText: /love|like/i }).first();
    if (!(await opt.count())) throw new Error('the reaction sheet did not open');
    await opt.click({ force: true });
    await page.waitForTimeout(3500);
    const after = await page.locator('.mo-card').first().locator('[aria-label="React"]').first().getAttribute('class');
    if (before === after) throw new Error(`the react button did not change state (${before})`);
    return `react button ${before} → ${after}`;
  });

  await step('comment on a post', async () => {
    await page.goto(`${WEB}/#/posts`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const cbtn = page.locator('.mo-card').first().locator('[aria-label="Comments"]').first();
    if (!(await cbtn.count())) throw new Error('no Comments control on the card');
    await cbtn.click({ force: true });
    await page.waitForSelector('.mo-cminput', { timeout: 20000 });
    await page.fill('.mo-cminput', 'driven by the harness');
    await page.locator('.pill.ok', { hasText: /^Send$/ }).first().click({ force: true });
    await page.waitForTimeout(4000);
    const shown = await page.locator('.mo-cmlist').innerText();
    if (!shown.includes('driven by the harness')) throw new Error(`the comment did not appear: ${shown.slice(0, 120)}`);
    return 'comment posted and visible in the thread';
  });

  await step('delete my own post', async () => {
    // The comments sheet from the previous step is still open, and its
    // backdrop (.mo-back) swallows every pointer event on the feed. A hash
    // goto to the same URL does not re-render, so reload for real.
    await page.goto(`${WEB}/#/posts`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    if (await page.locator('.mo-back').count()) throw new Error('a sheet backdrop is still covering the feed');
    const before = await page.locator('.mo-card').count();
    const more = page.locator('.mo-card').first().locator('[aria-label="More"]').first();
    if (!(await more.count())) throw new Error('no More control on the card');
    // The card's last action button sits under the fixed bottom nav, so a
    // forced click lands on the nav instead of the button. Scroll it clear
    // first and click for real.
    await more.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await more.click();
    await page.waitForTimeout(3500);
    const del = page.locator('button', { hasText: /delete post/i }).first();
    if (!(await del.count())) {
      // Capture WHY rather than guessing: what the sheet actually offered, and
      // whether the client thinks this post is the viewer's.
      const sheet = await page.locator('body').innerText().catch(() => '');
      const opts = await page.locator('button').allInnerTexts().catch(() => []);
      const who = await page.evaluate(() => {
        const c = document.querySelector('.mo-card');
        return { cardId: c?.dataset?.momentId || null, sheetOpen: !!document.querySelector('.mo-sheet, .sheet') };
      });
      throw new Error(`no "Delete post" option. sheetOpen=${who.sheetOpen} buttons=${JSON.stringify(opts.slice(0, 14))} bodyHas="${sheet.slice(0, 80).replace(/\n/g, ' ')}"`);
    }
    await del.click({ force: true });
    await page.waitForTimeout(4000);
    const after = await page.locator('.mo-card').count();
    if (after >= before) throw new Error(`card count did not drop (${before} → ${after})`);
    return `deleted; cards ${before} → ${after}`;
  });

  await step('username search', async () => {
    const r = await page.evaluate(async (h) => {
      const res = await fetch(`http://127.0.0.1:4599/api/username?q=${h.slice(0, 4)}`);
      return { status: res.status, body: (await res.text()).slice(0, 160) };
    }, OWNER);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.body.includes(OWNER.slice(0, 4))) throw new Error(`no match in ${r.body}`);
    return `HTTP 200 ${r.body}`;
  });

  await step('nearby map renders', async () => {
    await page.goto(`${WEB}/#/discovery`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const body = await page.locator('body').innerText();
    if (!body || body.length < 20) throw new Error('discovery surface rendered nothing');
    return `discovery surface rendered (${body.length} chars of text)`;
  });

  skip('story / reels swipe / report / block',
    'not driven this run — story and reels need a surviving video card (the delete leg removes one) and report/block need a SECOND authored account; both are reachable but were not exercised, so they are not claimed');

  console.log('\n— console —');
  await step('no uncaught page errors (gate 404s excluded — they are the gate working)', async () => {
    const real = errors.filter((e) => !/favicon|fonts\.googleapis|404|Failed to load resource/i.test(e));
    if (real.length) throw new Error(`${real.length}: ${real.slice(0, 3).join(' | ')}`);
    return `0 uncaught errors (${errors.length} filtered: gate 404s + font CDN)`;
  });

  await ctx.close();
  await rm(profile, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.ok === null).length;
  console.log(`\n  ${pass} passed, ${fail} failed, ${skipped} not driven\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
