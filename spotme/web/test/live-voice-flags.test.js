/**
 * Live-voice flags — the master + the five LAYERED sub-flags (ADR-011b).
 *
 * The safety story of the whole platform is "flags all default OFF, and a
 * sub-capability can never light up without the master". This suite pins:
 * every flag defaults false in a clean process; affirmative env forms; the
 * layering (sub true + master off = OFF); the override seams; and the
 * snapshot shape.
 *
 *   node test/live-voice-flags.test.js
 */
import {
  LIVE_VOICE_FLAG, isLiveVoiceEnabled, setLiveVoiceOverride,
  LIVE_VOICE_SUBFLAGS, setLiveVoiceSubOverride, liveVoiceFlagSnapshot,
  isLiveTranslationEnabled, isVoiceCloneEnabled, isLiveCaptionsEnabled,
  isGroupTranslationEnabled, isStreamingProviderEnabled
} from '../src/lib/live-voice/flags.js'

const results = {}
const check = (name, pass) => { results[name] = pass === true }

/* -------- defaults: every flag OFF in a clean process -------- */
check('master defaults OFF', isLiveVoiceEnabled() === false)
check('LIVE_TRANSLATION defaults OFF', isLiveTranslationEnabled() === false)
check('VOICE_CLONE defaults OFF', isVoiceCloneEnabled() === false)
check('LIVE_CAPTIONS defaults OFF', isLiveCaptionsEnabled() === false)
check('GROUP_TRANSLATION defaults OFF', isGroupTranslationEnabled() === false)
check('STREAMING_PROVIDER defaults OFF', isStreamingProviderEnabled() === false)
check('snapshot is all-false by default', Object.values(liveVoiceFlagSnapshot()).every((v) => v === false))

/* -------- the sub-flag env names are exactly the mission's six -------- */
check('sub-flag env names are the specified five', JSON.stringify(Object.values(LIVE_VOICE_SUBFLAGS).sort()) === JSON.stringify([
  'GROUP_TRANSLATION_ENABLED', 'LIVE_CAPTIONS_ENABLED', 'LIVE_TRANSLATION_ENABLED',
  'STREAMING_PROVIDER_ENABLED', 'VOICE_CLONE_ENABLED'
].sort()))
check('master env name unchanged', LIVE_VOICE_FLAG === 'LIVE_VOICE_ENABLED')

/* -------- layering: sub ON while master OFF stays OFF -------- */
setLiveVoiceSubOverride('LIVE_TRANSLATION_ENABLED', true)
check('sub override alone cannot enable (master off)', isLiveTranslationEnabled() === false)
setLiveVoiceOverride(true)
check('master on + sub on = enabled', isLiveTranslationEnabled() === true)
check('master on does NOT enable other subs', isVoiceCloneEnabled() === false && isStreamingProviderEnabled() === false)
setLiveVoiceOverride(null)
check('master back to env → sub reads off again', isLiveTranslationEnabled() === false)
setLiveVoiceSubOverride('LIVE_TRANSLATION_ENABLED', null)

/* -------- env forms: only explicit affirmatives count -------- */
const envCase = (val) => {
  process.env[LIVE_VOICE_FLAG] = val
  const on = isLiveVoiceEnabled()
  delete process.env[LIVE_VOICE_FLAG]
  return on
}
check('env "true" enables master', envCase('true') === true)
check('env "1" enables master', envCase('1') === true)
check('env "false" stays off', envCase('false') === false)
check('env "" stays off', envCase('') === false)
check('env "TRUE " (trimmed, case-folded) enables', envCase(' TRUE ') === true)
check('env "maybe" stays off', envCase('maybe') === false)

/* -------- sub-flag env layering through real env -------- */
process.env[LIVE_VOICE_FLAG] = 'true'
process.env.STREAMING_PROVIDER_ENABLED = 'true'
check('env master+sub → streaming provider on', isStreamingProviderEnabled() === true)
delete process.env[LIVE_VOICE_FLAG]
check('env sub alone (master unset) → off', isStreamingProviderEnabled() === false)
delete process.env.STREAMING_PROVIDER_ENABLED

/* -------- override seam validation -------- */
let threw = false
try { setLiveVoiceSubOverride('NOT_A_FLAG', true) } catch { threw = true }
check('unknown sub-flag name throws', threw)
check('sub override returns the LAYERED value (false while master off)', setLiveVoiceSubOverride('VOICE_CLONE_ENABLED', true) === false)
setLiveVoiceSubOverride('VOICE_CLONE_ENABLED', null)

/* -------- final state clean -------- */
check('suite leaves every flag off', Object.values(liveVoiceFlagSnapshot()).every((v) => v === false))

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice flags — defaults + layering')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
