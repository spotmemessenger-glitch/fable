/**
 * Voice-clone bottom sheet — extracted verbatim from the slice-4 profile
 * adapter so the adapter stays under the 500-line rule. Same flow,
 * constraints, and copy as the legacy sheet in views/profile.js: one clone
 * per profile, consent gate, wake lock + live wave while reading the passage.
 * All mic/audio APIs live here, app-side — never in @spotme/ui.
 */
import { db } from './db.js'
import { recordVoice } from './media.js'
import { cloneVoice, dataURLToBlob } from './voice.js'
import { el } from './ui.js'

const MAX_CLONE_SECS = 30
const CLONE_PASSAGE =
  "Hi, this is my voice. I'm recording a short sample so Spot Me can learn how I sound. " +
  'This morning I made a cup of coffee, opened the window, and watched the street slowly wake up. ' +
  'The weather has been kind lately — bright mornings and cool, quiet evenings. ' +
  'Do you ever notice how a familiar voice makes a message feel closer? ' +
  'I like walking home the long way, past the bakery and the little park. ' +
  'Alright, that should be enough. Thanks for listening to me ramble.'

const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/* -------------------------------------------------------------- voice */
/* Same flow, constraints, and copy as the legacy sheet: one clone per
 * profile, consent gate, wake lock + live wave while reading the passage. */

export function openVoiceCloneSheet (root, ctx) {
  if (db.profile().voiceId) return
  const backdrop = el('div', { class: 'vc-back' })
  let rec = null; let timer = null; let seconds = 0
  let recordedDataURL = null; let busy = false
  let wakeLock = null; let audioCtx = null; let waveRaf = null

  async function keepAwake () {
    if (!('wakeLock' in navigator)) return
    try { wakeLock = await navigator.wakeLock.request('screen') } catch { wakeLock = null }
  }
  function releaseAwake () {
    const held = wakeLock
    wakeLock = null
    if (held) held.release().catch(() => {})
  }
  const onVisible = () => { if (rec && document.visibilityState === 'visible') keepAwake() }
  document.addEventListener('visibilitychange', onVisible)

  function startWave (stream) {
    wave.style.display = ''
    const bars = [...wave.querySelectorAll('.vcb')]
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      audioCtx = new Ctx()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.75
      audioCtx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const band = Math.floor(data.length / bars.length)
      const draw = () => {
        analyser.getByteFrequencyData(data)
        bars.forEach((bar, i) => {
          let sum = 0
          for (let j = i * band; j < (i + 1) * band; j++) sum += data[j]
          const level = sum / band / 255
          const height = 0.1 + Math.pow(Math.min(1, level * 1.25), 0.65) * 0.9
          bar.style.transform = `scaleY(${height.toFixed(3)})`
        })
        waveRaf = requestAnimationFrame(draw)
      }
      draw()
    } catch { wave.classList.add('idle') }
  }
  function stopWave () {
    if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = null }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
    wave.classList.remove('idle')
    wave.style.display = 'none'
    for (const bar of wave.querySelectorAll('.vcb')) bar.style.transform = ''
  }
  function shutRecorder () {
    if (timer) { clearInterval(timer); timer = null }
    stopWave()
    releaseAwake()
    document.removeEventListener('visibilitychange', onVisible)
    if (rec) { rec.cancel(); rec = null }
  }
  function close () { shutRecorder(); backdrop.remove() }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !busy) close() })

  const status = el('div', {
    class: 'vc-status',
    text: `Tap the mic and read — recording stops itself at ${fmtSecs(MAX_CLONE_SECS)}.`
  })
  const wave = el('div', { class: 'vc-wave', style: 'display:none', 'aria-hidden': 'true' },
    Array.from({ length: 24 }, () => el('span', { class: 'vcb' })))
  const recBtn = el('button', {
    class: 'vc-recbtn', type: 'button', 'aria-label': 'Record', text: '●',
    onclick: () => { rec ? stopRecording() : startRecording() }
  })
  const rerecord = el('button', {
    class: 'vc-rerecord', type: 'button', text: 'Re-record',
    style: 'display:none', onclick: startRecording
  })
  const consent = el('input', { type: 'checkbox' })
  consent.addEventListener('change', refreshCreate)
  const createBtn = el('button', {
    class: 'vc-create', type: 'button', text: 'Create my voice', disabled: '', onclick: create
  })
  function refreshCreate () {
    createBtn.disabled = busy || !recordedDataURL || !consent.checked
  }

  async function startRecording () {
    if (rec || busy) return
    let take
    try { take = await recordVoice() } catch {
      ctx.toast('Microphone unavailable — allow access and try again')
      return
    }
    rec = take
    recordedDataURL = null
    seconds = 0
    recBtn.classList.add('recording')
    recBtn.textContent = '■'
    recBtn.setAttribute('aria-label', 'Stop recording')
    rerecord.style.display = 'none'
    status.classList.add('rec')
    status.textContent = `${fmtSecs(0)} / ${fmtSecs(MAX_CLONE_SECS)}`
    refreshCreate()
    keepAwake()
    startWave(take.stream)
    timer = setInterval(() => {
      seconds += 1
      status.textContent = `${fmtSecs(seconds)} / ${fmtSecs(MAX_CLONE_SECS)}`
      if (seconds >= MAX_CLONE_SECS) stopRecording()
    }, 1000)
  }

  async function stopRecording () {
    if (!rec) return
    if (timer) { clearInterval(timer); timer = null }
    stopWave()
    releaseAwake()
    const active = rec
    rec = null
    const clip = await active.stop()
    if (!backdrop.isConnected) return
    recordedDataURL = clip.dataURL
    recBtn.classList.remove('recording')
    recBtn.textContent = '●'
    recBtn.setAttribute('aria-label', 'Record again')
    status.classList.remove('rec')
    status.textContent = `Recorded ${clip.dur}s. Happy with it? Confirm below.`
    rerecord.style.display = ''
    refreshCreate()
  }

  async function create () {
    if (busy || !recordedDataURL || !consent.checked) return
    busy = true
    createBtn.disabled = true
    createBtn.textContent = 'Creating your voice…'
    try {
      const voiceId = await cloneVoice(dataURLToBlob(recordedDataURL), 'spotme-' + db.profile().id)
      db.setProfile({ voiceId, voiceCreatedTs: Date.now() })
      close()
      ctx.toast('Your voice is ready')
    } catch (e) {
      busy = false
      createBtn.textContent = 'Create my voice'
      refreshCreate()
      ctx.toast(String(e?.message || 'Could not create the voice'))
    }
  }

  backdrop.appendChild(el('div', { class: 'vc-sheet' }, [
    el('div', { class: 'vc-title', text: 'Create my voice' }),
    el('div', {
      class: 'vc-sub',
      text: 'Read this aloud in a quiet spot — about 30 seconds. Spot Me clones the voice with ElevenLabs and uses it only for your voice notes.'
    }),
    el('div', { class: 'vc-passage', text: CLONE_PASSAGE }),
    status, wave, recBtn, rerecord,
    el('label', { class: 'vc-consent' }, [
      consent,
      el('span', { text: 'This is my own voice. I have the rights to it and I consent to Spot Me cloning it for my voice notes.' })
    ]),
    createBtn
  ]))
  root.appendChild(backdrop)
}
