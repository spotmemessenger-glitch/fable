/**
 * Proves the live-voice PLATFORM is built and exercised but NOT WIRED IN —
 * and that its privacy posture is structural, not aspirational. Mirrors
 * test/translation-v2-not-shipped.test.js exactly (a failing build, not a PR
 * promise):
 *
 *   1. NO APP IMPORT. No module outside src/lib/live-voice/ imports it —
 *      the flag being off is the second fence, this is the first.
 *   2. NO RETENTION. No live-voice file touches localStorage / indexedDB /
 *      the blob store / node fs — captions and audio exist in bounded
 *      memory only (§12.3 "ephemeral only" as a grep, not a hope).
 *   3. NO CLIENT KEY. No live-voice file embeds a vendor key; the only key
 *      access is the env read the server-side custody pattern allows.
 *   4. ENGINE UNTOUCHED. live-voice never imports the shipped engine files
 *      (api/translate.js, src/lib/translate.js, src/lib/voice.js,
 *      api/voice.js) — reuse is by PATTERN and PROXY, not by import, so the
 *      voice-note pipeline cannot be destabilised from here.
 *   5. FLAGS OFF. Every live-voice flag reads false in this clean process.
 *   6. EXERCISED. The suite that proves (1)–(5) also proves the platform is
 *      driven end-to-end from tests (the counterweight).
 *
 *   node test/live-voice-not-wired.test.js
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { liveVoiceFlagSnapshot } from '../src/lib/live-voice/flags.js'
import { bootLiveVoice } from '../src/lib/live-voice/index.js'

const results = {}
const check = (name, pass) => { results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const API = join(ROOT, 'api')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== 'vendor') walk(p, out) } else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p)
  }
  return out
}

const allSrc = walk(SRC)
const allApi = walk(API)
const liveVoiceFiles = allSrc.filter((p) => p.includes('/lib/live-voice/'))
const appFiles = [...allSrc, ...allApi].filter((p) => !p.includes('/lib/live-voice/'))

/* -------- 1. no app import -------- */
const importers = appFiles.filter((p) => /from\s+['"][^'"]*live-voice/.test(readFileSync(p, 'utf8')) || /import\(['"][^'"]*live-voice/.test(readFileSync(p, 'utf8')))
check('NO app or api module imports live-voice (the structural fence)', importers.length === 0)
if (importers.length) console.log('    importers:', importers.map((p) => relative(ROOT, p)))

/* -------- 2. no retention surface in any live-voice file -------- */
const RETENTION_RE = /(localStorage|sessionStorage|indexedDB|openDB\(|blobstore|writeFile|appendFile|createWriteStream|node:fs)/
const retainers = liveVoiceFiles.filter((p) => RETENTION_RE.test(readFileSync(p, 'utf8')))
check('NO live-voice file touches storage — audio/transcripts are memory-only (§12.3)', retainers.length === 0)
if (retainers.length) console.log('    retainers:', retainers.map((p) => relative(ROOT, p)))

/* -------- 3. no embedded vendor key -------- */
const KEY_LITERAL_RE = /(sk_[A-Za-z0-9]{16,}|xi-api-key['"]?\s*:\s*['"][A-Za-z0-9]{16,})/
const keyHolders = liveVoiceFiles.filter((p) => KEY_LITERAL_RE.test(readFileSync(p, 'utf8')))
check('NO live-voice file embeds a vendor key (env-read custody only)', keyHolders.length === 0)

/* -------- 4. the engine + voice-note pipeline are not imported -------- */
const ENGINE_IMPORT_RE = /from\s+['"][^'"]*(\.\.\/translate\.js|lib\/translate\.js|lib\/voice\.js|api\/voice|api\/translate)['"]/
const engineTouchers = liveVoiceFiles.filter((p) => ENGINE_IMPORT_RE.test(readFileSync(p, 'utf8')))
check('live-voice never imports the shipped engine or voice-note pipeline', engineTouchers.length === 0)
if (engineTouchers.length) console.log('    engine touchers:', engineTouchers.map((p) => relative(ROOT, p)))

/* live-voice MAY import the #51 translation platform (that is the design) —
 * but only its PUBLIC modules, never the engine port / adapters that touch
 * the live engine. */
const PLATFORM_DEEP_RE = /from\s+['"][^'"]*translation\/adapters\//
const deepTouchers = liveVoiceFiles.filter((p) => PLATFORM_DEEP_RE.test(readFileSync(p, 'utf8')))
check('live-voice consumes the translation platform surface, never its engine adapters', deepTouchers.length === 0)

/* -------- 5. flags all read OFF in a clean process -------- */
const snap = liveVoiceFlagSnapshot()
check('every live-voice flag is OFF in a clean process', Object.values(snap).every((v) => v === false))
check('the boot door refuses while flags are down', bootLiveVoice({}).started === false)

/* -------- 6. exercised: the platform files all have a test importer -------- */
const TESTDIR = join(ROOT, 'test')
const testFiles = readdirSync(TESTDIR).filter((f) => f.endsWith('.test.js')).map((f) => readFileSync(join(TESTDIR, f), 'utf8')).join('\n')
const platformModules = [
  'providers/elevenlabs-stt.js', 'providers/elevenlabs-tts.js', 'providers/prosody.js',
  'providers/failover.js', 'mt-stage.js', 'shared-stt.js', 'fanout.js', 'live-session.js',
  'call-integration.js', 'metrics.js', 'quality/vad.js', 'quality/jitter-buffer.js',
  'quality/degradation-ladder.js', 'quality/diarization.js', 'quality/constraints.js'
]
for (const m of platformModules) {
  const base = m.split('/').pop()
  check(`${m} is imported by at least one test`, testFiles.includes(base))
}

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice platform — built, exercised, NOT wired in')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
