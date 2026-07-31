/**
 * Spot Me — Profile & Settings view (#/settings).
 * Locked design: design/05-profile-andamp-settings.html (2026-07-24).
 * Identity head, safety/language/practice rows, honest privacy card,
 * blocked people, invite link, danger zone.
 */
import './profile.css'
import { db, randomHex } from '../lib/db.js'
import { lobby } from '../lib/discovery.js'
import { rooms } from '../lib/rooms.js'
import { LANGS } from '../lib/translate.js'
import { compressImage, recordVoice, AVATAR_EDGE, AVATAR_QUALITY } from '../lib/media.js'
import { cloneVoice, deleteClone, dataURLToBlob } from '../lib/voice.js'
import { openCrop } from '../lib/crop.js'
import { el, clear, avatar, actionSheet } from '../lib/ui.js'
import { notifyState, enableNotify, chime, notifyBlockedReason } from '../lib/notify.js'
import { subscribePush } from '../lib/push.js'

/* ------------------------------------------------------------- icons */

const REGISTRY_API = (location.hostname === 'localhost' || /^[\d.:[\]]+$/.test(location.hostname))
  ? 'https://spotme-messenger.vercel.app'
  : ''
const USERNAME_RE = /^[a-z0-9_]{2,}$/

const I = {
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5h3.2l1.4-2.2h8.8L17.8 8.5H21a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z"/><circle cx="12" cy="13.5" r="3.4"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14.5 5.5l4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L3 5.5v16L9 19l6 2.5 6-2.5v-16L15 5.5 9 3z"/><path d="M9 3v16M15 5.5v16"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/></svg>',
  checks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l5 5L13 8"/><path d="M11 15l3 3 8-10"/></svg>',
  translit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 9a4 4 0 010 6M19 6.5a8 8 0 010 11"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="8.4" cy="9" r="3.1"/><circle cx="16.6" cy="10.2" r="2.4"/><path d="M2.6 19.4a5.8 5.8 0 0111.6 0"/><path d="M15 19.4a4.6 4.6 0 016.4-3.6"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 007.07 0l2.12-2.12a5 5 0 00-7.07-7.07L11 5.93"/><path d="M14 10a5 5 0 00-7.07 0l-2.12 2.12a5 5 0 007.07 7.07L13 18.07"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  blur: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5s6.5 7 6.5 11a6.5 6.5 0 11-13 0c0-4 6.5-11 6.5-11z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'
}

const langNative = (code) => LANGS.find((l) => l.code === code)?.native || code
const langEnglish = (code) => LANGS.find((l) => l.code === code)?.name || code

export function render (root, ctx) {
  const wrap = el('div', { class: 'v-profile' })
  let editingName = false

  /* --------------------------------------------------------- identity */

  const filePick = el('input', { type: 'file', accept: 'image/*', style: 'display:none' })
  filePick.addEventListener('change', async () => {
    const file = filePick.files?.[0]
    filePick.value = ''
    if (!file) return
    try {
      const { dataURL } = await compressImage(file, AVATAR_EDGE, AVATAR_QUALITY)
      const cropped = await openCrop(dataURL)
      if (!cropped) return                       // cancelled — keep the old photo
      db.setProfile({ avatar: cropped })
      lobby.announce()
      ctx.toast('Photo updated')
    } catch { ctx.toast('Could not read that image') }
  })

  /* --------------------------------------------- AI (generated) avatars */

  const AI_STYLES = ['adventurer', 'bottts', 'fun-emoji', 'avataaars']
  const AI_COUNT = 12

  /** One DiceBear SVG, keyless HTTP API, converted to a self-contained
   * dataURL so it persists and announces exactly like an uploaded photo. */
  async function fetchGeneratedAvatar (style, seed) {
    const res = await fetch(`https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`)
    if (!res.ok) throw new Error(`avatar fetch failed (${res.status})`)
    const svg = await res.text()
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  }

  function openAiAvatarSheet () {
    const backdrop = el('div', { class: 'ai-back' })
    const close = () => backdrop.remove()
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
    const grid = el('div', { class: 'ai-grid' })
    const loading = el('div', { class: 'ai-loading', text: 'Generating avatars…' })
    backdrop.appendChild(el('div', { class: 'ai-sheet' }, [
      el('div', { class: 'ai-title', text: 'Generated avatars' }),
      el('div', { class: 'ai-sub', text: 'Made by the DiceBear avatar service — pick one you like.' }),
      loading,
      grid
    ]))
    wrap.appendChild(backdrop)

    const seedBase = db.profile().name || 'spot'
    const jobs = Array.from({ length: AI_COUNT }, (_, n) =>
      fetchGeneratedAvatar(AI_STYLES[n % AI_STYLES.length], `${seedBase}${n}`))
    Promise.allSettled(jobs).then((results) => {
      if (!backdrop.isConnected) return          // sheet dismissed mid-fetch
      loading.remove()
      const urls = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
      if (!urls.length) {
        close()
        ctx.toast('Avatar service unreachable')
        filePick.click()                          // fall back to upload
        return
      }
      for (const dataURL of urls) {
        grid.appendChild(el('button', {
          class: 'ai-cell', type: 'button', 'aria-label': 'Use this avatar',
          onclick () {
            db.setProfile({ avatar: dataURL })
            lobby.announce()
            ctx.toast('Avatar updated')
            close()
          }
        }, [el('img', { src: dataURL, alt: '' })]))
      }
    })
  }

  function openAvatarChooser () {
    actionSheet([
      { label: 'Upload a photo', fn: () => filePick.click() },
      { label: 'AI avatar', fn: openAiAvatarSheet }
    ], 'Change photo')
  }

  const avSlot = el('span', {})
  const pav = el('button', {
    class: 'pav', type: 'button', 'aria-label': 'Change photo',
    onclick: openAvatarChooser
  }, [avSlot, el('span', { class: 'cam', html: I.cam })])

  const nameRow = el('div', { class: 'pname-row' })

  function drawName () {
    clear(nameRow)
    nameRow.appendChild(el('h2', { class: 'pname', text: db.profile().name }))
    nameRow.appendChild(el('button', {
      class: 'pedit', type: 'button', 'aria-label': 'Edit name',
      html: I.pencil, onclick: startNameEdit
    }))
  }

  function startNameEdit () {
    if (editingName) return
    editingName = true
    const input = el('input', {
      class: 'pname-input', type: 'text', maxlength: '32',
      autocomplete: 'nickname', value: db.profile().name
    })
    const commit = () => {
      if (!editingName) return
      editingName = false
      const name = input.value.trim()
      if (name && name !== db.profile().name) {
        db.setProfile({ name })
        lobby.announce()
        ctx.toast('Name updated')
      }
      drawName()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') { editingName = false; drawName() }
    })
    input.addEventListener('blur', commit)
    clear(nameRow)
    nameRow.appendChild(input)
    input.focus()
    input.select()
  }


  /* ------------------------------------------------- profile field card */
  /* WhatsApp's Profile grammar (owner reference 2026-07-25): one card, one
   * row per field, every value changeable whenever they feel like it.
   * Name/About ride the per-chat profile handshake; the phone number never
   * leaves the device — we cannot verify it, so we will not publish it. */

  const FIELD_ROWS = [
    {
      key: 'name',
      label: 'Name',
      value: () => db.profile().name,
      empty: 'Add your name',
      open: () => openFieldSheet({
        title: 'Your name',
        hint: 'People you chat with see this name.',
        max: 32,
        value: db.profile().name,
        placeholder: 'Your name',
        save (next) {
          if (!next) { ctx.toast('A name is required'); return false }
          db.setProfile({ name: next })
          lobby.announce()
          broadcastProfile()
          ctx.toast('Name updated')
          return true
        }
      })
    },
    {
      key: 'about',
      label: 'About',
      value: () => db.profile().about,
      empty: 'Add a line about you',
      open: () => openFieldSheet({
        title: 'About',
        hint: 'A short line shown on your profile in chats.',
        max: 120,
        multiline: true,
        value: db.profile().about || '',
        placeholder: 'The magic you are looking for…',
        save (next) {
          db.setProfile({ about: next })
          broadcastProfile()
          ctx.toast(next ? 'About updated' : 'About cleared')
          return true
        }
      })
    },
    {
      key: 'username',
      label: 'Username',
      value: () => (db.profile().username ? '@' + db.profile().username : ''),
      empty: 'Claim a username',
      open: () => openUsernameSheet()
    },
    {
      key: 'phone',
      label: 'Phone number',
      value: () => db.profile().phone,
      empty: 'Optional',
      open: () => openFieldSheet({
        title: 'Phone number',
        hint: 'Optional, and kept on this device only — Spot Me cannot verify numbers and never publishes yours.',
        max: 24,
        type: 'tel',
        value: db.profile().phone || '',
        placeholder: '+91 99999 99999',
        save (next) {
          db.setProfile({ phone: next })
          ctx.toast(next ? 'Phone number saved' : 'Phone number removed')
          return true
        }
      })
    }
  ]

  /** Push the changed name/about to every open conversation right away. */
  function broadcastProfile () {
    const p = db.profile()
    for (const convo of db.convos()) {
      rooms.get(convo.roomId)?.net.sendProfile({ name: p.name, lang: p.lang, about: p.about || '' })
    }
  }

  const fieldCard = el('div', { class: 'pfields' })

  function drawFields () {
    clear(fieldCard)
    for (const field of FIELD_ROWS) {
      const raw = field.value()
      const isSet = Boolean(raw)
      const row = el('button', {
        class: 'pfr', type: 'button', onclick: field.open
      }, [
        el('span', { class: 'pfl', text: field.label }),
        el('span', { class: 'pfv' + (isSet ? '' : ' none'), text: isSet ? raw : field.empty }),
        el('span', { class: 'pfc', html: I.chev })
      ])
      fieldCard.appendChild(row)
      if (field.key === 'username' && isSet) {
        row.appendChild(el('span', {
          class: 'pfcopy', role: 'button', tabindex: '0',
          'aria-label': 'Copy my username', html: I.copy,
          async onclick (event) {
            event.stopPropagation()
            try {
              await navigator.clipboard.writeText(raw)
              ctx.toast('Username copied')
            } catch { ctx.toast('Could not copy the username') }
          }
        }))
      }
    }
  }

  /** One-input bottom sheet: the editor behind every field row. */
  function openFieldSheet ({ title, hint, value, placeholder, max, type, multiline, save }) {
    const input = multiline
      ? el('textarea', { class: 'fsIn area', maxlength: String(max), placeholder, rows: '3' })
      : el('input', { class: 'fsIn', type: type || 'text', maxlength: String(max), placeholder })
    input.value = value || ''

    const counter = el('span', { class: 'fsCt' })
    const setCount = () => { counter.textContent = `${input.value.length}/${max}` }
    input.addEventListener('input', setCount)
    setCount()

    const backdrop = el('div', { class: 'sheet-back' })
    const close = () => backdrop.remove()

    const commit = () => {
      if (save(input.value.trim()) !== false) close()
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !multiline) { event.preventDefault(); commit() }
      if (event.key === 'Escape') close()
    })

    backdrop.appendChild(el('div', { class: 'sheet fsheet' }, [
      el('div', { class: 'fsTitle', text: title }),
      hint ? el('p', { class: 'fsHint', text: hint }) : null,
      el('div', { class: 'fsField' }, [input, counter]),
      el('div', { class: 'fsActs' }, [
        el('button', { class: 'pill ghost', type: 'button', text: 'Cancel', onclick: close }),
        el('button', { class: 'pill ok', type: 'button', text: 'Save', onclick: commit })
      ])
    ]))
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close() })
    wrap.appendChild(backdrop)
    input.focus()
    input.select?.()
  }

  /** Claim or change the @username — same registry the search box reads. */
  function openUsernameSheet () {
    const current = db.profile().username || ''
    const input = el('input', {
      class: 'fsIn', type: 'text', maxlength: '24',
      placeholder: 'username', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false'
    })
    input.value = current
    const state = el('p', { class: 'fsState' })
    const saveBtn = el('button', { class: 'pill ok', type: 'button', text: current ? 'Change' : 'Claim' })

    let seq = 0
    let timer = null
    let free = false

    function setState (kind, text) {
      state.dataset.k = kind
      state.textContent = text
      free = kind === 'ok'
      saveBtn.disabled = !free
    }

    async function check (handle) {
      const mine = ++seq
      setState('wait', 'Checking…')
      try {
        const res = await fetch(`${REGISTRY_API}/api/username?check=${encodeURIComponent(handle)}`)
        const data = await res.json()
        if (mine !== seq) return
        if (data.available) setState('ok', `@${handle} is available`)
        else setState('bad', `@${handle} is taken`)
      } catch {
        if (mine === seq) setState('bad', 'Registry unreachable — try again in a moment')
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer)
      seq += 1
      const handle = input.value.trim().replace(/^@/, '').toLowerCase()
      if (handle === current && current) { setState('idle', 'This is your username'); return }
      if (!USERNAME_RE.test(handle)) {
        setState('idle', 'Letters, numbers and underscore — at least 2 characters')
        return
      }
      timer = setTimeout(() => check(handle), 350)
    })
    setState('idle', current ? 'Pick a new one to change it' : 'Letters, numbers and underscore')

    const backdrop = el('div', { class: 'sheet-back' })
    const close = () => { clearTimeout(timer); seq += 1; backdrop.remove() }

    saveBtn.onclick = async () => {
      const handle = input.value.trim().replace(/^@/, '').toLowerCase()
      if (!free || !USERNAME_RE.test(handle)) return
      saveBtn.disabled = true
      setState('wait', 'Claiming…')
      try {
        const me = db.profile()
        const res = await fetch(`${REGISTRY_API}/api/username`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: handle, id: me.id, name: me.name, secret: me.claimSecret })
        })
        if (res.status === 409) { setState('bad', 'Just taken — try another'); return }
        if (!res.ok) { setState('bad', 'Could not claim that one'); return }
        db.setProfile({ username: handle })
        // Hand the old name back only once the new one is safely held, so a
        // failed claim never leaves this device with no username at all.
        if (current && current !== handle) {
          fetch(`${REGISTRY_API}/api/username`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'release', username: current, secret: me.claimSecret, id: me.id })
          }).catch(() => { /* the old name stays taken; harmless */ })
        }
        ctx.toast(current ? 'Username changed' : 'Username claimed')
        close()
      } catch {
        setState('bad', 'Registry unreachable — try again in a moment')
      }
    }

    backdrop.appendChild(el('div', { class: 'sheet fsheet' }, [
      el('div', { class: 'fsTitle', text: 'Username' }),
      el('p', { class: 'fsHint', text: 'Your public handle: anyone can find you by searching it, anywhere in the world.' }),
      el('div', { class: 'fsField' }, [el('span', { class: 'fsAt', text: '@' }), input]),
      state,
      el('div', { class: 'fsActs' }, [
        el('button', { class: 'pill ghost', type: 'button', text: 'Cancel', onclick: close }),
        saveBtn
      ])
    ]))
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close() })
    wrap.appendChild(backdrop)
    input.focus()
  }

  const phead = el('div', { class: 'phead' }, [pav, filePick, nameRow])

  /* ---------------------------------------------------------- my voice */
  /* One ElevenLabs clone per profile — a second clone requires deleting
     the first. The sample must be the user's own voice, and they must
     tick the rights/consent box before Create unlocks. */

  const MAX_CLONE_SECS = 30

  /* ~90 words of everyday sentences — reads aloud in about 30 seconds. */
  const CLONE_PASSAGE =
    "Hi, this is my voice. I'm recording a short sample so Spot Me can learn how I sound. " +
    'This morning I made a cup of coffee, opened the window, and watched the street slowly wake up. ' +
    'The weather has been kind lately — bright mornings and cool, quiet evenings. ' +
    'Do you ever notice how a familiar voice makes a message feel closer? ' +
    'I like walking home the long way, past the bakery and the little park. ' +
    'Alright, that should be enough. Thanks for listening to me ramble.'

  const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  function openVoiceSheet () {
    if (db.profile().voiceId) return           // never allow a second clone
    const backdrop = el('div', { class: 'vc-back' })
    let rec = null
    let timer = null
    let seconds = 0
    let recordedDataURL = null
    let busy = false

    /* ---------------------------------------------- awake + live wave */
    /* Reading a 30-second passage means half a minute without touching the
     * screen, so phones dim and lock mid-take. A screen wake lock holds it
     * on, and the bars give the visual proof that we are still hearing you. */

    let wakeLock = null
    let audioCtx = null
    let waveRaf = null

    async function keepAwake () {
      if (!('wakeLock' in navigator)) return    // unsupported: bars still animate
      try { wakeLock = await navigator.wakeLock.request('screen') } catch { wakeLock = null }
    }

    function releaseAwake () {
      const held = wakeLock
      wakeLock = null
      if (held) held.release().catch(() => {})
    }

    // A wake lock is dropped whenever the tab hides; re-take it on return.
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
            // Gentle curve, not a linear boost: a loud voice used to pin
            // every bar at full height, which reads as a frozen block.
            const level = sum / band / 255                  // 0..1
            const height = 0.1 + Math.pow(Math.min(1, level * 1.25), 0.65) * 0.9
            bar.style.transform = `scaleY(${height.toFixed(3)})`
          })
          waveRaf = requestAnimationFrame(draw)
        }
        draw()
      } catch {
        // No analyser (older browser): fall back to the CSS idle pulse.
        wave.classList.add('idle')
      }
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
    /* 24 bars driven by the live mic level while recording. */
    const wave = el('div', { class: 'vc-wave', style: 'display:none', 'aria-hidden': 'true' },
      Array.from({ length: 24 }, () => el('span', { class: 'vcb' })))
    const recBtn = el('button', {
      class: 'vc-recbtn', type: 'button', 'aria-label': 'Record',
      html: I.mic, onclick: () => { rec ? stopRecording() : startRecording() }
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
      try {
        take = await recordVoice()
      } catch {
        ctx.toast('Microphone unavailable — allow access and try again')
        return
      }
      rec = take
      recordedDataURL = null
      seconds = 0
      recBtn.classList.add('recording')
      recBtn.innerHTML = I.stop
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
      if (!backdrop.isConnected) return          // sheet dismissed mid-stop
      recordedDataURL = clip.dataURL
      recBtn.classList.remove('recording')
      recBtn.innerHTML = I.mic
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
      status,
      wave,
      recBtn,
      rerecord,
      el('label', { class: 'vc-consent' }, [
        consent,
        el('span', { text: 'This is my own voice. I have the rights to it and I consent to Spot Me cloning it for my voice notes.' })
      ]),
      createBtn
    ]))
    wrap.appendChild(backdrop)
  }

  function confirmDeleteVoice () {
    actionSheet([{
      label: 'Delete voice',
      danger: true,
      async fn () {
        const voiceId = db.profile().voiceId
        if (!voiceId) return
        try {
          await deleteClone(voiceId)
        } catch (e) {
          /* 404/not-found means the clone is already gone server-side —
             unlink locally so the user is not stuck. Anything else, keep it. */
          if (!/404|not[_ ]?found/i.test(String(e?.message || ''))) {
            ctx.toast(String(e?.message || 'Could not delete the voice'))
            return
          }
        }
        db.setProfile({ voiceId: null, voiceCreatedTs: null })
        ctx.toast('Voice deleted — you can record a new one')
      }
    }], 'Delete your cloned voice? Voice notes use a standard voice until you record a new one.')
  }

  const voiceBox = el('div', {})

  function drawVoice () {
    clear(voiceBox)
    const profile = db.profile()
    if (!profile.voiceId) {
      voiceBox.appendChild(el('button', {
        class: 'row', type: 'button', onclick: openVoiceSheet
      }, [
        el('span', { class: 'ri', html: I.mic }),
        el('span', { class: 'rl' }, [
          el('b', { text: 'Create my voice' }),
          el('span', { class: 'sub', text: 'Record a 30-second sample so voice notes can speak in your own voice.' })
        ]),
        el('span', { class: 'chev', html: I.chev })
      ]))
      return
    }
    const created = profile.voiceCreatedTs
      ? new Date(profile.voiceCreatedTs).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
      : 'earlier'
    voiceBox.appendChild(el('div', { class: 'row static' }, [
      el('span', { class: 'ri', html: I.mic }),
      el('span', { class: 'rl' }, [
        el('b', { text: `Your voice — created ${created}` }),
        el('span', { class: 'sub', text: 'One voice per profile. Delete it to record a new one.' })
      ]),
      el('button', { class: 'vc-del', type: 'button', text: 'Delete voice', onclick: confirmDeleteVoice })
    ]))
  }

  /* ----------------------------------------------------- rows & toggles */

  const toggles = []

  function toggleRow (icon, label, sub, isOn, onFlip) {
    const tog = el('span', { class: 'tog' })
    const row = el('button', {
      class: 'row', type: 'button', role: 'switch',
      onclick: () => onFlip(!isOn())
    }, [
      el('span', { class: 'ri', html: icon }),
      el('span', { class: 'rl' }, [
        el('b', { text: label }),
        sub ? el('span', { class: 'sub', text: sub }) : null
      ]),
      tog
    ])
    toggles.push({ row, tog, isOn })
    return row
  }

  const langVal = el('span', { class: 'val' })
  const langRow = el('button', {
    class: 'row', type: 'button', onclick: openLangSheet
  }, [
    el('span', { class: 'ri', html: I.globe }),
    el('span', { class: 'rl' }, [el('b', { text: 'Your language' })]),
    langVal,
    el('span', { class: 'chev', html: I.chev })
  ])

  function openLangSheet () {
    const current = db.profile().lang
    const backdrop = el('div', { class: 'ls-backdrop' })
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove() })
    const grid = el('div', { class: 'ls-grid' }, LANGS.map((language) =>
      el('button', {
        class: 'ls-lang' + (language.code === current ? ' on' : ''), type: 'button',
        onclick () {
          db.setProfile({ lang: language.code })
          ctx.toast(`Messages now translate into ${language.name}`)
          backdrop.remove()
        }
      }, [
        el('strong', { text: language.native }),
        el('span', { text: language.name })
      ])
    ))
    backdrop.appendChild(el('div', { class: 'ls-sheet' }, [
      el('div', { class: 'ls-title', text: 'Your language' }),
      el('div', { class: 'ls-sub', text: 'Messages from other languages translate into this one.' }),
      grid
    ]))
    wrap.appendChild(backdrop)
  }

  /* ----------------------------------------------------- last seen & online */

  const LAST_SEEN_LABELS = { everyone: 'Everyone', contacts: 'My contacts', nobody: 'Nobody' }

  const lastSeenVal = el('span', { class: 'val' })
  const lastSeenRow = el('button', {
    class: 'row', type: 'button', onclick: openLastSeenSheet
  }, [
    el('span', { class: 'ri', html: I.eye }),
    el('span', { class: 'rl' }, [
      el('b', { text: 'Last seen & online' }),
      el('span', {
        class: 'sub',
        text: 'Cooperative: standard apps honour this; connection status is inherently visible in P2P.'
      })
    ]),
    lastSeenVal,
    el('span', { class: 'chev', html: I.chev })
  ])

  /**
   * System notifications need permission, and the browser only grants it from
   * a real click — so this is a row the user presses, not something the app
   * can arrange on their behalf at boot.
   */
  const notifVal = el('span', { class: 'val' })
  const notifRow = el('button', {
    class: 'row', type: 'button', onclick: askNotify
  }, [
    el('span', { class: 'ri', html: I.checks }),
    el('span', { class: 'rl' }, [
      el('b', { text: 'Show notifications' }),
      el('span', {
        class: 'sub',
        text: "In your phone's notification tray when the app is in the background."
      })
    ]),
    notifVal,
    el('span', { class: 'chev', html: I.chev })
  ])

  function paintNotify () {
    const state = notifyState()
    notifVal.textContent = state === 'granted' ? 'On'
      : state === 'denied' ? 'Blocked in browser'
      // On iPhone this is not a dead end, so it must not read like one.
      : state === 'unsupported'
        ? (notifyBlockedReason() === 'ios-needs-install' ? 'Add to Home Screen' : 'Not supported')
        : 'Tap to allow'
  }
  paintNotify()

  async function askNotify () {
    const state = notifyState()
    if (state === 'denied') {
      // Only the browser's own site settings can undo this; saying so beats a
      // button that silently does nothing every time it is pressed.
      ctx.toast('Notifications are blocked for this site — allow them in your browser settings')
      return
    }
    if (state === 'unsupported') {
      ctx.toast(notifyBlockedReason() === 'ios-needs-install'
        // The exact gesture, because iOS offers no prompt and no explanation.
        ? 'On iPhone: tap Share, then Add to Home Screen, and open Spot Me from there'
        : 'This browser cannot show notifications')
      return
    }
    await enableNotify()
    paintNotify()
    if (notifyState() !== 'granted') return
    chime()
    // Permission alone only covers a phone with the app still running. The
    // subscription is what lets a closed one be woken, so it is claimed here
    // rather than behind a second toggle nobody would find.
    const push = await subscribePush()
    notifVal.textContent = push.ok ? 'On · closed-app alerts' : 'On'
    if (!push.ok && push.reason === 'not-configured') {
      ctx.toast('Alerts on. Waking a fully closed app is not switched on for this build yet.')
    }
  }

  function openLastSeenSheet () {
    const current = db.settings().lastSeen || 'everyone'
    actionSheet(
      ['everyone', 'contacts', 'nobody'].map((value) => ({
        label: (value === current ? '✓ ' : '') + LAST_SEEN_LABELS[value],
        fn: () => db.setSettings({ lastSeen: value })
      })),
      'Who can see your last seen & online'
    )
  }

  /* --------------------------------------------------------- privacy */

  const privacyCard = el('div', { class: 'pcard' }, [
    el('ul', {}, [
      el('li', { text: 'Messages travel device-to-device, encrypted (WebRTC DTLS + room secret). No server stores them.' }),
      el('li', { text: 'Finding peers uses public BitTorrent trackers — who is looking for whom can be observed. Content cannot.' }),
      el('li', { text: 'View-once, timers and delete-for-everyone are cooperative — a modified app could keep copies. That is true of every messenger.' }),
      el('li', { text: 'When on-device translation is unavailable a cloud fallback is used, and labelled "cloud" in the chat.' })
    ])
  ])

  /* --------------------------------------------------------- blocked */

  const blockedBox = el('div', {})

  function drawBlocked () {
    clear(blockedBox)
    const people = db.blocked()
    if (!people.length) {
      blockedBox.appendChild(el('div', { class: 'empty', text: 'Nobody blocked' }))
      return
    }
    for (const person of people) {
      blockedBox.appendChild(el('div', { class: 'brow' }, [
        avatar(person, 36),
        el('span', { class: 'bname', text: person.name || 'Unknown' }),
        el('button', {
          class: 'pill ok', type: 'button', text: 'Unblock',
          onclick () {
            db.unblock(person.id)
            ctx.toast(`${person.name || 'They'} can reach you again`)
          }
        })
      ]))
    }
  }

  /* ---------------------------------------------------------- invite */

  async function shareInvite () {
    try {
      const roomId = randomHex(8)
      const secret = randomHex(16)
      db.upsertConvo({
        roomId,
        secret,
        kind: 'dm',
        mode: 'meet',
        title: 'Invited chat',
        peer: { id: null, name: 'Invited chat', avatar: null, lang: 'en' }
      })
      rooms.ensure(roomId)
      const link = location.origin + location.pathname + '#r=' + roomId + '&k=' + secret
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Spot Me', text: 'Chat with me on Spot Me', url: link })
        } catch (err) {
          if (err?.name !== 'AbortError') await copyLink(link)
        }
      } else {
        await copyLink(link)
      }
      ctx.openThread(roomId)
    } catch { ctx.toast('Could not create the invite') }
  }

  async function copyLink (link) {
    try {
      await navigator.clipboard.writeText(link)
      ctx.toast('Link copied — send it to your friend')
    } catch { ctx.toast('Could not copy the link') }
  }

  const inviteCard = el('div', { class: 'vcard' }, [
    el('div', { class: 'vtop' }, [
      el('span', { class: 'vic', html: I.link }),
      el('span', { class: 'vtx' }, [
        el('b', { text: 'Chat with a friend anywhere' }),
        el('span', { text: 'Send a link that opens a private room between just the two of you.' })
      ])
    ]),
    el('button', { class: 'vbtn', type: 'button', html: I.link, onclick: shareInvite }, [' Create invite link'])
  ])

  /* ------------------------------------------------------ danger zone */

  function clearAll () {
    // Double confirm: destroying every chat and the profile deserves two gates.
    actionSheet(
      [{
        label: 'Clear all data',
        danger: true,
        fn () {
          actionSheet(
            [{
              label: 'Really delete',
              danger: true,
              fn () {
                try { localStorage.clear() } catch { /* private mode */ }
                location.reload()
              }
            }],
            'This cannot be undone. Your username claim stays taken. Really delete?'
          )
        }
      }],
      'Delete everything from this device?'
    )
  }

  const dangerRow = el('button', { class: 'row danger', type: 'button', onclick: clearAll }, [
    el('span', { class: 'ri', html: I.trash }),
    el('span', { class: 'rl' }, [el('b', { text: 'Clear all data' })])
  ])

  /* --------------------------------------------------------- assemble */

  const body = el('div', { class: 'body scroll-y' }, [
    phead,
    fieldCard,

    el('div', { class: 'sec', text: 'My voice' }),
    voiceBox,

    el('div', { class: 'sec', text: 'Safety & visibility' }),
    toggleRow(I.map, 'Show me on the map',
      'Off is ghost mode: you can see others, they cannot see you.',
      () => Boolean(db.settings().showOnMap),
      (on) => { db.setSettings({ showOnMap: on }); lobby.announce() }),
    lastSeenRow,
    toggleRow(I.blur, 'Blur app preview in the app switcher',
      'Hides your chats when you switch apps.',
      () => db.settings().appBlur !== false,
      (on) => db.setSettings({ appBlur: on })),

    el('div', { class: 'sec', text: 'Notifications' }),
    notifRow,
    toggleRow(I.speaker, 'Alert sound',
      'A short tone when a message arrives in a chat you are not reading.',
      () => db.settings().sound !== false,
      // Play it on the way on, so the choice is audible rather than abstract.
      (on) => { db.setSettings({ sound: on }); if (on) chime() }),
    toggleRow(I.blur, 'Vibrate', 'Where the device supports it.',
      () => db.settings().vibrate !== false,
      (on) => db.setSettings({ vibrate: on })),
    el('div', {
      class: 'note',
      /* This used to say alerts could never reach a closed app, because
       * messages "travel straight between devices". That was true of the
       * Trystero P2P build and has been false since the server tier landed —
       * the server relays, and it pushes when an event arrives for someone who
       * is not connected. Left standing, it told users the working feature was
       * impossible. */
      text: '“On · closed-app alerts” means this device can be woken when a '
        + 'message arrives. The alert only ever says that something arrived, '
        + 'never what it said — the server cannot read your messages. Plain '
        + '“On” means push is not set up for this device, so Spot Me has to be '
        + 'open for you to be told.'
    }),

    el('div', { class: 'sec', text: 'Language & translation' }),
    langRow,
    el('div', { class: 'note', text: 'Messages from other languages translate into this one.' }),
    toggleRow(I.checks, 'Auto-translate incoming messages', null,
      () => Boolean(db.profile().autoTranslate),
      (on) => db.setProfile({ autoTranslate: on })),
    toggleRow(I.translit, 'Transliteration',
      'Type in English, send in your script.',
      () => Boolean(db.profile().translit),
      (on) => db.setProfile({ translit: on })),
    toggleRow(I.speaker, 'Read messages aloud', null,
      () => Boolean(db.settings().readAloud),
      (on) => db.setSettings({ readAloud: on })),

    el('div', { class: 'sec', text: 'Practice' }),
    toggleRow(I.people, 'Demo people',
      'Practice contacts so you can try every feature alone.',
      () => Boolean(db.settings().demoMode),
      (on) => db.setSettings({ demoMode: on })),

    el('div', { class: 'sec', text: 'What is actually private' }),
    privacyCard,

    el('div', { class: 'sec', text: 'Blocked people' }),
    blockedBox,

    el('div', { class: 'sec', text: 'Invite' }),
    inviteCard,

    el('div', { class: 'sec', text: 'Danger zone' }),
    dangerRow,

    el('div', { class: 'foot', text: 'Spot Me · P2P over WebRTC · locked design 2026-07-24' })
  ])

  wrap.appendChild(el('div', { class: 'top' }, [el('h1', { text: 'Settings' })]))
  wrap.appendChild(body)
  root.appendChild(wrap)

  /* ------------------------------------------------------ live updates */

  function update () {
    const profile = db.profile()
    if (!profile) return
    clear(avSlot)
    avSlot.appendChild(avatar(profile, 104))
    if (!editingName) drawName()
    drawFields()
    langVal.textContent = `${langNative(profile.lang)} · ${langEnglish(profile.lang)}`
    lastSeenVal.textContent = LAST_SEEN_LABELS[db.settings().lastSeen] || LAST_SEEN_LABELS.everyone
    for (const toggle of toggles) {
      const on = toggle.isOn()
      toggle.tog.classList.toggle('on', on)
      toggle.row.setAttribute('aria-checked', String(on))
    }
    drawBlocked()
    drawVoice()
  }

  update()
  const unsub = db.subscribe(update)
  return () => unsub()
}
