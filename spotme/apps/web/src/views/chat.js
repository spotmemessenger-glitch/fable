/**
 * Spot Me — chat thread view (design/03-chat.html, the split-translation
 * variant). Receives a third argument: the roomId to open.
 *
 * Incremental by default: conn events patch individual DOM nodes; a full
 * thread rebuild happens only on 'history' merges.
 */
import './chat.css'
import { precheckAttachment } from '../lib/media-precheck.js'
import { playExclusive } from '../lib/video.js'
import { db } from '../lib/db.js'
import { rooms } from '../lib/rooms.js'
import { lobby, distanceM, fmtDistance } from '../lib/discovery.js'
import { translateText, transliterateRemote, detectLanguage, readMessage, SCRIPT_MAP, warmup, langName, speak, dictate } from '../lib/translate.js'
import { sttBlob, ttsClone } from '../lib/voice.js'
import { compressImage, fileToDataURL, recordVoice, currentLocation, mapLink, fileFromDataURL, downloadFile, shareOut, maskDataURL, VIDEO_CAP_BYTES } from '../lib/media.js'
import { openPhotoEditor, closePhotoEditor } from '../lib/photoedit.js'
import { el, clear, avatar, fmtTime, fmtDay, actionSheet } from '../lib/ui.js'
import { reactChat } from './chat-island.js'
import { isPlainEnglish } from '../lib/english.js'
import { livekitCalls } from '../lib/calls/select.js'
import { identityStatus } from '../lib/crypto/identity-store.js'
import { transliterate, supportedScripts } from 'spotme-core/core/translit.js'

const LONG_PRESS_MS = 420
const TYPING_THROTTLE_MS = 2000
const TYPING_IDLE_MS = 3000
const NEAR_BOTTOM_PX = 80
const QUOTE_CHARS = 40
const EDIT_MAX_EDGE = 2048   // editing headroom; the editor re-bounds on send (1280 std / 2048 HD)
const EDIT_QUALITY = 0.9     // intake quality — the editor re-encodes at .82/.9
const MAX_BATCH_PHOTOS = 10  // WhatsApp-style multi-select cap
const REACT_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🥰']

/**
 * Telegram's jumbo emoji: a message that is nothing but emoji drops its bubble
 * and plays large. Three is their cutoff and it is a good one — beyond that
 * the row becomes a wall of glyphs.
 *
 * Their actual animations are Lottie files from Telegram's own sticker sets,
 * which are their artwork and not ours to ship. The motion below is written
 * here, one movement per feeling, so it costs nothing to download.
 */
const JUMBO_MAX = 3

/** Motion per emoji — a heart beats, a laugh shakes, fire flickers. */
const EMOJI_MOTION = new Map()
const addMotion = (motion, list) => list.forEach((e) => EMOJI_MOTION.set(e, motion))
addMotion('beat', ['❤', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💖', '💗', '💓', '💞', '💕', '😍', '🥰', '😘', '😻'])
addMotion('laugh', ['😂', '🤣', '😆', '😹', '😅', '🤪'])
addMotion('bounce', ['👍', '👏', '🙌', '🤝', '✌', '🤞', '👌', '🫰'])
addMotion('flicker', ['🔥', '⚡', '✨', '🌟', '💫', '⭐'])
addMotion('party', ['🎉', '🎊', '🥳', '🎈', '🎂', '🍾'])
addMotion('gasp', ['😮', '😱', '😲', '🤯', '😳', '👀'])
addMotion('sob', ['😢', '😭', '😔', '💔', '🥺', '😞'])
addMotion('pulse', ['🙏', '💪', '🫶', '🤲'])

/** Variation selectors and skin tones are styling, not identity. */
const motionKey = (glyph) => glyph.replace(/[️︎\u{1F3FB}-\u{1F3FF}]/gu, '')
const motionFor = (glyph) => EMOJI_MOTION.get(motionKey(glyph)) || 'pop'

const isEmojiGrapheme = (g) => /\p{Extended_Pictographic}/u.test(g)

/**
 * The emoji of an emoji-only message, or null when it is ordinary text.
 *
 * Every grapheme must be pictographic — "❤️!" stays a normal bubble, the way
 * it does in Telegram. Graphemes, not code points: a family emoji is several
 * code points joined by zero-width joiners and must count as one.
 */
function jumboEmoji (text) {
  const trimmed = String(text || '').trim()
  if (!trimmed || trimmed.length > 60) return null
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return null
  const glyphs = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed),
    (s) => s.segment
  ).filter((g) => g.trim())
  if (!glyphs.length || glyphs.length > JUMBO_MAX) return null
  return glyphs.every(isEmojiGrapheme) ? glyphs : null
}

const REDUCED_MOTION = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The expanded reaction grid behind the “+” in the message sheet. */
const EMOJI_GRID = [
  '😀', '😅', '🤣', '😊', '😍', '😘',
  '🤗', '🤔', '😴', '😷', '🥳', '😎',
  '😭', '😱', '😡', '🤯', '👏', '🙌',
  '🤝', '💪', '🔥', '💯', '🎉', '✨'
]

/** Receiving side of the activity indicator (typing-action payload kinds). */
const ACTIVITY_TEXT = {
  typing: 'typing…',
  voice: 'recording a voice note…',
  photo: 'sending a photo…',
  viewonce: 'sending a private photo…',
  file: 'sending a file…',
  video: 'sending a video…'
}

const WAVE_BARS = 28
const REC_BARS = 20          // live bars in the recording bar
const ACTIVITY_PING_MS = 2500

/** Per-chat disappearing-message durations (WhatsApp semantics). 0 = off. */
const TIMER_OPTIONS = [
  { label: 'Off', secs: 0 },
  { label: '10 seconds', secs: 10 },
  { label: '30 seconds', secs: 30 },
  { label: '1 minute', secs: 60 },
  { label: '1 hour', secs: 3600 },
  { label: '24 hours', secs: 86400 },
  { label: '1 month', secs: 2592000 },
  { label: '3 months', secs: 7776000 }
]

/** Timer month = 30 days, matching the wheel labels above. */
const TTL_DAY_SECS = 86400
const TTL_MONTH_SECS = 2592000

/** Private-photo burst wheel (Telegram-style). No Off — a private photo
 * always bursts; the default detent is 10 seconds. */
const BURST_OPTIONS = [
  ...Array.from({ length: 20 }, (_, i) => ({
    label: `${i + 1} second${i ? 's' : ''}`, secs: i + 1
  })),
  { label: '30 seconds', secs: 30 },
  { label: '1 minute', secs: 60 },
  { label: '2 minutes', secs: 120 },
  { label: '3 minutes', secs: 180 }
]

/** '1 min' / '10 sec' / '1 hour' / '24 hours' / '3 months' — the sys-line +
 * hint spelling. A single day reads '24 hours' to match its wheel label. */
const fmtTtlLong = (secs) => {
  if (secs >= TTL_MONTH_SECS) {
    const months = Math.round(secs / TTL_MONTH_SECS)
    return `${months} month${months > 1 ? 's' : ''}`
  }
  if (secs >= TTL_DAY_SECS) {
    if (secs < TTL_DAY_SECS * 2) return '24 hours'
    return `${Math.round(secs / TTL_DAY_SECS)} days`
  }
  if (secs >= 3600) return `${Math.round(secs / 3600)} hour${secs >= 7200 ? 's' : ''}`
  return secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs} sec`
}

/** Compact spelling for the composer chip: '10 s' / '1 min' / '1 h' / '1 mo'. */
const fmtTtlChip = (secs) => {
  if (secs >= TTL_MONTH_SECS) return `${Math.round(secs / TTL_MONTH_SECS)} mo`
  if (secs >= TTL_DAY_SECS) return `${Math.round(secs / TTL_DAY_SECS)} d`
  return secs >= 3600
    ? `${Math.round(secs / 3600)} h`
    : secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs} s`
}

const IC = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3.5" stroke-linecap="round"/></svg>',
  micGhost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3.5" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
  check1: '<svg viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5l3.4 3.4L14 3.3"/></svg>',
  check2: '<svg viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5l3.4 3.4L11 3"/><path d="M7.5 9.9L14 3"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.4" height="14" rx="1.2"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.2"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M14 2.5H6.5A1.5 1.5 0 005 4v16a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 20V8z"/><path d="M14 2.5V8h5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 5.6L19 9l-5.4 1.4L12 16l-1.6-5.6L5 9l5.4-1.4z"/><path d="M18.5 14l.8 2.7L22 17.5l-2.7.8-.8 2.7-.8-2.7L15 17.5l2.7-.8z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>',
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 016 6v4"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 00-6 6v4"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7"/><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v6a1 1 0 001 1h14a1 1 0 001-1v-6"/><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M14.5 5.5l4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 007.07 0l2.12-2.12a5 5 0 00-7.07-7.07L11 5.93"/><path d="M14 10a5 5 0 00-7.07 0l-2.12 2.12a5 5 0 007.07 7.07L13 18.07"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 5v2"/><path d="M18.5 7l-1 12.6a2 2 0 01-2 1.9h-7a2 2 0 01-2-1.9L5.5 7"/><path d="M10 11.5v5M14 11.5v5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3a1.5 1.5 0 011.5 1.5V19a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 19V9.5A1.5 1.5 0 014 8z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  fire: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.9 2.3 2.4 3.8 4 5.5 2 2.1 3.2 4 3.2 6.6A7.2 7.2 0 0112 21.5a7.2 7.2 0 01-7.2-7.4c0-1.9.8-3.7 2-5.1 0 0 .4 1.6 1.9 2.4C8.4 8.6 9.7 4.9 12 2z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21.5s-7-6.3-7-11.3a7 7 0 0114 0c0 5-7 11.3-7 11.3z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16.5v3a1.6 1.6 0 01-1.8 1.6 17.4 17.4 0 01-7.6-2.7 17.1 17.1 0 01-5-5A17.4 17.4 0 013.9 5.8 1.6 1.6 0 015.5 4h3a1.6 1.6 0 011.6 1.4c.1.9.3 1.8.6 2.6a1.6 1.6 0 01-.4 1.7l-1.2 1.2a14 14 0 005 5l1.2-1.2a1.6 1.6 0 011.7-.4c.8.3 1.7.5 2.6.6A1.6 1.6 0 0121 16.5z"/></svg>',
  videocam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="M15.5 11l6-3.5v9l-6-3.5z"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'
}

/* ------------------------------------------------------------ shared audio */
/** One AudioContext for the whole app: waveform decode, live analysers and
 * the picker tick. Created lazily; resumed on each use (autoplay policy). */
let sharedAC = null
const peaksCache = new Map()        // message id -> { peaks, duration } | null
const mediaSources = new WeakMap()  // <audio> -> { analyser }

function getAudioCtx () {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!sharedAC) {
    try { sharedAC = new AC() } catch { return null }
  }
  if (sharedAC.state === 'suspended') sharedAC.resume().catch(() => { /* needs gesture */ })
  return sharedAC
}

/** Decode a voice clip into ~28 normalised peak bars. Null on any failure —
 * the bubble then falls back to the plain player. Cached per message id. */
async function decodePeaks (m) {
  if (!m.data) return null
  if (peaksCache.has(m.id)) return peaksCache.get(m.id)
  let out = null
  try {
    const ac = getAudioCtx()
    if (!ac) throw new Error('no AudioContext')
    const buf = await (await fetch(m.data)).arrayBuffer()
    const decoded = await new Promise((resolve, reject) => {
      // Callback form first: promise-less Safari builds still decode.
      const maybe = ac.decodeAudioData(buf, resolve, reject)
      if (maybe?.then) maybe.then(resolve, reject)
    })
    const ch = decoded.getChannelData(0)
    const step = Math.max(1, Math.floor(ch.length / WAVE_BARS))
    const peaks = []
    let max = 0
    for (let i = 0; i < WAVE_BARS; i++) {
      let peak = 0
      const start = i * step
      const end = Math.min(ch.length, start + step)
      for (let j = start; j < end; j += 8) {
        const v = Math.abs(ch[j])
        if (v > peak) peak = v
      }
      peaks.push(peak)
      if (peak > max) max = peak
    }
    out = { peaks: peaks.map((p) => (max > 0 ? p / max : 0)), duration: decoded.duration }
  } catch { out = null }
  if (peaksCache.size > 300) peaksCache.clear()
  peaksCache.set(m.id, out)
  return out
}

/** Soft picker tick: a 2ms 2kHz blip at low gain, plus a haptic tap. */
function tickBlip () {
  const ac = getAudioCtx()
  if (ac) {
    try {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.frequency.value = 2000
      osc.connect(gain)
      gain.connect(ac.destination)
      const t = ac.currentTime
      gain.gain.setValueAtTime(0.05, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.02)
      osc.start(t)
      osc.stop(t + 0.025)
    } catch { /* audio unavailable — vibration still fires */ }
  }
  navigator.vibrate?.(8)
}

/** True when the text carries no non-Latin letters — i.e. it is written in
 *  English letters, so it may be romanized ("Tanglish") rather than English. */
/** Everyday English that a one- or two-word message is likely to be. Used
 *  only where language detection is unreliable (under three words). */
const COMMON_EN = new Set(['ok', 'okay', 'yes', 'no', 'yeah', 'yep', 'nope', 'hi', 'hello',
  'hey', 'bye', 'thanks', 'thank', 'you', 'please', 'sorry', 'sure', 'good', 'morning',
  'night', 'evening', 'afternoon', 'see', 'later', 'me', 'too', 'why', 'what', 'when',
  'where', 'who', 'how', 'now', 'today', 'tomorrow', 'yesterday', 'call', 'come', 'coming',
  'going', 'home', 'work', 'done', 'wait', 'here', 'there', 'welcome', 'congrats', 'lol', 'haha'])

const looksEnglish = (text) => {
  const words = String(text || '').toLowerCase().match(/[a-z']+/g) || []
  return words.length > 0 && words.every((w) => COMMON_EN.has(w))
}

const flatten = (t) => String(t || '').replace(/[\s\p{P}]+/gu, ' ').trim().toLowerCase()

const isLatinScript = (text) => !/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}\p{M}]/u.test(text)

const hasLocalScript =(lang) => supportedScripts().some((s) => s.code === lang)
/** Scripted = convertible: by the built-in rules (instant) or Azure (network). */

const kindLabel = (m) => {
  switch (m.kind) {
    case 'image': return m.viewOnce ? 'Private photo' : 'Photo'
    case 'voice': return `Voice note (${m.dur || 0}s)`
    case 'video': return 'Video'
    case 'file': return m.fileName || 'File'
    case 'location': return m.live === false ? 'Live location ended'
      : m.live ? 'Live location' : 'Current location'
    default: return String(m.text || '').slice(0, QUOTE_CHARS)
  }
}

/** '🔥 5s' / '🔥 2m' — the sender-chosen burst timer, shown on both sides.
 * Legacy view-once photos without a stored timer burst after 10s (the viewer
 * default), so the chip says exactly that. */
const burstChip = (m) => {
  const secs = m.burst || 10
  return `🔥 ${secs >= 60 ? `${secs / 60}m` : `${secs}s`}`
}

/** The masked bubble's caption. Says "video" when it is one — the view-once
 *  path is kind-agnostic now, and calling a clip a photo would be a lie in the
 *  one place the user is deciding whether to spend their single view. */
const privateLabel = (m) => {
  const noun = m.kind === 'video' ? 'Private video' : 'Private photo'
  if (!m.burst) return `${noun} — tap to open`
  return `${noun} · ${m.burst >= 60 ? `${m.burst / 60}m` : `${m.burst}s`} — tap to open`
}

/** Eight tiny ✦ particles twinkling over a burst card. Positions and
 * staggered delays live in chat.css (nth-of-type) — pure CSS, GPU-cheap.
 * <i> on purpose: the legacy `.vonce span` blanket rule must not hit these. */
const sparkEls = () =>
  Array.from({ length: 8 }, () => el('i', { class: 'sprk', 'aria-hidden': 'true', text: '✦' }))

/** Voice-note translate targets: South Indian languages first, then North. */
/** How a conversation began — shown on the contact page now that every chat
 *  lives in one list. */
const CONNECTED_VIA = { meet: 'Username search', nearby: 'Nearby', bluetooth: 'Bluetooth' }

const VOICE_NOTE_LANGS = ['ta', 'te', 'ml', 'kn', 'hi', 'mr', 'bn', 'gu', 'pa', 'ur']

/** ElevenLabs dictation re-transcribes the WHOLE take at every chunk
 * boundary — accuracy beats latency for a composer draft. */
const DICTATE_SLICE_MS = 4000

/** Serialize a Blob to a data URL — voice notes travel as data URLs. */
const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = () => reject(new Error('read failed'))
  reader.readAsDataURL(blob)
})

/** Best-effort clip duration in seconds; falls back when metadata is
 * unavailable (some mp3 encodes report Infinity until fully buffered). */
const audioDuration = (src, fallback) => new Promise((resolve) => {
  const probe = new Audio()
  probe.preload = 'metadata'
  probe.onloadedmetadata = () => resolve(
    Number.isFinite(probe.duration) && probe.duration > 0
      ? Math.round(probe.duration)
      : fallback
  )
  probe.onerror = () => resolve(fallback)
  probe.src = src
})

export function render (root, ctx, roomId) {
  const island = reactChat(root, ctx, roomId) // ADR-035 final slice s1, default OFF
  if (island) return island
  if (!db.convo(roomId)) {
    ctx.toast('Conversation not found')
    ctx.nav('#/chat')
    return () => {}
  }

  const convo = db.convo(roomId)
  const conn = rooms.ensure(roomId)
  const myId = db.profile().id

  /* ------------------------------------------------------------- state */
  let mounted = true
  /* Frames arrived for this room that would not open, and the transport's
   * re-agreement did not rescue them. Screen-lifetime only and never written
   * to the convo record: a "this chat is broken" flag that outlived the repair
   * would make a working chat accuse itself forever. */
  let roomUndecryptable = false
  /* 'wrong-key' (re-agreement ran and failed) or 'no-key' (never got one).
   * Only the first justifies telling someone to delete the conversation. */
  let roomUndecryptableReason = null
  let lastDayKey = null
  /* Timestamp of the last row appended to the thread. Attachments finish out
   * of order, and appending each one wherever the thread currently ends
   * scrambled the transcript — five notes sent A..E rendered E,B,D,C,A. */
  let lastTs = null
  let replyTarget = null
  let viewOncePick = false
  let recording = null
  let recInterval = null
  let recStartedAt = 0
  let activityPingAt = 0
  let earlyKind = null      // attachment kind signalled from the attach sheet
  let earlyTimer = null     // its 2.5s keep-alive interval
  let pickerArmed = false   // a native file picker is open (cancel heuristic)
  let pendingClip = null
  let confAudio = null
  /* The confirm bar's time readout. The Send pill is capped at 92px (a wider
   * one overflowed the row on a 412px Android), so "Translating…" truncated to
   * "Tran…" and the step was unreadable. The status goes here instead, where
   * there is room, and the pill stays short. */
  let confStatus = null
  const voiceStops = new Set()   // live waveform loops to halt on unmount
  const rowTimers = new Set()    // per-row intervals (view-once countdown)
  let dictating = null
  let dictBase = ''         // composer text that predates the dictation session
  let lastTypingSent = 0
  let idleTimer = null
  let statusTimer = null
  const msgEls = new Map()      // id -> { wrap, message }
  /* Attachments whose bytes are going out RIGHT NOW, in this page life. The
   * progress chip is keyed off this rather than off the message, because a
   * chip drawn from persisted state has nothing left alive to remove it: every
   * attachment ever sent came back from a reload wearing a permanent "…". */
  const inFlight = new Set()
  const trCache = new Map()     // id -> {text, engine} | 'pending'
  const timers = new Set()
  const countdowns = new Set()  // 1s intervals behind live ttl chips
  const liveShares = new Map()  // message id -> { watchId, stopTimer } (mine)

  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
    return t
  }
  const drop = (t) => { if (t !== null) { clearTimeout(t); timers.delete(t) } }

  /* --------------------------------------------------------------- DOM */
  root.classList.add('v-chat')

  const backBtn = el('button', {
    class: 'back', type: 'button', 'aria-label': 'Back', html: IC.back,
    onclick: () => ctx.nav('#/chat')
  })

  const avBtn = el('button', { class: 'avbtn', type: 'button', 'aria-label': 'Contact info' })
  avBtn.addEventListener('click', () => openContactSheet())

  function beginCall (video) {
    /* A GROUP call does not wait for anyone. The initiator opens the room and
     * rings everybody; whoever is there joins, late joiners join later, and
     * nobody being online yet is a normal start rather than a refusal. The
     * "they are offline" guard is a 1:1 fact and would be a lie here. */
    if (convo.kind !== 'group' && conn.peerCount === 0) {
      ctx.toast('They are offline — calls connect while you are both online')
      return
    }
    conn.startCall(video).catch((e) => ctx.toast(e.message || 'Microphone permission needed'))
  }

  const statusEl = el('span', { class: 'st' })
  const who = el('div', { class: 'who' }, [
    el('b', { text: convo.title || convo.peer?.name || 'Chat' }),
    statusEl
  ])

  /**
   * The two headline features get the header's spare room: a big icon plus a
   * little switch each, side by side. Owner's mapping (references 2026-07-25):
   *   文A  = TRANSLITERATION — same words, the other script
   *   🌐   = TRANSLATION     — different language, asks which
   * Each lights its own colour when on and greys out when off.
   */
  const featureCtl = (kind, iconNode, label) => {
    const knob = el('span', { class: 'fx-sw' }, [el('span', { class: 'fx-knob' })])
    return el('button', {
      class: `fx fx-${kind}`, type: 'button', 'data-on': 'false',
      title: label, 'aria-label': label, 'aria-pressed': 'false'
    }, [el('span', { class: 'fx-ic' }, [iconNode]), knob])
  }

  const trBtn = featureCtl('tr', el('span', { html: IC.globe }), 'Translation')
  /**
   * Translation is an explicit, locked choice: pressing 文A always asks which
   * language, and that answer holds for THIS conversation until changed —
   * pressing again reopens the same list (with a way out at the top).
   */
  trBtn.addEventListener('click', () => {
    const { mode } = composeState()
    const on = mode !== 'translate'
    // The switch stays a switch — it must be turn-off-able in one tap, so it
    // never opens a list. The language is chosen on the chip beside it, the
    // same arrangement 文A already uses.
    const remembered = (db.convo(roomId) || convo).langTo
    /* Turning the globe OFF used to null composeMode unconditionally, which
     * silently killed 文A as well: the switch still read on, `xlit` was still
     * true, and the composer did nothing at all until the user toggled 文A
     * twice. The two features own separate switches, so turning one off hands
     * the composer back to the other rather than emptying it. */
    setCompose({
      composeMode: on ? 'translate' : (xlitOn() ? 'translit' : null),
      langTo: on ? (remembered || 'en') : null
    })
    ctx.toast(on ? `Translating into ${langName(remembered || 'en')}` : 'Translation off')
  })

  /** Languages worth offering as a translation target. English first because
   *  it is the common bridge, then EVERY South Indian language — the four
   *  Dravidian majors plus Tulu, Konkani and Kodava, which the four-language
   *  shortlist quietly excluded — then the rest of India, then the widely
   *  typed others. Coverage varies by engine: the majors are supported
   *  everywhere, while Tulu and Kodava reach only the LLM engines, which is
   *  precisely why Gemini now leads. */
  const TR_LANGS = [
    'en',
    // South India, in full.
    'ta', 'te', 'kn', 'ml', 'tcy', 'gom',
    // The rest of India.
    'hi', 'mr', 'bn', 'gu', 'pa', 'ur', 'or', 'as',
    // Widely typed elsewhere.
    'ar', 'zh', 'es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru'
  ]

  const trChip = el('button', {
    class: 'xchip', type: 'button', 'aria-label': 'Translate their messages into',
    onclick () {
      const cur = (db.convo(roomId) || convo).langTo || 'en'
      actionSheet(
        TR_LANGS.map((code) => ({
          label: (cur === code ? '✓ ' : '') + langName(code),
          fn () {
            // Choosing a language also turns translation on: picking a target
            // and then finding it off would be a dead choice.
            setCompose({ composeMode: 'translate', langTo: code })
            ctx.toast(`Translating into ${langName(code)}`)
          }
        })),
        'Translate into…'
      )
    }
  })

  const txBtn = featureCtl('tx', el('span', { class: 'xa', text: '文A' }), 'Transliteration')

  /**
   * Compose state for this conversation. Both features are OFF until asked:
   *   composeMode 'translate' | 'translit' | null
   *   langTo      translation target (English while translation is parked)
   */
  const composeState = () => {
    const c = db.convo(roomId) || convo
    return { mode: c.composeMode || null, langTo: c.langTo || null }
  }

  /**
   * The language THEIR messages arrive in when translation is on. It reads
   * only translation's own state — never the transliteration language — so
   * the two features stay independent, as the owner requires.
   */
  function myReadLang () {
    const c = db.convo(roomId) || convo
    const mine = c.myLang
    return mine && mine !== c.langTo ? mine : db.profile().lang
  }

  /** Remember the language I write in here (translation side only). */
  function rememberMyLang (detected) {
    const base = String(detected || '').split('-')[0]
    if (!base || base === 'und') return
    const c = db.convo(roomId) || convo
    if (c.myLang !== base) db.upsertConvo({ roomId, myLang: base })
  }

  /**
   * Whole-chat transliteration switch, independent of the composer mode.
   *
   * A chat that has never been toggled falls back to the Settings preference.
   * That switch — "Transliteration · Type in English, send in your script" —
   * wrote `profile.translit` and NOTHING read it, so turning it on or off did
   * nothing anywhere in the app; the only working control was the 文A button in
   * each chat's header. `undefined` rather than a truthiness test is what keeps
   * a deliberate per-chat "off" from being overridden by a global "on".
   */
  const xlitOn = () => {
    const c = db.convo(roomId) || convo
    return c.xlit === undefined ? Boolean(db.profile().translit) : Boolean(c.xlit)
  }

  function setCompose (patch) {
    db.upsertConvo({ roomId, ...patch })
    updateToggles()
    updatePreview()
    renderList()
  }

  /** Which language this chat is typed in. "Auto" lets detection guess. */
  const XLIT_LANGS = ['ta', 'te', 'ml', 'kn', 'hi', 'mr', 'bn', 'gu', 'pa', 'ur']

  const xlitChip = el('button', {
    class: 'xchip', type: 'button', 'aria-label': 'Language you type in',
    onclick () {
      const cur = (db.convo(roomId) || convo).xlitLang || null
      actionSheet([
        { label: (cur ? '' : '✓ ') + 'Auto-detect', fn: () => setXlitLang(null) },
        ...XLIT_LANGS.map((code) => ({
          label: (cur === code ? '✓ ' : '') + langName(code),
          fn: () => setXlitLang(code)
        }))
      ], 'You are typing in…')
    }
  })

  function setXlitLang (code) {
    db.upsertConvo({ roomId, xlitLang: code, translitLang: code })
    xlitCache.clear()
    updateToggles()
    renderList()
    updatePreview()
  }
  /**
   * Transliteration is a MODE for the whole chat, not a per-message choice:
   * one tap and everything you type is converted into its own script. The
   * language is DETECTED from what you type — no picking a language first,
   * because the app already knows how to recognise "ta-Latn" and friends.
   * The ▾ chip still pins a language when someone wants to force one.
   */
  /**
   * Transliteration is a plain switch — no language question, because it
   * detects. Turning it on rewrites the WHOLE conversation (old messages and
   * everything arriving after), not just what you type next.
   */
  txBtn.addEventListener('click', () => {
    const on = !xlitOn()
    const { mode } = composeState()
    db.upsertConvo({
      roomId,
      xlit: on,
      // Translation owns the composer when both are on: it changes what is
      // actually sent, so it must not be silently overridden.
      composeMode: mode === 'translate' ? mode : (on ? 'translit' : null)
    })
    updateToggles()
    updatePreview()
    renderList()
    scrollBottom()
    ctx.toast(on ? 'Transliteration on for this chat' : 'Transliteration off')
  })

  const top = el('div', { class: 'top' }, [
    backBtn, avBtn, who,
    el('div', { class: 'hact' }, [txBtn, xlitChip, trBtn, trChip])
  ])

  const thread = el('div', { class: 'thread' })
  const newChip = el('button', {
    class: 'newchip', type: 'button', text: 'New messages', style: 'display:none',
    onclick () { scrollBottom(); newChip.style.display = 'none' }
  })
  const threadwrap = el('div', { class: 'threadwrap' }, [thread, newChip])

  /* composer */
  const replyName = el('b')
  const replySnippet = el('span')
  const replybar = el('div', { class: 'replybar', style: 'display:none' }, [
    el('div', { class: 'rq' }, [replyName, replySnippet]),
    el('button', { class: 'rx', type: 'button', 'aria-label': 'Cancel reply', html: IC.x, onclick: clearReply })
  ])

  const tlTag = el('div', { class: 'tlTag2', style: 'display:none' })
  const tlMain = el('div', { class: 'tlMain', style: 'display:none' })
  const tlSub = el('div', { class: 'tlSub', style: 'display:none' })
  const tlprev = el('div', { class: 'tlprev', style: 'display:none' }, [tlTag, tlMain, tlSub])

  const input = el('input', { type: 'text', placeholder: 'Type a message…', autocomplete: 'off' })
  // Shows while the per-chat timer mode is on; tapping reopens the wheel.
  const ttlChip = el('button', {
    class: 'ttlchip', type: 'button', style: 'display:none', title: 'Timer messages',
    onclick: openTimerSheet
  })
  // The small IN-FIELD button is the voice-note mic (tap to record, tap the
  // big stop button to review). Dictation lives in the attach grid now.
  const voiceBtn = el('button', {
    class: 'voiceB', type: 'button', title: 'Record a voice note',
    'aria-label': 'Record a voice note', html: IC.micGhost,
    onclick () { if (recording) stopRecording(); else startRecording() }
  })
  // 'Listening…' hint chip — visible only while a dictation session runs.
  const dictHint = el('span', { class: 'dicthint', style: 'display:none', text: 'Listening…' })
  const field = el('div', { class: 'field' }, [ttlChip, dictHint, input, voiceBtn])

  const plusBtn = el('button', {
    class: 'plusB', type: 'button', 'aria-label': 'Attach', html: IC.plus, onclick: openAttach
  })

  const recTime = el('span', { class: 'rectime', text: '0:00' })
  // Live input waveform between the blinking dot and the timer.
  const recWave = el('div', { class: 'recwave', 'aria-hidden': 'true' },
    Array.from({ length: REC_BARS }, () => el('i')))
  const recbar = el('div', { class: 'recbar' }, [
    el('span', { class: 'recdot' }),
    recWave,
    recTime
  ])

  const micBtn = el('button', {
    class: 'micB', type: 'button', 'aria-label': 'Take a photo', html: IC.camera
  })
  // One button, three moods: send text / stop recording / open the camera
  // (capture → editor). Voice notes start from the small in-field mic.
  micBtn.addEventListener('click', () => {
    if (recording) { stopRecording(); return }
    if (input.value.trim()) { sendText(); return }
    viewOncePick = false
    startEarlyActivity('photo')
    cameraInput.click()
  })

  /** Voice review bar — swaps in for the composer after a recording stops. */
  const confbar = el('div', { class: 'confbar', style: 'display:none' })

  const photoInput = el('input', { type: 'file', accept: 'image/*', multiple: '', style: 'display:none' })
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none' })
  const fileInput = el('input', { type: 'file', style: 'display:none' })
  const videoInput = el('input', { type: 'file', accept: 'video/*', style: 'display:none' })

  const bar = el('div', { class: 'bar' }, [plusBtn, field, recbar, micBtn, photoInput, cameraInput, fileInput, videoInput])
  const composer = el('div', { class: 'composer' }, [replybar, tlprev, bar, confbar])

  root.appendChild(top)
  root.appendChild(threadwrap)
  root.appendChild(composer)

  /* ------------------------------------------------------------ scroll */
  function nearBottom () {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < NEAR_BOTTOM_PX
  }
  function scrollBottom () { thread.scrollTop = thread.scrollHeight }
  thread.addEventListener('scroll', () => {
    if (nearBottom()) newChip.style.display = 'none'
  })

  /* ------------------------------------------------------------ header */
  function updateAvatar () {
    clear(avBtn)
    const online = conn.peerCount > 0 || convo.kind === 'demo'
    avBtn.appendChild(avatar(convo.peer || { name: convo.title }, 38, { dot: online }))
  }

  function updateToggles () {
    const { mode, langTo } = composeState()
    const trOn = mode === 'translate' && Boolean(langTo)
    const txOn = xlitOn()
    for (const [button, on, title] of [
      [trBtn, trOn, trOn ? `Translation · ${langName(langTo)}` : 'Translation'],
      [txBtn, txOn, txOn ? 'Transliteration · on' : 'Transliteration']
    ]) {
      button.setAttribute('aria-pressed', String(on))
      button.dataset.on = String(on)
      button.title = title
      button.setAttribute('aria-label', title)
    }
    const pinned = (db.convo(roomId) || convo).xlitLang
    xlitChip.textContent = (pinned ? langName(pinned) : 'Auto') + ' ▾'
    xlitChip.style.display = txOn ? '' : 'none'
    xlitChip.dataset.pinned = String(Boolean(pinned))

    // Same rule as the 文A chip: the target only appears once the feature it
    // belongs to is on, so the header does not fill with inert controls.
    trChip.textContent = langName(langTo || 'en') + ' ▾'
    trChip.style.display = trOn ? '' : 'none'
    trChip.dataset.pinned = 'true'
  }

  function updateStatus () {
    if (!mounted) return
    const c = db.convo(roomId) || convo
    const t = conn.typing
    let typing = false
    let text
    if (t && t.until > Date.now()) {
      typing = true
      text = ACTIVITY_TEXT[t.kind] || ACTIVITY_TEXT.typing
      drop(statusTimer)
      statusTimer = later(updateStatus, t.until - Date.now() + 60)
    } else if (c.kind === 'demo') {
      text = 'online · demo'
    } else if (conn.peerCount > 0 || lobby.peers().some((x) => x.id === c.peer?.id)) {
      // Connected to this room, or visible in the app-wide lobby: online.
      text = 'Online'
    } else if (c.peerSeen) {
      text = `Last seen ${fmtDay(c.peerSeen)}`
    } else {
      text = 'Offline'
    }
    if (c.mode === 'nearby' && !typing) {
      const live = lobby.peers().find((x) => x.id === c.peer?.id)
      const d = fmtDistance(distanceM(lobby.myPosition(), live))
      if (d) text += ` · ${d} away`
    }
    statusEl.textContent = text
    statusEl.classList.toggle('typing', typing)
    input.placeholder = 'Type a message…'
  }

  /* ------------------------------------------------------- translation */
  /* ------------------------------------------- whole-chat transliteration */
  /**
   * With 文A on, every text message in the thread — old ones, mine, theirs,
   * and everything arriving later — gets a second line in the other script:
   * romanized ("Tanglish") becomes the real script, and a native-script
   * message becomes readable in English letters. The words never change;
   * that is translation's job.
   */
  const xlitCache = new Map()          // id|text -> {text, lang} | 'pending' | null

  /* Keyed on the text as well as the id, because a message can be EDITED.
   * Keyed on the id alone, `refreshRow` rebuilt the bubble after an edit and
   * `applyXlit` found a cache hit — so the reading under the new words was
   * still the old words' reading, and nothing ever recomputed it. */
  const xlitKey = (m) => `${m.id}|${m.text || ''}`

  /**
   * Owner's rule (2026-07-25): "enga iruka ?" → "where are you" — English
   * letters in, English words out. So this reads whatever language the
   * message is in (romanized or native script) and renders it in plain
   * English. Messages already in English are left alone.
   */
  /** The language this conversation actually speaks, learned as it goes. */
  const chatLang = () => {
    const c = db.convo(roomId) || convo
    return c.xlitLang || c.translitLang || c.myLang || null
  }

  /** True when the owner named the language — detection must not override. */
  const langIsPinned = () => Boolean((db.convo(roomId) || convo).xlitLang)

  /**
   * Measured on the live service: romanized detection is 0% accurate at one
   * word and 12% at two ("vanakkam" reads as English, "kem cho" as
   * Vietnamese). Below this many words we do not ask — the conversation's own
   * language is a far better answer than a confident wrong one.
   */
  const DETECT_MIN_WORDS = 3
  const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length

  /**
   * Measured against production: the one-shot LLM read costs ~3.7s, while the
   * classic chain costs ~1.2-2.4s (detect 1.2s + transliterate 0.6s +
   * translate 0.6s, and detect is skipped once the language is known).
   *
   * Waiting for the better answer before showing any answer meant every
   * message sat blank for nearly four seconds. Both now run at once: the
   * classic chain paints as soon as it lands, and the LLM quietly replaces it
   * if it disagrees. Nobody waits for the slow path to see something true.
   */
  async function computeXlit (m, onEarly) {
    const text = m.text

    /* Plain English leaves before anything can form an opinion about it —
     * not the LLM below, not the pinned chat language, not detection. This
     * message was delivered to the recipient as Kannada:
     *   "Type something in Kannada in English and send me"
     *      -> "It's been so many days since I saw you, how are you?"
     * The LLM read the word "Kannada" inside an English sentence and obliged.
     * A deterministic test cannot be talked into that. */
    if (isPlainEnglish(text)) return null

    /* One LLM call answers language + script + English together, and handles
     * the ear-spelling the classic chain cannot ("Ippo variya" → "Are you
     * coming now?" vs "Is it tax now?"). It also leaves names and English
     * alone by itself. Everything below is the fallback when it is down. */
    /* Stage 0, instant and offline: when the language is already known, the
     * bundled transliterator converts the script here on the device with no
     * network at all. The script line — the part a reader of that language
     * actually wants — can therefore appear on the same frame the message
     * does, while the meaning is still being fetched. */
    const known = chatLang()
    if (onEarly && known && hasLocalScript(known) && isLatinScript(text)) {
      try {
        const local = transliterate(text, known)
        /* The engine converts whatever it is handed — it has no idea whether
         * the words were ever Indic. "Netflix and chill" came back as
         * "ணெட்fலிx அந்ட் சில்ல்" and was painted instantly, labelled
         * "Tamil · Transliterated", because this stage is the fastest and most
         * confident one in the UI.
         *
         * Leftover ASCII letters are the tell: Tamil has no f/x/z, so a real
         * transliteration consumes every Latin letter. Anything left behind
         * means the input was not the language we assumed, and the honest
         * move is to show nothing and let the network stages decide. */
        if (local && local !== text && !/[a-z]/i.test(local)) {
          onEarly({ lang: known, script: local, text: '', rank: 1 })
        }
      } catch { /* the network stages still cover it */ }
    }

    const pinned = (db.convo(roomId) || convo).xlitLang
    const readPromise = readMessage(text, pinned ? langName(pinned) : '')

    // Kick the classic chain off NOW rather than only when the LLM fails.
    // Whatever it finds is shown immediately; the LLM answer supersedes it.
    let llmSettled = false
    const classicPromise = computeXlitClassic(text).catch(() => null)
    classicPromise.then((early) => {
      if (early && !llmSettled && onEarly) onEarly({ ...early, rank: 2 })
    })

    const read = await readPromise
    llmSettled = true
    if (read) {
      if (read.lang === 'en' || !read.english) return null
      return { text: read.english, lang: read.lang, script: read.script }
    }
    return classicPromise
  }

  /** The deterministic chain: detect -> own script -> English. Slower to be
   *  wrong than the LLM on ear-spelling, but far quicker to answer. */
  async function computeXlitClassic (text) {
    const latin = isLatinScript(text)

    // Already in a real script: translating it straight is reliable.
    if (!latin) {
      const res = await translateText(text, null, 'en')
      if (!res?.text || res.text === text) return null
      return { text: res.text, lang: String(res.detected || '').split('-')[0] }
    }

    /* Romanized. Measured head-to-head: going through the language's own
     * script first is dramatically better than translating the ear-spelling
     * directly ("enga vetuku variya" → "Let's go to our house…" instead of
     * "Let's eat one of our cuts"), because the transliterator knows real
     * words. So the only question is WHICH language. */
    let lang = chatLang()
    let viaChat = Boolean(lang)
    /* Even with a language pinned, plain English must pass through untouched —
     * otherwise "ok see you" gets pushed through Tamil and comes back as
     * "Okay, C U.". One-word messages skip this test because detection calls
     * everything short English ("vanakkam" included). */
    /* Detection only earns a vote at three words or more — below that it
     * calls almost everything English, which silently swallowed real Tamil
     * ("Naan varala"). Short English is caught by a word list instead. */
    if (wordCount(text) >= DETECT_MIN_WORDS) {
      const hit = await detectLanguage(text)
      if (hit?.base === 'en') return null
      if (!langIsPinned() && hit?.romanized && SCRIPT_MAP[hit.base]) {
        lang = hit.base
        viaChat = false
        rememberChatLang(lang)
      }
    } else if (looksEnglish(text)) {
      return null
    }
    if (!lang || lang === 'en' || !SCRIPT_MAP[lang]) return null

    const native = await transliterateRemote(text, lang)
    if (!native || native === text) return null
    const res = await translateText(native, lang, 'en')
    if (!res?.text || res.text === native) return null
    // `native` is the message in its own script — the actual transliteration.
    // It used to be discarded as a mere step on the way to English, which is
    // why the bubble could only ever show two of the three layers.
    return { text: res.text, lang, script: native, viaChat }
  }

  function rememberChatLang (base) {
    const c = db.convo(roomId) || convo
    if (!base || base === 'en' || c.translitLang === base) return
    db.upsertConvo({ roomId, translitLang: base })
    /* Short messages ("vanakkam", "enga iruka?") give up when the chat has no
     * known language yet. Learning one makes them answerable, so drop those
     * give-ups and let them run again — otherwise the first lines of every
     * conversation stay blank forever.
     *
     * Capped, because this used to re-read the WHOLE thread. renderList()
     * renders the entire store with no virtualisation and MAX_STORED is 500,
     * so one language-learn event could fire up to 500 `?op=read` calls — 500
     * LLM completions — in a burst. Now it re-reads the tail of the
     * conversation, which is the part anyone is looking at and the part the
     * give-ups are actually in; scrolling back further is not a use case that
     * justifies a five-hundred-call fan-out. */
    const RETRY_TAIL = 30
    const recent = Array.from(msgEls.values())
      .map(({ message }) => message)
      .filter((m) => m && (!m.kind || m.kind === 'text'))
      .slice(-RETRY_TAIL)
    let retried = false
    for (const m of recent) {
      if (xlitCache.get(xlitKey(m)) === null) { xlitCache.delete(xlitKey(m)); retried = true }
    }
    if (retried && mounted) for (const m of recent) applyXlit(m)
  }

  /**
   * The one line above a reading: where it came from and what was done to it.
   * "Tamil · Translated".
   *
   * The engine name is deliberately gone — whether Azure or a local model
   * answered is our problem, not the reader's. When detection did not settle
   * on a language we know, the mode stands alone rather than printing a raw
   * code or naming a language we are guessing at.
   */
  function readingTag (code, mode) {
    const base = String(code || '').split('-')[0]
    if (!base || base === 'en') return mode
    const name = langName(base)
    return name && name !== base ? `${name} · ${mode}` : mode
  }

  function applyXlit (m) {
    const entry = msgEls.get(m.id)
    const bub = entry?.wrap.querySelector('.bubIn, .bubOut')
    if (!bub) return
    const existing = bub.querySelector('.xl')
    if (!xlitOn() || !m.text || (m.kind && m.kind !== 'text')) { existing?.remove(); return }

    if (!xlitCache.has(xlitKey(m))) {
      xlitCache.set(xlitKey(m), 'pending')
      // onEarly paints the fast chain's answer the moment it lands, seconds
      // before the LLM replies; the final .then then supersedes it.
      /* Three stages land in order, each better than the last:
       *   rank 1  on-device script, instant
       *   rank 2  classic chain, ~1s, adds the meaning
       *   final   the LLM, ~3.7s, supersedes both if it disagrees
       * A stage only paints if nothing better is already showing. */
      computeXlit(m, (early) => {
        if (!mounted || !early) return
        const cur = xlitCache.get(xlitKey(m))
        if (cur !== 'pending' && (cur?.rank ?? 9) >= (early.rank ?? 0)) return
        xlitCache.set(xlitKey(m), early)
        const stick = nearBottom()
        applyXlit(m)
        if (stick) scrollBottom()
      })
        .then((res) => {
          /* The final answer must not be strictly worse than what is already
           * on screen. Setting this unconditionally meant a null result — both
           * network stages failing — ERASED the good instant reading seconds
           * after it appeared, and an LLM answer carrying no script line
           * deleted the script the classic chain had already produced.
           * Nothing here may take information away. */
          const cur = xlitCache.get(xlitKey(m))
          const showing = cur && cur !== 'pending' ? cur : null
          if (!res) { if (!showing) xlitCache.set(xlitKey(m), null); return }
          xlitCache.set(xlitKey(m), {
            ...res,
            script: res.script || showing?.script || null,
            rank: 9
          })
        })
        .catch(() => { if (xlitCache.get(xlitKey(m)) === 'pending') xlitCache.set(xlitKey(m), null) })
        .then(() => {
          if (!mounted) return
          const stick = nearBottom()
          applyXlit(m)
          if (stick) scrollBottom()
        })
    }

    const cur = xlitCache.get(xlitKey(m))
    if (cur === null) { existing?.remove(); return }
    const pending = cur === 'pending'
    /* Three layers, in the order they are useful:
     *   the bubble's own text  — what was typed ("Aparam enga iruka?")
     *   .xlScript              — the same words in their own script
     *   .xlText                — what it means
     * The middle line is the transliteration itself. It was being computed and
     * then thrown away, so the feature called "Transliterated" never actually
     * showed one. It is skipped when it would only repeat the original. */
    const script = !pending && cur.script && flatten(cur.script) !== flatten(m.text)
      ? cur.script
      : null
    // The instant stage has the script but not yet the meaning; the meaning
    // line shows an ellipsis rather than collapsing, so nothing shifts when it
    // arrives a moment later.
    const meaningPending = !pending && !cur.text
    const node = el('div', { class: 'xl' + (pending || meaningPending ? ' pend' : '') }, [
      el('span', {
        class: 'xlTag',
        text: pending ? 'Reading…' : readingTag(cur.lang, 'Transliterated')
      }),
      script ? el('span', { class: 'xlScript', lang: cur.lang, text: script }) : null,
      el('span', { class: 'xlText', text: pending || meaningPending ? '…' : cur.text })
    ])
    /* Re-query rather than trusting the `existing` captured at entry. The
     * instant stage calls onEarly SYNCHRONOUSLY, which re-enters this function
     * and appends a block while the outer call is still holding a stale null —
     * so the outer call appended a second one, and every sent bubble carried a
     * duplicate reading stuck on "…". Reading the DOM at the moment of writing
     * makes the order of those calls irrelevant. */
    const live = bub.querySelector('.xl')
    if (live) live.replaceWith(node)
    else bub.appendChild(node)
  }

  function applyTranslation (m) {
    const entry = msgEls.get(m.id)
    const bub = entry?.wrap.querySelector('.bubIn')
    if (!bub) return
    const existing = bub.querySelector('.tr')
    const p = db.profile()
    // The chat's lock governs BOTH directions: what I read here is my own
    // language for this conversation, not the profile default. m.lang is only
    // the sender's profile claim, so it cannot decide whether to translate —
    // detection does that, and an unchanged result costs nothing to show.
    const readLang = myReadLang()
    const { mode: cmode, langTo: clang } = composeState()
    const want = m.from !== myId && (!m.kind || m.kind === 'text') &&
      Boolean(m.text) && Boolean(readLang) && p.autoTranslate &&
      // Translation is opt-in per chat: with the globe off, incoming messages
      // are left exactly as they arrived.
      cmode === 'translate' && Boolean(clang)
    if (!want) { existing?.remove(); return }

    if (!trCache.has(m.id)) {
      // Instant path: the sender pre-translated into my language and shipped
      // it inside the message — nothing to fetch, zero wait.
      if (m.tr?.lang === readLang && m.tr.text) {
        trCache.set(m.id, { text: m.tr.text, engine: 'instant' })
      } else {
        trCache.set(m.id, 'pending')
        // m.lang is the SENDER'S profile language, not a fact about this
        // text — someone set to English types romanized Tamil all the time.
        // Detection beats the claim and costs one round trip instead of two.
        translateText(m.text, null, myReadLang())
          .then((res) => { trCache.set(m.id, res) })
          .catch(() => { trCache.set(m.id, { text: null, engine: null }) })
          .then(() => {
            if (!mounted) return
            const stick = nearBottom()
            applyTranslation(m)
            if (stick) scrollBottom()
          })
      }
    }

    const cur = trCache.get(m.id)
    if (cur !== 'pending' && cur?.engine === null) { existing?.remove(); return }
    if (cur !== 'pending' && cur?.text && flatten(cur.text) === flatten(m.text)) {
      existing?.remove()
      return
    }

    const pending = cur === 'pending'
    // The instant path carries no detection — it was translated by the sender,
    // so their profile language is the only source we have.
    const from = cur?.detected || (cur?.engine === 'instant' ? m.lang : null)
    const node = el('div', { class: 'tr' }, [
      el('div', { class: 'trTag', text: pending ? 'Translating…' : readingTag(from, 'Translated') }),
      el('div', { class: 'trTxt', text: pending ? '…' : cur.text })
    ])
    if (existing) existing.replaceWith(node)
    else bub.insertBefore(node, bub.querySelector('.meta'))
  }

  function refreshTranslations () {
    for (const { message } of msgEls.values()) {
      if (message.from !== myId && (!message.kind || message.kind === 'text')) applyTranslation(message)
    }
  }

  /* ---------------------------------------------------------- messages */
  function dayLabel (ts) {
    return new Date(ts).toDateString() === new Date().toDateString() ? 'Today' : fmtDay(ts)
  }

  /**
   * Scroll to the quoted message and flash it — WhatsApp's behaviour, and the
   * only reason a quote is worth tapping.
   */
  function jumpToMessage (id) {
    const entry = msgEls.get(id)
    if (!entry) { ctx.toast('That message is no longer here'); return }
    entry.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Re-adding the class only repeats the flash after a forced reflow;
    // otherwise the browser folds both changes into one frame.
    entry.wrap.classList.remove('jumped')
    void entry.wrap.offsetWidth
    entry.wrap.classList.add('jumped')
    setTimeout(() => entry.wrap.classList.remove('jumped'), 1500)
  }

  function buildQuote (replyToId) {
    const orig = conn.store.list().find((x) => x.id === replyToId)
    if (!orig) return el('div', { class: 'q qgone', text: 'Original message deleted' })
    return el('div', {
      class: 'q',
      role: 'button',
      tabindex: '0',
      title: 'Go to message',
      // Stop here, or the tap also reaches the bubble's press and double-tap
      // handlers and opens the message sheet on the way past.
      onclick: (e) => { e.stopPropagation(); jumpToMessage(replyToId) },
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        jumpToMessage(replyToId)
      }
    }, [
      el('b', { text: orig.from === myId ? 'You' : (orig.name || convo.peer?.name || '') }),
      kindLabel(orig)
    ])
  }

  /**
   * Voice bubble with a live waveform: peaks are decoded once per message id,
   * playback colours the bars left-to-right, and the bars around the playhead
   * breathe with the LIVE amplitude (AnalyserNode + rAF). If decoding fails
   * (unsupported codec, blocked AudioContext) the plain player still works.
   */
  function buildVoice (m) {
    /* 'auto', not 'metadata': the note is already on the device or already
     * arriving, and asking only for metadata is what left the element with no
     * audio to play — the first tap ran a source that had no samples yet, so
     * it appeared to play in silence, and only the second tap (by which time
     * the bytes had landed) made a sound. */
    const audio = el('audio', { src: m.data, preload: 'auto' })
    const btn = el('button', { class: 'vplay', type: 'button', 'aria-label': 'Play voice note', html: IC.play })
    const durEl = el('span', { class: 'vdur', text: `${m.dur || 0}s` })
    /* Built up front rather than when the peaks finish decoding, so the bar is
     * seekable immediately and the row never reflows under the finger. */
    const wave = el('div', { class: 'wave', role: 'slider', tabindex: '0',
      'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' })
    const wrap = el('div', { class: 'voice' }, [btn, wave, durEl, audio])

    let bars = null
    let clipDur = m.dur || 0
    let raf = 0
    let analyser = null
    let ampBuf = null
    let wantPlay = false      // tapped play before there was anything to play

    decodePeaks(m).then((decoded) => {
      if (!mounted || !decoded) return
      clipDur = decoded.duration || clipDur
      bars = decoded.peaks.map((p) => {
        const bar = el('i', { style: `height:${Math.round(4 + p * 18)}px` })
        wave.appendChild(bar)
        return bar
      })
      paintBars()
    })

    /* ------------------------------------------------------- readiness */

    /** Enough decoded to make sound. readyState 2 = HAVE_CURRENT_DATA. */
    const ready = () => audio.readyState >= 2

    /** How much has actually arrived, 0..1 — what the percentage reports. */
    function loadedFrac () {
      try {
        const total = effDur()
        if (!audio.buffered.length || !total) return 0
        return Math.min(1, audio.buffered.end(audio.buffered.length - 1) / total)
      } catch { return 0 }
    }

    /** Buffered rarely lands exactly on the duration, so a strict ratio parks
     *  at 99% forever. Once the browser says it can play through, it is done. */
    const fullyLoaded = () => audio.readyState >= 3 || loadedFrac() >= 0.98

    function showLoading () {
      if (fullyLoaded()) { showDuration(); return }
      const pct = Math.round(loadedFrac() * 100)
      // A percentage that says nothing is worse than a plain word.
      durEl.textContent = pct > 0 ? `${pct}%` : 'Loading…'
      durEl.classList.add('loading')
    }

    /**
     * How many seconds of this note never arrived, or 0 if it looks whole.
     *
     * The sender declared the length when they recorded it. When the file
     * turns out to be materially shorter, it was cut in transit — and the old
     * code silently ADOPTED the short duration: 40 seconds of a five-minute
     * note drew a full 28-bar waveform, labelled itself "1s", played for 1.2s
     * and stopped, with no signal anywhere that two thirds of the message was
     * missing. That is how someone ends up sure they heard the whole thing.
     *
     * The threshold is ABSOLUTE, not a ratio, because the noise it has to
     * clear is absolute: `dur` is wall-clock seconds rounded to an integer
     * (media.js), so it can sit up to half a second above the encoded length,
     * and Opus container framing adds tens of milliseconds on top — a real 3s
     * note measures 2.941s. A ratio would either flag those or miss 40
     * seconds cut off a five-minute note, which is 13%.
     */
    function missingSecs () {
      const declared = Number(m.dur) || 0
      const real = Number.isFinite(audio.duration) ? audio.duration : 0
      if (!declared || !real) return 0
      const short = declared - real
      return short > 1.5 ? short : 0
    }

    function showDuration () {
      durEl.classList.remove('loading')
      if (missingSecs()) {
        durEl.textContent = `${Math.round(effDur())}s of ${Math.round(m.dur)}s`
        durEl.classList.add('damaged')
        durEl.title = 'This voice note did not arrive in full'
        return
      }
      durEl.classList.remove('damaged')
      durEl.textContent = `${Math.round(effDur())}s`
    }

    const effDur = () => (Number.isFinite(audio.duration) && audio.duration) || clipDur || 1

    /**
     * Wire the waveform analyser — but ONLY onto a context that is actually
     * running.
     *
     * createMediaElementSource permanently reroutes this element's audio into
     * the Web Audio graph. On iOS a suspended context then outputs SILENCE:
     * the note "plays" (time advances, bars animate) and nothing can be heard,
     * for that tap and every tap after it. The breathing-bar effect is not
     * worth that trade, so when the context will not run we simply never
     * connect and let the plain <audio> element make the sound.
     */
    function setupAnalyser () {
      if (analyser || !bars) return
      try {
        const ac = getAudioCtx()
        if (!ac || ac.state !== 'running') return
        let entry = mediaSources.get(audio)
        if (!entry) {
          // A MediaElementSource can only ever be created once per element.
          const src = ac.createMediaElementSource(audio)
          const an = ac.createAnalyser()
          an.fftSize = 256
          src.connect(an)
          an.connect(ac.destination)
          entry = { analyser: an }
          mediaSources.set(audio, entry)
        }
        analyser = entry.analyser
        ampBuf = new Uint8Array(analyser.fftSize)
      } catch { analyser = null }
    }

    function paintBars (finalFrac) {
      const frac = finalFrac !== undefined ? finalFrac : Math.min(1, audio.currentTime / effDur())
      wave.setAttribute('aria-valuenow', String(Math.round((frac || 0) * 100)))
      if (!bars) return
      const playPos = frac * bars.length
      let amp = 0
      if (analyser && !audio.paused) {
        analyser.getByteTimeDomainData(ampBuf)
        let sum = 0
        for (let i = 0; i < ampBuf.length; i++) {
          const v = (ampBuf[i] - 128) / 128
          sum += v * v
        }
        amp = Math.min(1, Math.sqrt(sum / ampBuf.length) * 3)
      }
      const head = Math.floor(playPos)
      for (let i = 0; i < bars.length; i++) {
        bars[i].classList.toggle('played', i < playPos)
        const near = !audio.paused && Math.abs(i - head) <= 1
        bars[i].style.transform = near && amp > 0 ? `scaleY(${(1 + amp * 0.9).toFixed(2)})` : ''
      }
    }

    function loop () {
      if (!mounted || audio.paused) return
      paintBars()
      raf = requestAnimationFrame(loop)
    }

    const stopLoop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0 } }
    const stopAll = () => { stopLoop(); try { audio.pause() } catch { /* detached */ } }
    voiceStops.add(stopAll)

    /** Start now if we can, otherwise remember the intent and start the moment
     *  there is audio. Either way the FIRST tap is the one that plays. */
    async function start () {
      /* Resume FIRST, and wait for it. A tap is the only moment iOS will let
       * an AudioContext start, and resume() is asynchronous — the old code
       * fired it and carried on, so the analyser got attached to a context
       * that was still suspended and the note played silently. */
      try {
        const ac = getAudioCtx()
        if (ac && ac.state === 'suspended') await ac.resume()
      } catch { /* no Web Audio here; the plain element still plays */ }
      setupAnalyser()

      if (!ready()) {
        wantPlay = true
        showLoading()
        try { audio.load() } catch { /* already loading */ }
        return
      }
      wantPlay = false
      /* B6 — ONE AUDIBLE MEDIA AT A TIME, AND THE ORDER MATTERS.
       *
       * This called `audio.play()` directly, so a voice note and a Moments
       * video could be audible together: the video surface routes every
       * element through the shared owner and chat did not, which means there
       * were two independent notions of "what is playing" and neither could
       * see the other.
       *
       * `playExclusive` pauses the current owner FIRST, then takes ownership,
       * then plays. Play-new-then-pause-old is the ordering that produces the
       * audible overlap, however brief, and on a slow decode it is not brief. */
      playExclusive(audio).then((ok) => {
        if (ok) return
        wantPlay = false
        showDuration()
        ctx.toast('Could not play this voice note')
      })
    }

    btn.addEventListener('click', () => {
      if (audio.paused) start()
      else { wantPlay = false; audio.pause() }
    })

    // Progress while the bytes land, and the deferred start once they have.
    audio.addEventListener('progress', () => { if (wantPlay) showLoading() })
    audio.addEventListener('canplay', () => {
      if (!wantPlay) return
      wantPlay = false
      showDuration()
      /* Same guard as start(), because this path skipped it. The context can
       * suspend between the tap and the bytes landing — an audio-session
       * interruption, a Bluetooth route change, backgrounding — and by then
       * the element is permanently rerouted into the Web Audio graph, so
       * playing into a suspended context is silence with a moving timer. That
       * is the original bug, reached through a narrower door.
       *
       * No gesture is left to lose here (this is an async event either way),
       * so the resume is free: if the browser refuses it, play anyway. */
      // Through the shared owner here too — a resume is still a start, and it
      // must silence whatever else holds the speaker.
      const go = () => playExclusive(audio).then((ok) => { if (!ok) ctx.toast('Could not play this voice note') })
      const ac = getAudioCtx()
      if (ac && ac.state === 'suspended') ac.resume().then(go, go)
      else go()
    })
    audio.addEventListener('loadedmetadata', () => { if (!wantPlay) showDuration(); paintBars() })
    audio.addEventListener('error', () => {
      wantPlay = false
      durEl.classList.remove('loading')
      durEl.textContent = 'Unavailable'
    })

    /* ------------------------------------------------------------ seek */

    /** Fraction of the way across the bar for a pointer at clientX. */
    function fracAt (clientX) {
      const rect = wave.getBoundingClientRect()
      if (!rect.width) return 0
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    }

    function seekTo (frac) {
      const target = frac * effDur()
      if (!Number.isFinite(target)) return
      try { audio.currentTime = target } catch { /* not seekable yet */ }
      paintBars(frac)
      wave.setAttribute('aria-valuenow', String(Math.round(frac * 100)))
    }

    let scrubbing = false
    wave.addEventListener('pointerdown', (e) => {
      scrubbing = true
      wave.setPointerCapture?.(e.pointerId)
      seekTo(fracAt(e.clientX))
    })
    wave.addEventListener('pointermove', (e) => { if (scrubbing) seekTo(fracAt(e.clientX)) })
    const endScrub = () => { scrubbing = false }
    wave.addEventListener('pointerup', endScrub)
    wave.addEventListener('pointercancel', endScrub)
    // Keyboard seeking, since the bar is a real slider.
    wave.addEventListener('keydown', (e) => {
      const step = 5 / effDur()
      if (e.key === 'ArrowRight') { seekTo(Math.min(1, audio.currentTime / effDur() + step)); e.preventDefault() }
      else if (e.key === 'ArrowLeft') { seekTo(Math.max(0, audio.currentTime / effDur() - step)); e.preventDefault() }
      else if (e.key === ' ' || e.key === 'Enter') { audio.paused ? start() : audio.pause(); e.preventDefault() }
    })
    audio.addEventListener('play', () => {
      // Playing and "99%" cannot both be true; the duration is the honest label.
      showDuration()
      btn.innerHTML = IC.pause
      btn.classList.add('playing')
      stopLoop()
      raf = requestAnimationFrame(loop)
    })
    audio.addEventListener('pause', () => {
      btn.innerHTML = IC.play
      btn.classList.remove('playing')
      stopLoop()
      paintBars()
    })
    audio.addEventListener('ended', () => {
      btn.innerHTML = IC.play
      btn.classList.remove('playing')
      stopLoop()
      paintBars(0)
    })
    audio.addEventListener('timeupdate', () => { if (audio.paused) paintBars() })
    return wrap
  }

  function openImage (data) {
    const overlay = el('div', { class: 'imgview' }, [el('img', { src: data, alt: '' })])
    overlay.addEventListener('click', () => overlay.remove())
    root.appendChild(overlay)
  }

  /** Fullscreen video, same overlay grammar as openImage. Backdrop closes;
   * taps on the player itself keep working the native controls. */
  function openVideoView (data) {
    const overlay = el('div', { class: 'imgview' }, [
      el('video', { src: data, controls: '', autoplay: '', playsinline: '', 'webkit-playsinline': '' })
    ])
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    root.appendChild(overlay)
  }

  /**
   * Tap a private photo. The bytes are fetched if this device does not hold
   * them (they are never persisted, so a reload loses them — deliberately),
   * and only then is anything shown.
   *
   * The server serves them exactly once, to the person who claimed the view,
   * and destroys them the moment openViewOnce reports the open. A photo that
   * has already burned answers "no longer available", which is the truth.
   */
  function tapViewOnce (m, button) {
    if (m.data) { openViewOnce(m); return }
    button?.classList.add('loading')
    rooms.fetchAttachment(roomId, m.id)
      .then((data) => { if (mounted) openViewOnce({ ...m, data }) })
      .catch(() => ctx.toast('That private photo is no longer available'))
      .finally(() => button?.classList.remove('loading'))
  }

  /**
   * The burst viewer. A countdown ring runs for the sender-chosen time while
   * the photo shows; at zero (or on early close) the photo bursts into
   * particles.
   *
   * THE BURN IS COMMITTED HERE, AT OPEN — before a pixel is drawn — not when
   * the countdown ends. It used to be the other way round, and that made
   * "exactly one view" false: killing the app mid-view left the photo intact
   * and openable again, reproduced end to end with nothing but a reload.
   */
  function openViewOnce (m) {
    const secs = Math.max(1, m.burst || 10)
    /* One call does three things, in this order and before anything renders:
     * tombstone it locally, tell the server to delete the stored slices, and
     * tell the sender their countdown has started. Everything below is
     * animation over a copy that exists only in this function's scope. */
    try { rooms.viewOnceOpen(roomId, m.id, secs) } catch { /* offline */ }
    removeRow(m.id)
    const R = 26
    const CIRC = 2 * Math.PI * R
    // Kind-agnostic: a private VIDEO used to fall through to the ordinary
    // player — permanent, replayable, and listed in the media gallery.
    const img = m.kind === 'video'
      ? el('video', { src: m.data, autoplay: '', playsinline: '', 'webkit-playsinline': '', loop: '' })
      : el('img', { src: m.data, alt: '' })
    const count = el('span', { class: 'bcount', text: String(secs) })
    const ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    ringFg.setAttribute('cx', '30'); ringFg.setAttribute('cy', '30'); ringFg.setAttribute('r', String(R))
    ringFg.setAttribute('class', 'bring-fg')
    ringFg.style.strokeDasharray = String(CIRC)
    ringFg.style.strokeDashoffset = '0'
    ringFg.style.transition = `stroke-dashoffset ${secs}s linear`
    const ringBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    ringBg.setAttribute('cx', '30'); ringBg.setAttribute('cy', '30'); ringBg.setAttribute('r', String(R))
    ringBg.setAttribute('class', 'bring-bg')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 60 60')
    svg.setAttribute('class', 'bring')
    svg.appendChild(ringBg); svg.appendChild(ringFg)

    // Orbiting sparkles around the countdown ring — the container spins, each
    // ✦ sits on the circle and twinkles on its own stagger (pure CSS).
    const orbit = el('span', { class: 'borbit', 'aria-hidden': 'true' },
      Array.from({ length: 6 }, () => el('i', { text: '✦' })))
    const overlay = el('div', { class: 'imgview burstview' }, [
      img,
      el('span', { class: 'bringwrap' }, [orbit, svg, count])
    ])
    root.appendChild(overlay)

    /* Wall clock, not a tick count. An interval is throttled to once a minute
     * in a backgrounded tab, so counting down by one per fire stretched a
     * 10-second photo across many minutes of it being on screen. Ceil of the
     * remaining time is also exactly what the sender's bubble renders, so the
     * two clocks now read the same number instead of differing by one. */
    const endsAt = Date.now() + secs * 1000
    const remaining = () => Math.max(0, (endsAt - Date.now()) / 1000)
    let done = false
    requestAnimationFrame(() => { ringFg.style.strokeDashoffset = String(CIRC) })
    const tick = setInterval(() => {
      count.textContent = String(Math.ceil(remaining()))
      if (remaining() <= 0) finish()
    }, 250)
    rowTimers.add(tick)

    function burstParticles () {
      const rect = img.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      for (let i = 0; i < 26; i++) {
        const p = el('span', { class: 'burst-p' })
        const angle = (Math.PI * 2 * i) / 26 + Math.random() * 0.4
        const dist = 90 + Math.random() * 140
        p.style.left = `${cx}px`
        p.style.top = `${cy}px`
        p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
        p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`)
        p.style.background = ['#ffb703', '#fb5607', '#ff006e', '#e5342b', '#f4a261'][i % 5]
        document.body.appendChild(p)
        setTimeout(() => p.remove(), 850)
      }
    }

    function finish () {
      if (done) return
      done = true
      clearInterval(tick)
      burstParticles()
      img.classList.add('bursting')
      setTimeout(() => {
        overlay.remove()
        rooms.viewOnceOpened(roomId, m.id)
        removeRow(m.id)
        ctx.toast('Burst — the photo is gone')
      }, 420)
    }

    // Closing early consumes it too, exactly like Telegram — but not the
    // second half of a double-tap on the bubble, which used to land on this
    // overlay the instant it mounted and burn the photo in ~50ms. Same 400ms
    // ghost-click armour every other sheet in this file uses.
    const openedAt = Date.now()
    overlay.addEventListener('click', () => {
      if (Date.now() - openedAt < 400) return
      finish()
    })
  }

  /**
   * The sender's side while the other person is actually looking.
   *
   * Telegram's own view-once bubble does this: the moment it is opened the
   * sender stops seeing a static "sent" state and starts watching the same
   * clock the viewer is under. Waiting with no feedback is the boring part,
   * and it is also the part that matters most — this is the only window in
   * which the photo still exists on their device.
   *
   * The ring is driven by a CSS transition rather than a per-frame timer, so
   * it stays smooth while the thread scrolls and costs nothing when the tab is
   * backgrounded. Only the digit is repainted, once a second.
   */
  function buildWatchingNow (m, live) {
    const R = 13
    const CIRC = 2 * Math.PI * R
    const elapsed = (Date.now() - live.at) / 1000
    const left = Math.max(0, live.secs - elapsed)

    const ns = 'http://www.w3.org/2000/svg'
    const ring = document.createElementNS(ns, 'circle')
    ring.setAttribute('cx', '15'); ring.setAttribute('cy', '15'); ring.setAttribute('r', String(R))
    ring.setAttribute('class', 'vw-fg')
    ring.style.strokeDasharray = String(CIRC)
    // Start from wherever they actually are: a late-arriving signal, or a
    // re-render mid-view, must not restart the clock at full.
    ring.style.strokeDashoffset = String(CIRC * (1 - left / live.secs))
    const bg = document.createElementNS(ns, 'circle')
    bg.setAttribute('cx', '15'); bg.setAttribute('cy', '15'); bg.setAttribute('r', String(R))
    bg.setAttribute('class', 'vw-bg')
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 30 30')
    svg.setAttribute('class', 'vw-ring')
    svg.appendChild(bg); svg.appendChild(ring)

    const digit = el('b', { class: 'vw-num', text: String(Math.ceil(left)) })
    const wrap = el('div', { class: 'voMine watching' }, [
      el('span', { class: 'vw-orbit', 'aria-hidden': 'true' },
        Array.from({ length: 5 }, () => el('i', { text: '✦' }))),
      el('span', { class: 'vw-clock' }, [svg, digit]),
      el('span', { class: 'vw-label', text: 'Viewing now' }),
      el('span', { class: 'vw-flame', text: '🔥' })
    ])

    // Hand the ring its final value on the next frame so the browser animates
    // between the two; setting both in one frame would just snap.
    requestAnimationFrame(() => {
      ring.style.transition = `stroke-dashoffset ${left}s linear`
      ring.style.strokeDashoffset = String(CIRC)
    })

    const tick = setInterval(() => {
      const now = Math.max(0, live.secs - (Date.now() - live.at) / 1000)
      digit.textContent = String(Math.ceil(now))
      if (now > 0) return
      clearInterval(tick)
      // The burn signal usually beats this; this is the fallback for a viewer
      // who went offline mid-view, so the sender is never left mid-countdown.
      conn.openingByPeer?.delete(m.id)
      wrap.classList.add('spent')
      setTimeout(() => refreshRow(m.id), 600)
    }, 250)
    rowTimers.add(tick)
    return wrap
  }

  /**
   * The bytes existed this session and this device cannot store them.
   *
   * Not a "tap to load" button: there is nothing to load. Saying "tap to load"
   * for something that will never load is the failure this replaces — it read
   * as a broken download rather than as a device limitation, so people tapped
   * it repeatedly and reported the app as broken.
   */
  function buildMemoryOnly (m) {
    const label = m.kind === 'voice' ? 'Voice note'
      : m.kind === 'file' ? (m.fileName || 'File')
      : m.kind === 'video' ? 'Video' : 'Photo'
    return el('div', { class: 'detached memoryonly' }, [
      el('span', { class: 'dlico', html: IC.doc }),
      el('span', { text: `${label} — not saved on this device` })
    ])
  }

  /** History gave us the envelope but not the bytes — fetch on tap. */
  function buildDetached (m) {
    const label = m.kind === 'voice' ? 'Voice note'
      : m.kind === 'file' ? (m.fileName || 'File')
      : m.kind === 'video' ? 'Video' : 'Photo'
    const b = el('button', { class: 'detached', type: 'button' }, [
      el('span', { class: 'dlico', html: IC.doc }),
      el('span', { text: `${label} — tap to load` })
    ])
    b.addEventListener('click', () => {
      b.classList.add('loading')
      b.querySelector('span:last-child').textContent = 'Loading…'
      rooms.fetchAttachment(roomId, m.id)
        .then(() => refreshRow(m.id))
        .catch((e) => {
          b.classList.remove('loading')
          b.querySelector('span:last-child').textContent = `${label} — tap to load`
          ctx.toast(e.message)
        })
    })
    return b
  }

  function buildBubble (m, mine) {
    /* View-once is checked BEFORE `detached`, and without asking what kind it
     * is. Both orderings were bugs: a shed or replayed private photo rendered
     * as a generic "Photo — tap to load" that fetched and displayed it with no
     * mask, no countdown and no burn; and a private VIDEO skipped this branch
     * entirely and became an ordinary permanent player. */
    if (m.viewOnce && !mine) {
      /* The mask is a 16-pixel thumbnail the SENDER made and sent alongside
       * the photo (media.js maskDataURL). It used to be `src: m.data` — the
       * full-resolution original, blurred by a CSS filter, which leaves every
       * pixel intact in the DOM for anyone who opens devtools. Nothing here
       * may ever reference m.data: this bubble is what is on screen before
       * the decision to spend the one view has been made. */
      const b = el('button', { class: 'vonce', type: 'button' }, [
        el('span', { class: 'vmask' }, [
          // Telegram reference: a smear of the photo's colours shows through,
          // under a dense field of sparkling grain.
          m.mask ? el('img', { class: 'vblur', src: m.mask, alt: '' }) : null,
          el('span', { class: 'vgrain' }),
          el('span', { class: 'vshimmer' }),
          ...sparkEls(),
          el('b', { class: 'bchip', text: burstChip(m) }),
          el('span', { class: 'vfire', text: '🔥' })
        ]),
        el('span', { text: privateLabel(m) })
      ])
      b.addEventListener('click', () => tapViewOnce(m, b))
      return b
    }
    if (m.viewOnce && mine) {
      // Also above the `detached` check: my own private photo's bytes are not
      // persisted either, so after a reload it must still read "Private photo"
      // rather than offering to load one back.
      // They are looking at it right now — show the same clock they are under.
      const live = conn.openingByPeer?.get(m.id)
      if (live) return buildWatchingNow(m, live)
      return el('div', { class: 'voMine' }, [
        ...sparkEls(),
        el('span', { text: 'Private photo' }),
        el('span', { class: 'bchip2', text: burstChip(m) }),
        el('span', {
          class: 'cap', text: m.burst ? 'Burst 🔥' : 'Opened',
          style: conn.seenByPeer.has(m.id) ? '' : 'display:none'
        })
      ])
    }
    /* MEMORY-ONLY: the bytes were here this session and were never written to
     * disk, because this device has no IndexedDB and localStorage is far too
     * small to hold media. Distinct from `detached`, which means "a peer has
     * them, tap to fetch". Tapping this would fetch nothing, so it is not a
     * button — it is a statement of what happened. */
    if (m.data === null && m.memoryOnly && m.kind !== 'text') return buildMemoryOnly(m)
    if (m.data === null && m.detached && m.kind !== 'text') return buildDetached(m)
    if (m.kind === 'image') {
      const img = el('img', { src: m.data, alt: 'Photo' })
      img.addEventListener('load', () => { if (nearBottom()) scrollBottom() })
      const b = el('button', { class: 'imgmsg', type: 'button', 'aria-label': 'Open photo' }, [
        img,
        m.text ? el('span', { class: 'imgcap', text: m.text }) : null
      ])
      b.addEventListener('click', () => openImage(m.data))
      return b
    }
    if (m.kind === 'video') {
      // A wrapper div, not the <video> itself, so the progress ring has a home.
      return el('div', { class: 'vid' }, [
        el('video', { src: m.data, controls: '', playsinline: '', 'webkit-playsinline': '', preload: 'metadata' })
      ])
    }
    if (m.kind === 'voice') return buildVoice(m)
    if (m.kind === 'file') {
      const kb = Math.max(1, Math.round((m.fileSize || 0) / 1024))
      return el('a', { class: 'file', href: m.data, download: m.fileName || 'file', html: IC.doc }, [
        el('span', { class: 'fmeta' }, [
          el('b', { text: m.fileName || 'File' }),
          el('span', { text: `${kb} KB` })
        ])
      ])
    }
    if (m.kind === 'location') {
      // Live share that ended — both sides show the same muted line.
      if (m.live === false) {
        return el('div', { class: 'loc locEnded' }, [
          el('b', { text: 'Live location ended' })
        ])
      }
      if (m.live) {
        const untilTxt = m.until ? `Until ${fmtTime(m.until)}` : '∞'
        if (mine) {
          return el('div', { class: 'loc locLive' }, [
            el('b', {}, [el('span', { class: 'livedot' }), 'Live location · sharing']),
            el('span', { class: 'locuntil', text: untilTxt }),
            el('button', {
              class: 'locstop', type: 'button', text: 'Stop sharing',
              onclick: () => stopLiveShare(m.id)
            })
          ])
        }
        return el('div', { class: 'loc locLive' }, [
          el('b', {}, [el('span', { class: 'livedot' }), 'Live location']),
          el('a', {
            href: mapLink(m.lat, m.lon), target: '_blank', rel: 'noopener', text: 'Open map'
          }),
          el('span', { class: 'locuntil', text: untilTxt })
        ])
      }
      return el('div', { class: 'loc' }, [
        el('b', { text: 'Current location' }),
        el('a', {
          href: mapLink(m.lat, m.lon), target: '_blank', rel: 'noopener', text: 'Open map'
        })
      ])
    }
    /* text */
    const jumbo = jumboEmoji(m.text)
    if (jumbo) return buildJumbo(m, mine, jumbo)
    if (mine) {
      return el('div', { class: 'bubOut' }, [
        m.replyTo ? buildQuote(m.replyTo) : null,
        m.text
      ])
    }
    return el('div', { class: 'bubIn' }, [
      m.replyTo ? buildQuote(m.replyTo) : null,
      el('div', { class: 'src', text: m.text }),
      el('div', { class: 'meta' }, [
        m.starred ? el('span', { class: 'starmark', text: '★' }) : null,
        m.editedAt ? el('span', { class: 'edited', text: 'edited' }) : null,
        fmtTime(m.ts)
      ])
    ])
  }

  /**
   * A bubble-less run of large emoji, each with its own motion, replayed on
   * tap — Telegram's behaviour, which is the part worth copying.
   */
  function buildJumbo (m, mine, glyphs) {
    const grid = el('div', { class: 'jgrid' + (glyphs.length > 1 ? ' multi' : '') },
      glyphs.map((glyph, i) => {
        const node = el('span', { class: `jem m-${motionFor(glyph)}`, text: glyph })
        node.style.setProperty('--i', String(i))   // each lands after the last
        return node
      }))
    const box = el('div', {
      class: `${mine ? 'bubOut' : 'bubIn'} jumbo`
    }, [
      m.replyTo ? buildQuote(m.replyTo) : null,
      grid,
      mine ? null : el('div', { class: 'meta' }, [
        m.starred ? el('span', { class: 'starmark', text: '★' }) : null,
        m.editedAt ? el('span', { class: 'edited', text: 'edited' }) : null,
        fmtTime(m.ts)
      ])
    ])

    // Tap one to play it again, with a scatter of itself — Telegram's reward
    // for tapping. Restarting means removing the class and forcing a reflow;
    // without that the browser coalesces both changes and nothing replays.
    for (const node of grid.querySelectorAll('.jem')) {
      node.addEventListener('click', () => {
        if (REDUCED_MOTION()) return
        const motion = node.className.match(/m-\w+/)?.[0]
        if (!motion) return
        node.classList.remove(motion)
        void node.offsetWidth
        node.classList.add(motion)
        scatter(grid, node.textContent)
      })
    }
    return box
  }

  /** A handful of shrinking copies thrown outward from the tapped emoji. */
  function scatter (host, glyph) {
    const box = el('div', { class: 'jburst', 'aria-hidden': 'true' })
    for (let i = 0; i < 10; i++) {
      const bit = el('span', { text: glyph })
      bit.style.setProperty('--dx', `${(Math.random() * 170 - 85).toFixed(1)}px`)
      bit.style.setProperty('--dy', `${(-50 - Math.random() * 120).toFixed(1)}px`)
      bit.style.setProperty('--rot', `${(Math.random() * 140 - 70).toFixed(1)}deg`)
      bit.style.animationDelay = `${i * 22}ms`
      box.appendChild(bit)
    }
    host.appendChild(box)
    setTimeout(() => box.remove(), 1500)
  }

  function buildReadRow (m) {
    // An attachment that never reached them must not claim it was sent. The
    // in-flight ring already says so while the app is open, but that is gone
    // after a reload — and a photo that silently went nowhere sitting there
    // reading "Sent" is the whole complaint.
    if (m.failed) {
      const row = el('div', { class: 'readRow failed', html: IC.check1 }, ['Not delivered'])
      /* A failed send used to be the end of the road — the only remedy on
       * offer was to record the whole note again. The bytes are still here.
       *
       * TEXT WAS EXCLUDED, and that was the worse half: a typed message that
       * failed showed "Not delivered" with no way to send it again, and
       * nothing behind the scenes retried it either (socket.io drops a packet
       * from its send buffer once the ack times out). The text is sitting in
       * the store, intact — only the button was missing. */
      if ((!m.kind || m.kind === 'text') || m.data) {
        row.appendChild(el('button', {
          class: 'retryTx', type: 'button', text: 'Retry',
          onclick (e) { e.stopPropagation(); retrySend(m) }
        }))
      }
      return row
    }
    const read = conn.readUpTo >= m.ts
    return el('div', {
      class: 'readRow' + (read ? ' read' : ''),
      html: read ? IC.check2 : IC.check1
    }, [read ? 'Read' : 'Sent'])
  }

  function renderReacts (node, reactions = []) {
    clear(node)
    const counts = new Map()
    for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1)
    node.style.display = counts.size ? 'flex' : 'none'
    for (const [emoji, count] of counts) {
      node.appendChild(el('span', { text: count > 1 ? `${emoji} ${count}` : emoji }))
    }
  }

  function attachPress (bubble, m) {
    let pressTimer = null
    let fired = false
    const cancel = () => { drop(pressTimer); pressTimer = null }
    bubble.addEventListener('touchstart', () => {
      fired = false
      pressTimer = later(() => { fired = true; openMsgSheet(m) }, LONG_PRESS_MS)
    }, { passive: true })
    // Non-passive on purpose: when the long-press fired mid-touch, the browser
    // would synthesize a click hit-tested against the sheet backdrop that just
    // mounted under the finger, instantly closing it (or worse, pressing a
    // sheet item). preventDefault on touchend suppresses that ghost click.
    bubble.addEventListener('touchend', (e) => {
      cancel()
      if (fired) { fired = false; e.preventDefault() }
    }, { passive: false })
    bubble.addEventListener('touchmove', cancel, { passive: true })
    bubble.addEventListener('touchcancel', cancel)
    bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); openMsgSheet(m) })
  }

  /** WhatsApp-style swipe-right-to-reply, without stealing vertical scroll. */
  function attachSwipeReply (wrap, m) {
    let startX = 0
    let startY = 0
    let dragging = false
    wrap.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      dragging = true
    }, { passive: true })
    wrap.addEventListener('touchmove', (e) => {
      if (!dragging) return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      if (Math.abs(dy) > Math.abs(dx) * 1.4) { dragging = false; wrap.style.transform = ''; return }
      if (dx > 0) wrap.style.transform = `translateX(${Math.min(dx, 72)}px)`
    }, { passive: true })
    const finish = (e) => {
      if (!dragging) return
      dragging = false
      const dx = (e.changedTouches?.[0]?.clientX ?? startX) - startX
      wrap.style.transition = 'transform .18s ease'
      wrap.style.transform = ''
      setTimeout(() => { wrap.style.transition = '' }, 200)
      if (dx > 56) setReply(m)
    }
    wrap.addEventListener('touchend', finish, { passive: true })
    wrap.addEventListener('touchcancel', finish, { passive: true })
  }

  /** Double-tap → quick heart, with a little pop. Desktop double-click too. */
  function attachDoubleTap (bubble, m) {
    let lastTap = 0
    const react = () => {
      rooms.react(roomId, m.id, '❤️')
      updateReactions(m.id)
      const pop = el('span', { class: 'heartpop', text: '❤️' })
      bubble.appendChild(pop)
      setTimeout(() => pop.remove(), 700)
    }
    bubble.addEventListener('touchend', () => {
      const now = Date.now()
      if (now - lastTap < 320) { react(); lastTap = 0 } else lastTap = now
    }, { passive: true })
    bubble.addEventListener('dblclick', react)
  }

  function buildRow (m) {
    const mine = m.from === myId
    const wrap = el('div', { class: 'msg' + (mine ? ' mine' : ''), 'data-id': m.id })
    if (!mine && convo.kind === 'group') {
      wrap.appendChild(el('div', { class: 'sender', text: m.name || 'Unknown' }))
    }
    const bubble = buildBubble(m, mine)
    const time = el('span', { class: 'tOut' }, [
      m.starred ? el('span', { class: 'starmark', text: '★' }) : null,
      // Both sides see that a message was changed — an invisible edit would
      // let someone rewrite what they said.
      m.editedAt ? el('span', { class: 'edited', text: 'edited' }) : null,
      fmtTime(m.ts)
    ])
    const row = mine
      ? el('div', { class: 'rowOut' }, [time, bubble])
      : el('div', { class: 'rowIn' }, [bubble, (m.kind && m.kind !== 'text') ? time : null])
    wrap.appendChild(row)
    // Outgoing attachments carry a live progress ring while they are going out.
    if (mine && inFlight.has(m.id)) {
      bubble.style.position = 'relative'
      bubble.appendChild(el('span', { class: 'txprog', text: '…' }))
    }
    const reacts = el('div', { class: 'reacts' })
    renderReacts(reacts, m.reactions)
    wrap.appendChild(reacts)
    if (mine) wrap.appendChild(buildReadRow(m))
    if (m.ttl) attachCountdown(bubble, m)
    attachPress(bubble, m)
    attachSwipeReply(wrap, m)
    attachDoubleTap(bubble, m)
    return wrap
  }

  /** Live mm:ss countdown chip inside a timer-mode bubble. The interval
   * self-clears on expiry or once the row leaves the DOM; expiry removal
   * of the row itself is handled by the existing ttl machinery. */
  function attachCountdown (bubble, m) {
    const chip = el('span', { class: 'ttlcount' })
    bubble.appendChild(chip)
    const deadline = m.ts + m.ttl * 1000
    const paint = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      chip.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
      return left
    }
    paint()
    const iv = setInterval(() => {
      if (!mounted || !chip.isConnected || paint() <= 0) {
        clearInterval(iv)
        countdowns.delete(iv)
      }
    }, 1000)
    countdowns.add(iv)
  }

  /** 'system' control messages render as a centred sys line, not a bubble. */
  function buildRowAny (m) {
    if (m.kind === 'system') {
      const text = m.sys === 'timer'
        ? (m.secs ? `⏱ Timer messages on · ${fmtTtlLong(m.secs)}` : '⏱ Timer messages off')
        : (m.text || '')
      return el('div', { class: 'sys sysline', 'data-id': m.id }, [text])
    }
    return buildRow(m)
  }

  /** Rebuild one row in place (lazy-loaded bytes, burst state changes). */
  function refreshRow (id) {
    const entry = msgEls.get(id)
    const fresh = conn.store.list().find((x) => x.id === id)
    if (!entry || !fresh) return
    if (entry.album) { renderList(); return }
    const wrap = buildRowAny(fresh)
    entry.wrap.replaceWith(wrap)
    msgEls.set(id, { wrap, message: fresh })
    if (fresh.from !== myId && (!fresh.kind || fresh.kind === 'text')) applyTranslation(fresh)
    if (!fresh.kind || fresh.kind === 'text') applyXlit(fresh)
  }

  function appendMessage (m, skipAlbumCheck) {
    /* The first-run line belongs to an EMPTY thread and nothing else. It is
     * rendered at the one moment the room is guaranteed to still look v1 — the
     * chat opens before key agreement resolves — so leaving it in place once
     * messages start arriving pinned a stale, and wrong, security claim above a
     * conversation that had since upgraded. */
    thread.querySelector('.sys.firstrun')?.remove()
    // A newly arrived photo may complete a run of four — the whole thread has
    // to regroup, which incremental appending cannot do.
    if (!skipAlbumCheck && albumable(m) && completesAlbum(m)) {
      renderList()
      return
    }
    /* This message belongs before one already on screen. That happens whenever
     * attachments complete out of order — a one-slice voice note overtakes a
     * six-slice one — and appending it anyway is what scrambled the transcript
     * while the user was reading it. The store is already sorted by (ts, id),
     * so hand it to the rebuild: it is the only path that also gets day
     * separators and photo albums right. Cannot recurse — the rebuild appends
     * in ascending ts, so this branch is never taken from inside it. */
    if (lastTs != null && m.ts < lastTs) {
      renderList()
      return
    }
    lastTs = m.ts
    const dayKey = new Date(m.ts).toDateString()
    if (dayKey !== lastDayKey) {
      thread.appendChild(el('div', { class: 'day', text: dayLabel(m.ts) }))
      lastDayKey = dayKey
    }
    const wrap = buildRowAny(m)
    thread.appendChild(wrap)
    msgEls.set(m.id, { wrap, message: m })
    if (m.from !== myId && (!m.kind || m.kind === 'text')) applyTranslation(m)
    if (!m.kind || m.kind === 'text') applyXlit(m)
    if (m.ttl && m.from === myId) {
      // rooms removes my own timed message from the store without an event.
      later(() => removeRow(m.id), Math.max(0, m.ts + m.ttl * 1000 - Date.now()))
    }
  }

  function removeRow (id) {
    const entry = msgEls.get(id)
    if (entry?.album) {
      msgEls.delete(id)
      renderList()
      if (replyTarget?.id === id) clearReply()
      return
    }
    entry?.wrap.remove()
    msgEls.delete(id)
    if (replyTarget?.id === id) clearReply()
  }

  /**
   * The room's encryption version AS IT IS NOW, not as it was when this view
   * was built.
   *
   * `convo` is captured once at construction (`const convo = db.convo(roomId)`),
   * and `reach()` deliberately writes the convo record as E2E_V1 FIRST and
   * upgrades it to E2E_V2 only once key agreement resolves — that ordering is
   * what stops a new chat bouncing off "Conversation not found". The chat view
   * opens in between, so the snapshot it captured says v1 for a room that is
   * about to be, and then is, v2.
   *
   * Two things read this field, and the stale value broke both:
   *   - `sysLine` told the user "the server could read it" about a brand-new
   *     end-to-end encrypted chat. A false alarm is not harmless — it is how
   *     people learn to disregard the real one.
   *   - `keyWarning` returns null for anything that is not v2, so on exactly
   *     these rooms the "messages are arriving and can't be read" banner could
   *     never render at all.
   */
  const e2eVersionNow = () => db.convo(roomId)?.e2eVersion || convo?.e2eVersion

  function sysLine () {
    const v2 = e2eVersionNow() === 'e2e_v2'
    return el('div', { class: 'sys firstrun', html: IC.spark }, [
      v2
        /* "Messages", not a bare "Encrypted": this line sits in a chat that also
         * offers a call button, and calls are NOT end-to-end encrypted (ADR-004).
         * An unqualified claim here would be read as covering them. */
        ? 'Messages are encrypted with keys made on your devices. Translation runs on-device when possible.'
        : 'Older chat — its key came from both account IDs, so the server could read it.',
      /* Only a v2 room has a device identity to compare, so only a v2 room gets
       * the link — see views/verify.js. It sits HERE, on the line that already
       * makes the encryption claim, because that is the claim it lets someone
       * check. A verification screen filed under a settings menu is one nobody
       * finds at the moment they doubt the claim. */
      v2 ? el('button', {
        class: 'linkbtn', type: 'button',
        onclick: () => ctx.nav(`#/verify/${roomId}`)
      }, ['Verify']) : null
    ])
  }

  /**
   * The line that says this device cannot hold a key, or null when it can.
   *
   * This is not decoration. On a device in either state, `sysLine` above says
   * "Encrypted with keys made on your devices" — which is precisely backwards:
   * the key is there but the PEER cannot match it, so every message silently
   * fails to open at the far end while this screen reassures the sender. The
   * reassurance is worse than saying nothing.
   *
   * Only 'ephemeral' and 'unavailable' warn. 'unknown' does not: the identity
   * simply has not been asked for yet, and warning on it would fire on every
   * cold open of a perfectly healthy device.
   */
  function keyWarning () {
    if (e2eVersionNow() !== 'e2e_v2') return null   // a v1 room never used this key

    /* THIS ROOM specifically is unreadable, whatever the device's own key is
     * doing. Ranked above the device-level warning because it is the stronger
     * statement: it is not a risk, it is a measurement — frames arrived, the
     * transport tried to re-agree, and they still would not open. */
    if (roomUndecryptable) {
      /* F2 (owner decision): NEVER tell someone to delete a conversation.
       * 'wrong-key' now heals itself — the transport re-fetches the peer's
       * current key on decrypt failure and adopts it (roomKeyForConvo), so
       * this line is a status report about a repair in progress, rate-limited
       * by the self-heal cooldown, not a verdict. It clears the moment a
       * frame opens. */
      const rekeyed = roomUndecryptableReason === 'wrong-key'
      return el('div', { class: 'sys warn', html: IC.spark }, [
        rekeyed
          ? (convo?.peer?.name || 'The other person') + '’s security key changed — ' +
            'reconnecting automatically. New messages will open in a moment; ' +
            'you can check the connection under Verify.'
          : 'Messages are arriving but this device can’t unlock them yet. ' +
            'Check your connection and reopen the chat — it often clears on its own.'
      ])
    }

    const state = identityStatus()
    if (state !== 'ephemeral' && state !== 'unavailable') return null
    return el('div', { class: 'sys warn', html: IC.spark }, [
      state === 'ephemeral'
        ? 'This device can’t save its encryption key, so the other person can’t read what you send here. Reloading won’t fix it.'
        : 'This device can’t store encryption keys at all — private browsing is the usual cause. Open Spot Me in a normal window.'
    ])
  }

  /* ------------------------------------------------------ photo albums */
  /**
   * A run of photos collapses into one WhatsApp-style album instead of
   * filling the screen: four tiles, "+N" on the last when there are more.
   * One-shot photos (private/burst) never join an album — they have their own
   * lifecycle — and neither do captioned ones, whose caption must stay legible.
   */
  const ALBUM_MIN = 4
  const ALBUM_GAP_MS = 10 * 60_000

  const albumable = (m) =>
    m.kind === 'image' && m.data && !m.viewOnce && !m.burst && !m.text && !m.ttl

  /** Would this incoming photo turn a run into an album (or extend one)? */
  function completesAlbum (m) {
    const list = conn.store.list()
    let run = 0
    for (let i = list.length - 1; i >= 0; i--) {
      const prev = list[i]
      if (prev.id === m.id) continue
      if (!albumable(prev) || prev.from !== m.from) break
      if (m.ts - prev.ts > ALBUM_GAP_MS) break
      run += 1
      if (run >= ALBUM_MIN - 1) return true
    }
    return false
  }

  /** The message list as a mix of single messages and photo runs. */
  function groupForRender (list) {
    const groups = []
    let run = []
    const flush = () => {
      if (run.length >= ALBUM_MIN) groups.push({ album: run })
      else for (const m of run) groups.push({ single: m })
      run = []
    }
    for (const m of list) {
      const joins = albumable(m) && run.length > 0 &&
        run[run.length - 1].from === m.from &&
        new Date(m.ts).toDateString() === new Date(run[run.length - 1].ts).toDateString() &&
        m.ts - run[run.length - 1].ts <= ALBUM_GAP_MS
      if (joins) { run.push(m); continue }
      flush()
      if (albumable(m)) run = [m]
      else groups.push({ single: m })
    }
    flush()
    return groups
  }

  function buildAlbum (messages) {
    const mine = messages[0].from === myId
    const shown = messages.slice(0, 4)
    const extra = messages.length - shown.length

    const grid = el('div', { class: 'album' + (messages.length === 3 ? ' three' : '') },
      shown.map((m, i) => {
        const tile = el('button', {
          class: 'altile', type: 'button', 'aria-label': `Open photo ${i + 1} of ${messages.length}`,
          onclick: () => openImage(m.data)
        }, [el('img', { src: m.data, alt: '' })])
        if (extra > 0 && i === shown.length - 1) {
          tile.appendChild(el('span', { class: 'almore', text: `+${extra}` }))
        }
        return tile
      }))

    const wrap = el('div', { class: 'msg' + (mine ? ' mine' : '') }, [
      el('div', { class: mine ? 'rowOut' : 'rowIn' }, [
        el('span', { class: mine ? 'tOut' : 'tIn', text: fmtTime(messages[messages.length - 1].ts) }),
        grid
      ]),
      el('div', { class: 'alcount', text: `${messages.length} photos` })
    ])

    // Long-press (or right-click) the pile for the whole-album actions.
    let pressTimer = null
    const openSheet = () => openAlbumSheet(messages)
    grid.addEventListener('contextmenu', (e) => { e.preventDefault(); openSheet() })
    grid.addEventListener('pointerdown', () => {
      drop(pressTimer)
      pressTimer = later(openSheet, LONG_PRESS_MS)
    })
    for (const stop of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
      grid.addEventListener(stop, () => { drop(pressTimer); pressTimer = null })
    }
    return wrap
  }

  /** Album actions: the "save all" the pile exists to make possible. */
  function openAlbumSheet (messages) {
    const files = messages
      .map((m) => fileFromDataURL(m.data, baseNameOf(m)))
      .filter(Boolean)
    const items = [{
      label: `Save all ${files.length} photos`,
      async fn () {
        let saved = 0
        for (const file of files) {
          if (downloadFile(file)) saved += 1
          await new Promise((resolve) => later(resolve, 250))   // browsers throttle bursts
        }
        ctx.toast(saved ? `Saved ${saved} photos` : 'Your browser blocked the downloads')
      }
    }]
    if (navigator.canShare?.({ files })) {
      items.push({
        label: `Share all ${files.length} photos`,
        async fn () {
          const result = await shareOut({ title: 'Shared from Spot Me', file: null, files })
          if (result === 'unsupported') ctx.toast('Sharing is not available on this device')
        }
      })
    }
    actionSheet(items, `${messages.length} photos`)
  }

  function renderList () {
    clear(thread)
    msgEls.clear()
    lastDayKey = null
    lastTs = null
    const list = conn.store.list()
    /* The informational line is a first-run nicety, so an empty thread is the
     * right and only place for it. A KEY WARNING is the opposite: it explains
     * why the messages below are going nowhere, so it has to outlive the thread
     * filling up — which on a broken device it does immediately, with the
     * user's own sends, each one rendered locally and readable by nobody. */
    const warning = keyWarning()
    if (warning) thread.appendChild(warning)
    if (!list.length) { if (!warning) thread.appendChild(sysLine()); return }
    for (const group of groupForRender(list)) {
      if (group.single) { appendMessage(group.single); continue }
      const first = group.album[0]
      const dayKey = new Date(first.ts).toDateString()
      if (dayKey !== lastDayKey) {
        thread.appendChild(el('div', { class: 'day', text: dayLabel(first.ts) }))
        lastDayKey = dayKey
      }
      const wrap = buildAlbum(group.album)
      thread.appendChild(wrap)
      // Every member points at the album, so refresh/remove still find a home.
      for (const m of group.album) msgEls.set(m.id, { wrap, message: m, album: true })
    }
  }

  /** Rewrite one of your own messages; both sides see it marked as edited. */
  function openEditSheet (m) {
    const input = el('textarea', { class: 'fsIn area edsheet-in', rows: '3', maxlength: '2000' })
    input.value = m.text || ''
    const back = el('div', { class: 'sheet-back' })
    const close = () => back.remove()
    const save = () => {
      const next = input.value.trim()
      if (!next || next === m.text) { close(); return }
      const applied = rooms.editMessage(roomId, m.id, next)
      close()
      if (applied) { refreshRow(m.id); ctx.toast('Message edited') }
      else ctx.toast('Could not edit that message')
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
      if (e.key === 'Escape') close()
    })
    back.appendChild(el('div', { class: 'sheet fsheet' }, [
      el('div', { class: 'fsTitle', text: 'Edit message' }),
      el('p', { class: 'fsHint', text: 'They will see the new text, marked as edited.' }),
      el('div', { class: 'fsField' }, [input]),
      el('div', { class: 'fsActs' }, [
        el('button', { class: 'pill ghost', type: 'button', text: 'Cancel', onclick: close }),
        el('button', { class: 'pill ok', type: 'button', text: 'Save', onclick: save })
      ])
    ]))
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    root.appendChild(back)
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }

  /* ------------------------------------------- share / save / copy out */

  const KIND_NOUN = {
    image: 'photo', voice: 'voice note', video: 'video', file: 'file', location: 'location'
  }

  const downloadLabel = (m) => `Download ${KIND_NOUN[m.kind] || 'file'}`

  /** A filename that means something six months later in a Downloads folder. */
  function baseNameOf (m) {
    if (m.kind === 'file' && m.fileName) return m.fileName.replace(/\.[^.]+$/, '')
    const when = new Date(m.ts || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
    // The message id keeps a "save all" of photos taken in the same second
    // from collapsing onto one filename and overwriting itself.
    const tag = String(m.id || '').slice(-4)
    return `spotme-${KIND_NOUN[m.kind]?.replace(/\s+/g, '-') || 'message'}-${when}${tag ? '-' + tag : ''}`
  }

  /** What "Copy" should put on the clipboard for this message. */
  function copyTextOf (m) {
    if (m.kind === 'location') return mapLink(m.lat, m.lon)
    return m.text || ''
  }

  function copyOut (text) {
    if (!text) { ctx.toast('Nothing to copy'); return }
    navigator.clipboard?.writeText(text)
      .then(() => ctx.toast('Copied'))
      .catch(() => ctx.toast('Could not copy'))
  }

  function saveMessage (m) {
    const file = m.data ? fileFromDataURL(m.data, baseNameOf(m)) : null
    if (!file) { ctx.toast('Nothing to download yet — tap the message to load it first'); return }
    ctx.toast(downloadFile(file) ? `Saved ${file.name}` : 'Your browser blocked the download')
  }

  /**
   * Send a message out to any other app. Phones get the real OS share sheet;
   * where the browser has no share support (most desktops) we do the closest
   * honest thing — save media, copy text — and say which happened.
   */
  async function shareMessage (m) {
    const title = 'Shared from Spot Me'
    const file = m.data ? fileFromDataURL(m.data, baseNameOf(m)) : null
    const text = copyTextOf(m) || (file ? '' : String(m.text || ''))

    const result = await shareOut(file ? { title, file } : { title, text })
    if (result === 'shared' || result === 'cancelled') return

    if (file) {
      ctx.toast(downloadFile(file)
        ? `Sharing is not available here — saved ${file.name} instead`
        : 'Sharing is not available on this device')
      return
    }
    if (text) {
      navigator.clipboard?.writeText(text)
        .then(() => ctx.toast('Sharing is not available here — copied instead'))
        .catch(() => ctx.toast('Sharing is not available on this device'))
      return
    }
    ctx.toast('Nothing to share')
  }

  /* ------------------------------------------------- long-press sheet */
  function openMsgSheet (m) {
    if (root.querySelector('.ms-back')) return
    const isText = !m.kind || m.kind === 'text'
    // View-once/burst photos are one-shot by contract — never forwardable.
    // Detached envelopes (bytes not fetched yet) have nothing to forward.
    const canForward = !m.viewOnce && !m.burst &&
      (isText || m.kind === 'location' || Boolean(m.data))
    const back = el('div', { class: 'ms-back' })
    const close = () => back.remove()
    // Ghost-click armour: the sheet mounts mid-press, so a click synthesized
    // from that same press must neither dismiss it nor activate an item.
    const mountedAt = Date.now()
    back.addEventListener('click', (e) => {
      if (Date.now() - mountedAt < 400) { e.stopPropagation(); e.preventDefault() }
    }, true)
    back.addEventListener('click', (e) => { if (e.target === back) close() })

    const sendReact = (emoji) => {
      rooms.react(roomId, m.id, emoji)
      updateReactions(m.id)
      close()
    }

    const grid = el('div', { class: 'ms-grid' }, EMOJI_GRID.map((emoji) =>
      el('button', {
        type: 'button', text: emoji, 'aria-label': `React ${emoji}`,
        onclick: () => sendReact(emoji)
      })
    ))

    const emojis = el('div', { class: 'ms-emojis' }, [
      ...REACT_EMOJI.map((emoji) =>
        el('button', {
          type: 'button', text: emoji, 'aria-label': `React ${emoji}`,
          onclick: () => sendReact(emoji)
        })
      ),
      el('button', {
        class: 'plus', type: 'button', text: '+', 'aria-label': 'More reactions',
        onclick: () => grid.classList.toggle('open')
      })
    ])

    const item = (icon, label, fn, cls = '') =>
      el('button', { class: 'ms-item' + cls, type: 'button', onclick: fn }, [
        el('span', { class: 'mi', html: icon }), label
      ])

    const items = [item(IC.reply, 'Reply', () => { close(); setReply(m) })]
    if (canForward) items.push(item(IC.forward, 'Forward', () => { close(); openForwardSheet(m) }))
    // Forward stays inside Spot Me; Share hands it to the phone's own sheet,
    // which is how anything reaches WhatsApp, Mail, Files or Drive.
    if (canForward) items.push(item(IC.share, 'Share…', () => { close(); shareMessage(m) }))
    if (m.data) {
      items.push(item(IC.download, downloadLabel(m), () => { close(); saveMessage(m) }))
    }
    // Only the author can rewrite their own words, and only plain text.
    if (isText && m.from === myId) {
      items.push(item(IC.pencil, 'Edit', () => { close(); openEditSheet(m) }))
    }
    if (isText || m.kind === 'location' || m.text) {
      items.push(item(IC.copy, isText ? 'Copy' : 'Copy text', () => {
        close()
        copyOut(copyTextOf(m))
      }))
    }
    items.push(item(IC.info, 'Info', () => { close(); openInfoSheet(m) }))
    items.push(item(IC.star, m.starred ? 'Unstar' : 'Star', () => {
      close()
      conn.store.patch(m.id, { starred: !m.starred })
      refreshRow(m.id)
    }))
    items.push(item(IC.trash, 'Delete', () => { close(); openDeleteSheet(m) }, ' danger'))
    if (isText) items.push(item(IC.more, 'More…', () => { close(); openMoreSheet(m) }))
    items.push(el('button', { class: 'ms-item cancel', type: 'button', text: 'Cancel', onclick: close }))

    back.appendChild(el('div', { class: 'ms-sheet' }, [emojis, grid, ...items]))
    root.appendChild(back)
  }

  /** Forward: clone the message content into another conversation, stripped
   * of reply/translation context and reactions. */
  function forwardTo (c, m) {
    const name = c.title || c.peer?.name || 'chat'
    let sent = null
    if (!m.kind || m.kind === 'text') {
      sent = rooms.sendMessage(c.roomId, m.lang ? { text: m.text, lang: m.lang } : { text: m.text })
    } else if (m.kind === 'location') {
      sent = rooms.sendMessage(c.roomId, { kind: 'location', lat: m.lat, lon: m.lon })
    } else if (m.data) {
      const partial = { kind: m.kind, data: m.data }
      if (m.fileName) partial.fileName = m.fileName
      if (m.fileSize) partial.fileSize = m.fileSize
      if (m.dur) partial.dur = m.dur
      sent = rooms.sendAttachment(c.roomId, partial)
    }
    if (!sent) { ctx.toast('Could not forward that message'); return }
    if (c.roomId === roomId) { appendMessage(sent); scrollBottom() }
    ctx.toast(`Forwarded to ${name}`)
  }

  function openForwardSheet (m) {
    const targets = db.convos().filter((c) => !c.archived)
    if (!targets.length) { ctx.toast('No conversations to forward to'); return }
    const back = el('div', { class: 'ms-back' })
    const close = () => back.remove()
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    const rows = targets.map((c) => el('button', {
      class: 'fw-row', type: 'button', onclick () { close(); forwardTo(c, m) }
    }, [
      avatar(c.peer || { name: c.title }, 34),
      el('span', { text: c.title || c.peer?.name || 'Chat' })
    ]))
    back.appendChild(el('div', { class: 'ms-sheet' }, [
      el('div', { class: 'fw-title', text: 'Forward to…' }),
      el('div', { class: 'fw-list' }, rows),
      el('button', { class: 'ms-item cancel', type: 'button', text: 'Cancel', onclick: close })
    ]))
    root.appendChild(back)
  }

  /** Honest info: Sent time, and for my messages the read state. No fake
   * "Delivered" tier — the transport cannot prove delivery. */
  function openInfoSheet (m) {
    const back = el('div', { class: 'ms-back' })
    const close = () => back.remove()
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    const rows = [
      el('div', { class: 'info-row' }, [
        el('span', { text: 'Sent' }), el('b', { text: fmtTime(m.ts) })
      ])
    ]
    if (m.from === myId) {
      rows.push(el('div', { class: 'info-row' }, [
        el('span', { text: 'Read' }),
        el('b', { text: conn.readUpTo >= m.ts ? 'Read' : 'Not read yet' })
      ]))
    }
    back.appendChild(el('div', { class: 'ms-sheet' }, [
      el('div', { class: 'fw-title', text: 'Message info' }),
      ...rows,
      el('button', { class: 'ms-item cancel', type: 'button', text: 'Close', onclick: close })
    ]))
    root.appendChild(back)
  }

  /** Delete chooser: local removal for anything; network delete only for mine. */
  function openDeleteSheet (m) {
    const items = [{
      label: 'Delete for me',
      danger: true,
      fn () {
        conn.store.remove(m.id)   // local only — nothing is broadcast
        removeRow(m.id)
      }
    }]
    if (m.from === myId) {
      items.push({
        label: 'Delete for everyone',
        danger: true,
        fn () {
          rooms.deleteMessage(roomId, m.id)
          removeRow(m.id)
        }
      })
    }
    actionSheet(items, 'Delete message?')
  }

  function openMoreSheet (m) {
    actionSheet([{
      label: 'Read aloud',
      fn () {
        const cached = trCache.get(m.id)
        const spoken = (cached && cached !== 'pending' && cached.text) || m.text
        if (!speak(spoken, db.profile().lang)) ctx.toast('Read aloud is not available on this device')
      }
    }], 'More')
  }

  /* -------------------------------------------------- contact-info sheet */
  /** "~24 m · Online" — the header status logic, contact-card flavoured. */
  function contactStatusLine () {
    const c = db.convo(roomId) || convo
    let text
    if (c.kind === 'demo') text = 'online · demo'
    else if (conn.peerCount > 0 || lobby.peers().some((x) => x.id === c.peer?.id)) text = 'Online'
    else if (c.peerSeen) text = `Last seen ${fmtDay(c.peerSeen)}`
    else text = 'Offline'
    if (c.mode === 'nearby') {
      const live = lobby.peers().find((x) => x.id === c.peer?.id)
      const d = fmtDistance(distanceM(lobby.myPosition(), live))
      if (d) text = `${d} · ${text}`
    }
    return text
  }

  /** The peer's claimed @handle, if any surface carries one: the convo peer
   * record first, then any profile the room store has seen for this person. */
  function peerUsername () {
    const c = db.convo(roomId) || convo
    if (c.peer?.username) return c.peer.username
    for (const p of conn.store.profiles().values()) {
      if (p?.username && (!c.peer?.name || p.name === c.peer.name)) return p.username
    }
    return null
  }

  /** This chat's revisitable media: plain photos and videos with bytes.
   * Anything view-once is one-shot by contract — the `!m.viewOnce` guard used
   * to sit only on the image arm, so a private VIDEO was listed in the gallery
   * and replayable there forever. */
  function mediaMessages () {
    return conn.store.list().filter((m) =>
      (m.kind === 'image' || m.kind === 'video') && m.data && !m.viewOnce)
  }

  /** Plain-text export of this thread — same line grammar as the inbox export. */
  function exportChat () {
    try {
      const messages = conn.store.list().filter((m) => m.kind !== 'system')
      if (!messages.length) { ctx.toast('Nothing to export yet'); return }
      const line = (m) => {
        const when = new Date(m.ts).toLocaleString()
        const who = m.from === myId ? 'You' : (m.name || convo.peer?.name || 'Unknown')
        let body = m.text || ''
        if (m.viewOnce) body = m.kind === 'video' ? '[private video]' : '[private photo]'
        else if (m.kind === 'image') body = '[photo]'
        else if (m.kind === 'voice') body = `[voice note ${m.dur || 0}s]`
        else if (m.kind === 'video') body = '[video]'
        else if (m.kind === 'file') body = `[file] ${m.fileName || ''}`.trim()
        else if (m.kind === 'location') body = '[location]'
        return `[${when}] ${who}: ${body}`
      }
      const blob = new Blob([messages.map(line).join('\n') + '\n'], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const safe = (convo.title || convo.peer?.name || 'chat').replace(/[^\w\- ]+/g, '').trim() || 'chat'
      const link = el('a', { href: url, download: `${safe}.txt` })
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch { ctx.toast('Could not export this chat') }
  }

  /** Block: same flow as the inbox row menu — record the block, leave the
   * room, remove the convo, land back on the inbox. */
  function doBlock () {
    const c = db.convo(roomId) || convo
    const name = c.title || c.peer?.name || 'them'
    if (!c.peer?.id) { ctx.toast('This chat has nobody to block'); return }
    db.block(c.peer.id, name)
    rooms.leave(roomId)
    db.removeConvo(roomId)
    ctx.toast(`${name} blocked`)
    ctx.nav('#/chat')
  }

  /** WhatsApp-grammar contact card: identity head, three round actions,
   * then the per-chat settings list. Opens from the header avatar. */
  function openContactSheet () {
    if (root.querySelector('.cp-back')) return
    const c = db.convo(roomId) || convo
    const person = c.peer || { name: c.title }
    const name = c.title || c.peer?.name || 'Chat'
    const canBlock = Boolean(c.peer?.id)
    const back = el('div', { class: 'ms-back cp-back' })
    const close = () => back.remove()
    // Ghost-click armour, same 400ms as every other sheet here.
    const mountedAt = Date.now()
    back.addEventListener('click', (e) => {
      if (Date.now() - mountedAt < 400) { e.stopPropagation(); e.preventDefault() }
    }, true)
    back.addEventListener('click', (e) => { if (e.target === back) close() })

    const callAct = (video) => {
      if (c.kind === 'demo') { ctx.toast('Demo chats cannot take calls'); return }
      close()
      beginCall(video)
    }

    // The confirm actionSheet mounts at z-index 90, under this sheet's 95 —
    // close first so the confirmation is actually on top.
    const confirmBlock = () => {
      close()
      actionSheet(
        [{ label: `Block ${name}`, danger: true, fn: doBlock }],
        `${name} will not be able to message you. This chat is removed from this device.`
      )
    }

    const act = (cls, icon, label, fn) => el('button', {
      class: 'cp-act' + cls, type: 'button', 'aria-label': label, onclick: fn
    }, [
      el('span', { class: 'cp-actc', html: icon }),
      el('span', { class: 'cp-actl', text: label })
    ])

    /* -------- media gallery: built lazily on first expand */
    const gallery = el('div', { class: 'cp-gallery', style: 'display:none' })
    let galleryBuilt = false
    function toggleGallery () {
      if (gallery.style.display !== 'none') { gallery.style.display = 'none'; return }
      if (!galleryBuilt) {
        galleryBuilt = true
        const media = mediaMessages()
        if (!media.length) {
          gallery.appendChild(el('div', { class: 'cp-empty', text: 'No media yet' }))
        } else {
          for (const m of media) {
            const isVideo = m.kind === 'video'
            const thumb = el('button', {
              class: 'cp-thumb' + (isVideo ? ' cp-vid' : ''), type: 'button',
              'aria-label': isVideo ? 'Open video' : 'Open photo'
            }, [
              isVideo
                ? el('video', { src: m.data, muted: '', playsinline: '', 'webkit-playsinline': '', preload: 'metadata' })
                : el('img', { src: m.data, alt: '' }),
              isVideo ? el('span', { class: 'cp-vplay', html: IC.play }) : null
            ])
            thumb.addEventListener('click', () => {
              if (isVideo) openVideoView(m.data)
              else openImage(m.data)
            })
            gallery.appendChild(thumb)
          }
        }
      }
      gallery.style.display = 'flex'
    }

    // A row with no action is information, not a control: no chevron, no
    // press state — otherwise "Connected through" looks like it opens something.
    const row = (icon, label, value, fn, cls = '') => el('button', {
      class: 'cp-row' + cls + (fn ? '' : ' cp-static'),
      type: 'button', onclick: fn || undefined, disabled: fn ? undefined : ''
    }, [
      el('span', { class: 'cp-ri', html: icon }),
      el('span', { class: 'cp-rl', text: label }),
      value ? el('span', { class: 'cp-rv', text: value }) : null,
      fn ? el('span', { class: 'cp-chev', html: IC.chev }) : null
    ])

    const msgTtl = c.msgTtl || 0
    const uname = peerUsername()
    const mediaCount = mediaMessages().length

    /* -------- add-to-contacts: once added, the row flips to a permanent
     * 'In your contacts' state (re-rendered in place, no action). */
    const peerId = c.peer?.id
    const contactSlot = el('div', { class: 'cp-contact-slot' })
    function renderContactRow () {
      clear(contactSlot)
      if (!peerId) return
      const isContact = db.contacts().some((k) => k.id === peerId)
      if (isContact) {
        contactSlot.appendChild(el('div', { class: 'cp-row cp-static' }, [
          el('span', { class: 'cp-ri cp-inck', html: IC.check1 }),
          el('span', { class: 'cp-rl', text: 'In your contacts' })
        ]))
        return
      }
      contactSlot.appendChild(row(IC.plus, 'Add to contacts', null, () => {
        db.addContact({
          id: peerId,
          name: c.peer.name || name,
          avatar: c.peer.avatar || null,
          lang: c.peer.lang || null
        })
        ctx.toast('Added to contacts')
        renderContactRow()
      }))
    }
    renderContactRow()

    back.appendChild(el('div', { class: 'ms-sheet cp-sheet' }, [
      el('div', { class: 'cp-head' }, [
        avatar(person, 96),
        el('b', { class: 'cp-name', text: name }),
        uname ? el('span', { class: 'cp-uname', text: '@' + uname }) : null,
        el('span', { class: 'cp-status', text: contactStatusLine() })
      ]),
      el('div', { class: 'cp-acts' }, [
        act('', IC.phone, 'Voice', () => callAct(false)),
        act('', IC.videocam, 'Video', () => callAct(true)),
        canBlock ? act(' danger', IC.block, 'Block', confirmBlock) : null
      ]),
      el('div', { class: 'cp-list' }, [
        /* A GROUP'S ONLY DOOR IS ITS LINK, and no screen a user could reach was
         * building one. The two link builders that emit the `&g=` parameter
         * `adoptRoomLink` needs both live behind `#/groups`, and the group you
         * get from the inbox's "New group" is created locally — so it was a
         * room of one, permanently, with no button anywhere to invite anyone. */
        convo.kind === 'group'
          ? row(IC.link, 'Share invite link', null, () => {
              close()
              const c = db.convo(roomId) || convo
              const url = `${location.origin}${location.pathname}#r=${c.roomId}&k=${c.secret}` +
                `&g=${encodeURIComponent(c.title || 'Group')}`
              if (navigator.share) {
                navigator.share({ title: 'Spot Me', text: 'Join our group on Spot Me', url })
                  .catch(() => { /* dismissed, or unavailable mid-flight */ })
                return
              }
              navigator.clipboard?.writeText(url)
                .then(() => ctx.toast('Invite link copied'))
                .catch(() => ctx.toast('Could not share the link'))
            })
          : null,
        row(IC.link, 'Connected through', CONNECTED_VIA[convo.mode] || 'Invite link', null),
        row(IC.clock, 'Disappearing messages', msgTtl ? fmtTtlLong(msgTtl) : 'Off',
          () => { close(); openTimerSheet() }),
        row(IC.doc, 'Export chat', null, () => { close(); exportChat() }),
        row(IC.gallery, 'Media shared', mediaCount ? String(mediaCount) : null, toggleGallery),
        gallery,
        contactSlot,
        // Per the WhatsApp reference: red local clear + the encryption note.
        row(IC.x, 'Clear chat', null, () => {
          actionSheet([{
            label: 'Clear all messages on this device',
            danger: true,
            fn () {
              conn.store.clear()
              renderList()
              ctx.toast('Chat cleared on this device')
            }
          }], `Clear your copy of this chat with ${name}? Their copy is unaffected.`)
          close()
        }, ' danger'),
        // Clear empties the thread; Delete removes the conversation itself.
        row(IC.trash, 'Delete chat', null, () => {
          actionSheet([{
            label: 'Delete this conversation',
            danger: true,
            fn () {
              rooms.leave(roomId)
              db.removeConvo(roomId)
              ctx.toast(`Conversation with ${name} deleted`)
              ctx.nav('#/chat')
            }
          }], `Delete your whole conversation with ${name}? Messages and media on this device are removed — their copy is unaffected.`)
          close()
        }, ' danger'),
        canBlock
          ? row(IC.block, `Block ${name}`, null, confirmBlock, ' danger')
          : null
      ]),
      /* This used to read "No server can read them" for every chat. For v1
       * rooms that was false — their key came from a non-cryptographic hash of
       * two ids the server stores (V-19, ADR-001) — and a chat cannot be
       * migrated without destroying its history. So the line now tells the
       * truth per room instead of one reassuring sentence for both. */
      el('p', {
        class: 'cp-enc',
        text: e2eVersionNow() === 'e2e_v2'
          ? '🔒 Encrypted with keys created on your device and your contact\'s. The server carries the messages but holds no key to them.'
          : '⚠️ This is an older chat. Its key was derived from both account IDs, so the server could read it. Start a new chat for device-held keys.'
      }),
      /* CALLS ARE NOT COVERED BY THE LINE ABOVE, and a privacy panel that
       * mentions only the good half is the kind of omission people are right to
       * be angry about. Shown only where calls can actually be placed — with the
       * flag off there are no calls to make a claim about. */
      livekitCalls()
        ? el('p', {
          class: 'cp-enc warn',
          text: 'Calls are not end-to-end encrypted. Audio and video pass through a media server, which can see them, so that calls connect on mobile networks.'
        })
        : null
    ]))
    root.appendChild(back)
  }

  /* ------------------------------------------------------------- reply */
  function setReply (m) {
    replyTarget = m
    replyName.textContent = m.from === myId ? 'You' : (m.name || convo.peer?.name || 'Them')
    replySnippet.textContent = kindLabel(m)
    replybar.style.display = 'flex'
    input.focus()
  }

  function clearReply () {
    replyTarget = null
    replybar.style.display = 'none'
  }

  /* ---------------------------------------------------------- composer */
  /**
   * Live conversion, driven by the per-chat composeMode + langTo chosen in
   * the header. OFF by default — typing sends exactly what you typed.
   *
   *  'translit'  — Tamil-in-English-letters → Tamil script. Local rules are
   *                instant for ta/hi; Azure (debounced, cached) upgrades them
   *                and covers every SCRIPT_MAP language.
   *  'translate' — English (or anything; the engines detect) → ACTUAL
   *                target-language text. The hero line is what sends.
   *
   * Failures never block typing: the raw draft always stays sendable.
   */
  let bestConvert = null       // translit: { src, text, lang, engine }

  /** @param lang - resolved by detection in translit mode; falls back to the
   *  pinned ▾ language when the user forced one. */
  function convertDraft (raw, lang) {
    const { mode, langTo } = composeState()
    const target = lang || langTo
    if (mode !== 'translit' || !target || !raw) return null
    if (bestConvert?.src === raw && bestConvert.lang === target && bestConvert.engine === 'azure') {
      return { text: bestConvert.text, lang: target }
    }
    if (hasLocalScript(target)) {
      try {
        const converted = transliterate(raw, target)
        if (converted && converted !== raw) return { text: converted, lang: target }
      } catch { /* fall through */ }
    }
    if (bestConvert?.src === raw && bestConvert.lang === target) {
      return { text: bestConvert.text, lang: target }
    }
    return null
  }

  /**
   * The live conversion panel — the specialty of the app. Line one converts
   * INSTANTLY as you type (transliteration is synchronous). Line two shows
   * what the other person will read in THEIR language, debounced through the
   * fast proxy; whatever translation is showing when you hit send travels
   * WITH the message, so the receiver sees it with zero wait.
   */
  let lastTranslation = null   // translate: { src, text, lang, detected }
  let trSeq = 0
  let trTimer = null
  let cvSeq = 0
  let cvTimer = null
  let lastDetect = null        // translit: { src, base, romanized } last detection

  /**
   * Which language this draft should be written in.
   *
   * The pinned ▾ chip wins outright — the owner said so, and detection must
   * not argue. Otherwise the last detection for this exact draft, then the
   * conversation's own language. `chatLang()` ends at `myLang`, which is a
   * poor guess for an INCOMING message but the right one here: I am the person
   * typing, so my language is a fact rather than a claim.
   */
  function translitTarget (raw) {
    const pinned = (db.convo(roomId) || convo).xlitLang
    if (pinned && pinned !== 'en') return pinned
    if (lastDetect?.src === raw && lastDetect.base && lastDetect.base !== 'en') return lastDetect.base
    // "en" is not a transliteration target — English is already in its own
    // script. `chatLang()` ends at myLang, and someone whose profile says
    // English typing Tanglish is the single most common user of this feature,
    // so an English answer here means "unknown", not "done".
    const learned = chatLang()
    return learned && learned !== 'en' ? learned : null
  }

  const translitTag = (lang, converted) => {
    if (!converted) return '文A Reading…'
    /* Never print a raw ISO code at a person. Typing Malayalam once produced
     * the tag "文A it → English" because detection said Italian and langName()
     * hands back whatever it does not recognise. readingTag() already knows to
     * fall back to the bare mode, so use it. */
    return `文A ${readingTag(lang, 'Transliterated')}`
  }

  /**
   * Transliteration mode: the SAME words, in their own script.
   *
   * 文A means one thing — "same words, the other script" — and that is exactly
   * what it does in the message bubbles. In the composer it used to do
   * something else entirely: detect the language, then TRANSLATE the draft into
   * English. One toggle, two meanings, and the one the button's own aria-label
   * promises was the one it did not do.
   *
   * It was also the slowest thing in the app, for no reason. The on-device
   * engine is pure and measured at ~5 µs for a typed sentence — 0.03% of a
   * 60 fps frame — but nothing called it: `convertDraft` was defined and never
   * used. So the preview blanked to "…" on EVERY keystroke and settled
   * 1.2-4.9 s after the last one, at roughly one API call per keystroke, each
   * carrying a growing prefix of a draft that had not been sent to anybody.
   *
   * Now: convert locally on the same frame as the keypress, and let the
   * debounced remote transliteration upgrade that and cover the languages the
   * built-in engine has no table for.
   */
  function runTranslit (raw) {
    tlMain.style.display = ''

    /* English is settled deterministically and for free, exactly as it is on
     * the reading side — no network, and no chance of an engine deciding that
     * a sentence containing the word "Kannada" is Kannada. */
    if (isPlainEnglish(raw)) {
      lastDetect = null
      bestConvert = null
      tlTag.textContent = '文A Already English'
      tlMain.textContent = raw
      return
    }

    const target = translitTarget(raw)
    const local = target ? convertDraft(raw, target) : null
    /* Leftover ASCII is the tell that the guess was wrong: Tamil has no
     * f/x/z key, so a real transliteration consumes every Latin letter.
     * Without this, "Netflix and chill" in a Tamil chat painted instantly and
     * confidently as ணெட்fலிx அந்ட் சில்ல். */
    if (local && !/[a-z]/i.test(local.text) &&
        !(bestConvert?.src === raw && bestConvert.engine === 'azure')) {
      bestConvert = { src: raw, text: local.text, lang: target, engine: 'local' }
    }

    const showing = bestConvert?.src === raw ? bestConvert : null
    tlTag.textContent = translitTag(showing?.lang || target, Boolean(showing))
    // Never blank. The draft itself is a truthful placeholder; an ellipsis is
    // not, and `blanks == chars` on every measured run was this one line.
    tlMain.textContent = showing?.text || raw

    const seq = ++cvSeq
    cvTimer = later(async () => {
      // Detection is only needed when nothing else knows the language, which
      // after the first exchange in a chat is never.
      let lang = target
      if (!lang) {
        const hit = await detectLanguage(raw)
        if (!mounted || seq !== cvSeq) return
        if (hit?.base === 'en') {
          lastDetect = null
          bestConvert = null
          tlTag.textContent = '文A Already English'
          tlMain.textContent = raw
          return
        }
        lang = hit?.base || null
        if (lang) lastDetect = { src: raw, base: lang, romanized: Boolean(hit?.romanized) }
      }
      if (!lang || lang === 'en') {
        if (!showing) tlTag.textContent = '文A Could not read that one'
        return
      }
      if (lang !== chatLang()) rememberChatLang(lang)

      // The remote transliterator knows real WORDS, so it beats the rule
      // engine on ear-spelled input and covers every SCRIPT_MAP language.
      // A failure keeps whatever is already painted — it never blanks it.
      const native = await transliterateRemote(raw, lang)
      if (!mounted || seq !== cvSeq) return
      if (!native || native === raw) {
        if (!bestConvert || bestConvert.src !== raw) {
          tlTag.textContent = navigator.onLine === false
            ? '文A Offline — showing what you typed'
            : '文A Could not read that one'
        }
        return
      }
      bestConvert = { src: raw, text: native, lang, engine: 'azure' }
      tlTag.textContent = translitTag(lang, true)
      if (input.value.trim() === raw) tlMain.textContent = native
    }, 260)
  }

  function updatePreview () {
    const raw = input.value.trim()
    const { mode, langTo } = composeState()
    drop(cvTimer); cvTimer = null
    drop(trTimer); trTimer = null

    // Transliteration needs no target language — it detects one. Translation
    // still does, since "into what?" has no default answer.
    if (!mode || !raw || (mode === 'translate' && !langTo)) {
      lastTranslation = null
      tlprev.style.display = 'none'
      return
    }

    tlprev.style.display = ''
    tlSub.style.display = 'none'
    tlTag.style.display = ''

    if (mode === 'translit') {
      runTranslit(raw)
      return
    }

    /* translate mode — the hero line IS what will send */
    tlTag.textContent = `文A Translation · ${langName(langTo)}`
    const fresh = lastTranslation?.src === raw && lastTranslation.lang === langTo
    tlMain.textContent = fresh ? lastTranslation.text : '…'
    tlMain.style.display = ''
    if (fresh && lastTranslation.detected && lastTranslation.detected !== langTo) {
      const base = String(lastTranslation.detected).split('-')[0]
      const roman = String(lastTranslation.detected).includes('-Latn') ? ' (romanized)' : ''
      tlSub.textContent = `Detected ${langName(base)}${roman}`
      tlSub.style.display = ''
    }
    const seq = ++trSeq
    trTimer = later(() => {
      translateText(raw, null, langTo).then((res) => {
        if (!mounted || seq !== trSeq) return
        if (res.text && res.engine !== null) {
          lastTranslation = { src: raw, text: res.text, lang: langTo, detected: res.detected }
          rememberMyLang(res.detected)
          if (input.value.trim() === raw) {
            tlMain.textContent = res.text
            if (res.detected && res.detected !== langTo) {
              const base = String(res.detected).split('-')[0]
              const roman = String(res.detected).includes('-Latn') ? ' (romanized)' : ''
              tlSub.textContent = `Detected ${langName(base)}${roman}`
              tlSub.style.display = ''
            }
          }
        }
      })
    }, 320)
  }

  function updateMic () {
    if (recording) return   // the stop icon owns the button while recording
    const hasText = Boolean(input.value.trim())
    micBtn.innerHTML = hasText ? IC.send : IC.camera
    micBtn.setAttribute('aria-label', hasText ? 'Send' : 'Take a photo')
  }

  function sendPartial (partial) {
    if (replyTarget) partial.replyTo = replyTarget.id
    const m = rooms.sendMessage(roomId, partial)
    clearReply()
    if (m) { appendMessage(m); scrollBottom() }
    return m
  }

  function dispatchSend (partial) {
    // Timer-messages mode: every outgoing text carries the per-chat ttl.
    const msgTtl = db.convo(roomId)?.msgTtl || 0
    if (msgTtl) partial.ttl = msgTtl
    sendPartial(partial)
    bestConvert = null
    lastTranslation = null
    input.value = ''
    updatePreview()
    updateMic()
    rooms.typing(roomId, false)
    lastTypingSent = 0
    drop(idleTimer)
    idleTimer = null
  }

  let sendBusy = false

  function sendText () {
    if (sendBusy) return
    const raw = input.value.trim()
    if (!raw) return
    const { mode, langTo } = composeState()

    // Transliteration never rewrites what leaves the device — it is a reading
    // aid. Changing the outgoing words is translation's job (the globe).
    if (mode === 'translit') {
      dispatchSend({ text: raw })
      return
    }
    if (mode === 'translate' && langTo) {
      if (lastTranslation?.src === raw && lastTranslation.lang === langTo) {
        const src = String(lastTranslation.detected || 'en').split('-')[0]
        // tr carries the ORIGINAL: a receiver reading my language sees it instantly.
        dispatchSend({ text: lastTranslation.text, lang: langTo, tr: { lang: src, text: raw } })
        return
      }
      // Preview has not caught up — finish the translation, then send. Capped
      // at 4s; if every engine is down the plain draft goes out instead.
      sendBusy = true
      micBtn.classList.add('busy')
      Promise.race([
        translateText(raw, null, langTo),
        new Promise((resolve) => later(() => resolve({ text: null, engine: null }), 4000))
      ]).then((res) => {
        sendBusy = false
        micBtn.classList.remove('busy')
        if (!mounted) return
        if (res?.text && res.engine !== null) {
          const src = String(res.detected || 'en').split('-')[0]
          dispatchSend({ text: res.text, lang: langTo, tr: { lang: src, text: raw } })
        } else {
          dispatchSend({ text: raw })
        }
      })
      return
    }

    dispatchSend({ text: raw })
  }

  input.addEventListener('input', () => {
    updatePreview()
    updateMic()
    const now = Date.now()
    if (input.value && now - lastTypingSent > TYPING_THROTTLE_MS) {
      rooms.typing(roomId, true, 'typing')
      lastTypingSent = now
    }
    drop(idleTimer)
    idleTimer = later(() => rooms.typing(roomId, false), TYPING_IDLE_MS)
  })

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && db.settings().enterSends) {
      e.preventDefault()
      sendText()
    }
  })

  /* ------------------------------------------------------- attachments */
  /** The composer chip mirrors the per-chat timer mode (set via control
   * messages from either side). Visible only while the mode is on. */
  function updateTtlChip () {
    const secs = db.convo(roomId)?.msgTtl || 0
    ttlChip.style.display = secs ? '' : 'none'
    ttlChip.textContent = secs ? `⏱ ${fmtTtlChip(secs)}` : ''
  }

  /** Timer-messages wheel (same vertical wheel as the private-photo picker).
   * Committing sends a control message through the normal path; rooms.js
   * flips convo.msgTtl on BOTH sides when it lands. */
  function openTimerSheet () {
    const cur = db.convo(roomId)?.msgTtl || 0
    const idx = Math.max(0, TIMER_OPTIONS.findIndex((o) => o.secs === cur))
    const hint = el('div', { class: 'phint' })
    const wheel = buildWheel(TIMER_OPTIONS, idx, (o) => {
      hint.textContent = o.secs
        ? `New messages disappear for both of you after ${o.label}`
        : 'New messages stay in the chat'
    })
    const back = el('div', { class: 'psheet-back' })
    back.appendChild(el('div', { class: 'psheet' }, [
      el('button', {
        class: 'psx', type: 'button', 'aria-label': 'Close', html: IC.x,
        onclick () { back.remove() }
      }),
      el('div', { class: 'plabel', text: 'Timer messages' }),
      wheel.pick,
      hint,
      el('button', {
        class: 'pdone', type: 'button', text: 'Set',
        onclick () {
          const secs = wheel.selected().secs
          back.remove()
          if (secs === (db.convo(roomId)?.msgTtl || 0)) return   // unchanged — no control spam
          const m = rooms.sendMessage(roomId, { kind: 'system', sys: 'timer', secs, text: '' })
          if (m) { appendMessage(m); scrollBottom() }
        }
      })
    ]))
    root.appendChild(back)
    wheel.init()
  }

  function sendLocation () {
    currentLocation()
      .then(({ lat, lon }) => { sendPartial({ kind: 'location', lat, lon }) })
      .catch((e) => ctx.toast(e.message))
  }

  /* ------------------------------------------------------ live location */
  function startLiveShare (ms) {
    if (!navigator.geolocation?.watchPosition) {
      ctx.toast('Location is not available on this device')
      return
    }
    currentLocation()
      .then(({ lat, lon }) => {
        if (!mounted) return
        const until = ms ? Date.now() + ms : null
        const m = sendPartial({ kind: 'location', lat, lon, live: true, until })
        if (!m) return
        const watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (!liveShares.has(m.id)) return
            rooms.locup(roomId, { id: m.id, lat: pos.coords.latitude, lon: pos.coords.longitude })
            refreshRow(m.id)
          },
          () => { /* a lost fix mid-share is not fatal — the last pin stands */ },
          { enableHighAccuracy: true }
        )
        // Auto-stop when the chosen duration ends (∞ has no deadline).
        const stopTimer = until ? later(() => stopLiveShare(m.id), until - Date.now()) : null
        liveShares.set(m.id, { watchId, stopTimer })
      })
      .catch((e) => ctx.toast(e.message))
  }

  function stopLiveShare (id) {
    const share = liveShares.get(id)
    if (share) {
      try { navigator.geolocation?.clearWatch?.(share.watchId) } catch { /* already gone */ }
      drop(share.stopTimer)
      liveShares.delete(id)
    }
    rooms.locup(roomId, { id, stop: true })
    refreshRow(id)
  }

  /** WhatsApp-reference location sheet: one-shot pin behind an explicit
   * confirm, or a live share with a duration. Nothing sends on open. */
  function openLocationSheet () {
    if (root.querySelector('.loc-back')) return
    const back = el('div', { class: 'at-back loc-back' })
    const close = () => back.remove()
    const mountedAt = Date.now()
    back.addEventListener('click', (e) => {
      if (Date.now() - mountedAt < 400) { e.stopPropagation(); e.preventDefault() }
    }, true)
    back.addEventListener('click', (e) => { if (e.target === back) close() })

    const DURATIONS = [
      { label: '15 min', ms: 15 * 60000 },
      { label: '1 h', ms: 3600000 },
      { label: '8 h', ms: 8 * 3600000 },
      { label: '12 h', ms: 12 * 3600000 },
      { label: '24 h', ms: 24 * 3600000 },
      { label: '∞', ms: null }
    ]
    let sel = DURATIONS[0]
    const segSub = el('span', { class: 'loc-sub', style: 'display:none', text: 'until you turn it off' })
    const segBtns = DURATIONS.map((d, i) => el('button', {
      class: 'loc-segb' + (i === 0 ? ' on' : ''), type: 'button', text: d.label,
      onclick () {
        sel = d
        segBtns.forEach((b, j) => b.classList.toggle('on', j === i))
        segSub.style.display = d.ms === null ? '' : 'none'
      }
    }))

    back.appendChild(el('div', { class: 'at-sheet loc-sheet' }, [
      el('div', { class: 'fw-title', text: 'Location' }),
      el('div', { class: 'loc-sec' }, [
        el('b', { text: 'Send current location' }),
        el('span', { class: 'loc-sub', text: 'A one-time pin of where you are right now.' }),
        el('button', {
          class: 'loc-commit', type: 'button', text: 'Send location',
          onclick () { close(); sendLocation() }
        })
      ]),
      el('div', { class: 'loc-sec' }, [
        el('b', { text: 'Share live location' }),
        el('div', { class: 'loc-seg' }, segBtns),
        segSub,
        el('button', {
          class: 'loc-commit', type: 'button', text: 'Start sharing',
          onclick () { close(); startLiveShare(sel.ms) }
        })
      ]),
      el('button', { class: 'ms-item cancel', type: 'button', text: 'Cancel', onclick: close })
    ]))
    root.appendChild(back)
  }

  /**
   * Early activity: the peer's header says 'sending a photo…' from the moment
   * an attachment type is COMMITTED in the attach sheet — not just during the
   * wire send. Kept alive every 2.5s while the picker or a preview sheet is
   * open; the in-flight indicator in sendAttachmentWithUI then takes over
   * silently, so the peer sees ONE continuous signal from tap to sent.
   */
  function startEarlyActivity (kind) {
    stopEarlyActivity(true)
    earlyKind = kind
    pickerArmed = true          // every early kind opens a native picker first
    rooms.typing(roomId, true, kind)
    earlyTimer = setInterval(() => rooms.typing(roomId, true, kind), ACTIVITY_PING_MS)
  }

  /** silent=true is the handoff: the in-flight indicator continues the same
   * kind immediately, so no typing(false) gap must reach the peer. */
  function stopEarlyActivity (silent) {
    if (earlyTimer) { clearInterval(earlyTimer); earlyTimer = null }
    pickerArmed = false
    if (earlyKind && !silent) rooms.typing(roomId, false)
    earlyKind = null
  }

  /** Focus returned with the picker still unanswered → treat as cancelled.
   * A real selection fires `change` around the same moment (before or after
   * focus, per browser), so give it a beat before concluding. */
  function onWindowFocus () {
    if (!pickerArmed) return
    later(() => { if (mounted && pickerArmed) stopEarlyActivity() }, 900)
  }
  window.addEventListener('focus', onWindowFocus)
  // Browsers that support the input `cancel` event tell us outright.
  for (const inp of [photoInput, cameraInput, fileInput, videoInput]) {
    inp.addEventListener('cancel', () => stopEarlyActivity())
  }

  /** Premium attach sheet (WhatsApp reference): a grid of white circular
   * tiles, four per row, each with a coloured icon and an 11px label. */
  function openAttach () {
    if (root.querySelector('.at-back')) return
    const back = el('div', { class: 'at-back' })
    const close = () => back.remove()
    // Ghost-click armour, same 400ms as every other sheet here.
    const mountedAt = Date.now()
    back.addEventListener('click', (e) => {
      if (Date.now() - mountedAt < 400) { e.stopPropagation(); e.preventDefault() }
    }, true)
    back.addEventListener('click', (e) => { if (e.target === back) close() })

    const tile = (cls, icon, label, fn, extra = '') => el('button', {
      class: 'at-tile' + extra, type: 'button', 'aria-label': label,
      onclick () { close(); fn() }
    }, [
      el('span', { class: 'at-circ ' + cls, html: icon }),
      el('span', { class: 'at-label', text: label })
    ])

    back.appendChild(el('div', { class: 'at-sheet' }, [
      el('div', { class: 'at-grid' }, [
        tile('c-photos', IC.gallery, 'Photos', () => { viewOncePick = false; startEarlyActivity('photo'); photoInput.click() }),
        tile('c-camera', IC.camera, 'Camera', () => { viewOncePick = false; startEarlyActivity('photo'); cameraInput.click() }),
        tile('c-private', IC.fire, 'Private photo', () => { viewOncePick = true; startEarlyActivity('viewonce'); photoInput.click() }),
        tile('c-video', IC.play, 'Video', () => { startEarlyActivity('video'); videoInput.click() }),
        tile('c-doc', IC.doc, 'Document', () => { startEarlyActivity('file'); fileInput.click() }),
        tile('c-loc', IC.pin, 'Location', openLocationSheet),
        tile('c-timer', IC.clock, 'Timer', openTimerSheet),
        // While a session runs the mic tile goes red/pulsing; tapping stops it.
        tile('c-dictate', IC.micGhost, dictating ? 'Listening…' : 'Dictate',
          toggleDictation, dictating ? ' dict-live' : '')
      ])
    ]))
    root.appendChild(back)
  }

  /** Send any attachment with a live progress ring on the bubble, plus the
   * Telegram-style peer activity ping ('sending a photo…') while in flight. */
  function sendAttachmentWithUI (partial) {
    stopEarlyActivity(true)   // handoff — the in-flight signalling below continues it
    if (replyTarget) { partial.replyTo = replyTarget.id; clearReply() }
    const actKind = partial.kind === 'image'
      ? (partial.viewOnce ? 'viewonce' : 'photo')
      : partial.kind === 'file' ? 'file'
      : partial.kind === 'video' ? 'video' : null
    if (actKind) { rooms.typing(roomId, true, actKind); activityPingAt = Date.now() }
    let sent = null
    const message = rooms.sendAttachment(roomId, partial, (p) => {
      if (actKind) {
        if (p >= 1 || p === -1) rooms.typing(roomId, false)
        else if (Date.now() - activityPingAt > ACTIVITY_PING_MS) {
          // Receivers expire the indicator after 4s — keep it alive mid-send.
          rooms.typing(roomId, true, actKind)
          activityPingAt = Date.now()
        }
      }
      if (sent) paintProgress(sent.id, p)
    })
    sent = message
    if (!message && actKind) rooms.typing(roomId, false)
    if (message) {
      inFlight.add(message.id)
      appendMessage(message)
      scrollBottom()
    }
  }

  /** Move one outgoing attachment's progress chip, and retire it when done. */
  function paintProgress (id, p) {
    if (p >= 1 || p === -1) inFlight.delete(id)
    const ring = msgEls.get(id)?.wrap.querySelector('.txprog')
    if (p === -1) {
      // A failure belongs on the read row — "Not delivered", with Retry — which
      // is persisted and survives a reload. The chip is in-flight state only,
      // so it goes with the flight.
      ring?.remove()
      refreshRow(id)
      return
    }
    if (!ring) return
    if (p >= 1) ring.remove()
    else ring.textContent = `${Math.round(p * 100)}%`
  }

  /** Push a failed attachment's bytes again — they never left this device. */
  function retrySend (m) {
    // Text has no bytes and no progress ring — it just goes again.
    if (!m.kind || m.kind === 'text') {
      if (!rooms.retryMessage(roomId, m.id)) { ctx.toast('That message is no longer here'); return }
      refreshRow(m.id)
      return
    }
    inFlight.add(m.id)
    if (!rooms.retryAttachment(roomId, m.id, (p) => paintProgress(m.id, p))) {
      inFlight.delete(m.id)
      ctx.toast('Those bytes are no longer on this device')
      return
    }
    refreshRow(m.id)
  }

  /**
   * The Telegram-style VERTICAL wheel, shared by the private-photo burst
   * picker and the timer-messages picker. Rows snap to a centre highlight
   * pill with a soft tick per detent. Call init() after mounting.
   */
  function buildWheel (options, initialIdx, onChange) {
    const ROW_H = 44
    let selIdx = Math.max(0, Math.min(options.length - 1, initialIdx))

    const rows = options.map((o, i) => el('div', {
      class: 'vrow',
      text: o.label,
      onclick () { col.scrollTo({ top: i * ROW_H, behavior: 'smooth' }) }
    }))
    const col = el('div', { class: 'vcol' }, rows)
    const pick = el('div', { class: 'vpick' }, [el('div', { class: 'vpill' }), col])

    function applySelection (idx, silent) {
      idx = Math.max(0, Math.min(options.length - 1, idx))
      if (idx !== selIdx) {
        selIdx = idx
        if (!silent) tickBlip()
      }
      onChange?.(options[selIdx])
    }

    /** Centre row pops, neighbours fade/scale with distance from the pill. */
    function styleRows () {
      const fidx = col.scrollTop / ROW_H
      rows.forEach((row, i) => {
        const d = Math.abs(i - fidx)
        row.style.opacity = String(Math.max(0.22, 1 - d * 0.32))
        row.style.transform = `scale(${Math.max(0.82, 1 - d * 0.07).toFixed(3)})`
        row.classList.toggle('on', Math.round(fidx) === i)
      })
    }

    let settleTimer = null
    col.addEventListener('scroll', () => {
      styleRows()
      applySelection(Math.round(col.scrollTop / ROW_H))
      // Debounced settle for browsers without scrollend.
      drop(settleTimer)
      settleTimer = later(() => {
        applySelection(Math.round(col.scrollTop / ROW_H), true)
        styleRows()
      }, 120)
    }, { passive: true })
    if ('onscrollend' in window) {
      col.addEventListener('scrollend', () => {
        applySelection(Math.round(col.scrollTop / ROW_H), true)
        styleRows()
      })
    }

    return {
      pick,
      selected: () => options[selIdx],
      init () {
        applySelection(selIdx, true)
        requestAnimationFrame(() => {
          col.scrollTop = selIdx * ROW_H
          styleRows()
        })
      }
    }
  }

  /**
   * Photo sheet. Plain photos: preview + Cancel/Send (legacy path; Photos/
   * Camera now route through the editor first). Private photos: preview +
   * the burst wheel (no Off; 10s default) — masked, opens once, counts down,
   * bursts, deleted without trace. Accepts a single dataURL (+ caption) or a
   * batch of {dataURL, caption} from the editor; a private batch spins the
   * wheel ONCE and the chosen burst applies to every photo. Captions ride
   * along as message.text on whichever path sends.
   */
  function openPhotoSheet (photosOrURL, caption) {
    const photos = typeof photosOrURL === 'string'
      ? [{ dataURL: photosOrURL, caption: caption || '' }]
      : photosOrURL
    if (!photos?.length) { stopEarlyActivity(); return }
    const back = el('div', { class: 'psheet-back' })
    const sendAll = async (extra) => {
      for (const p of photos) {
        const partial = { kind: 'image', data: p.dataURL, ...extra }
        if (p.caption) partial.text = p.caption
        /* A private photo carries its own mask: a 16px thumbnail made here,
         * on the sender's device, so the recipient's masked bubble has
         * something to blur that is NOT the photo. The detail has to be
         * destroyed before transmission — a CSS blur over the real bytes is a
         * rendering instruction, not a redaction. */
        if (partial.viewOnce) partial.mask = await maskDataURL(p.dataURL)
        sendAttachmentWithUI(partial)
      }
    }

    if (!viewOncePick) {
      back.appendChild(el('div', { class: 'psheet' }, [
        el('img', { class: 'pprev', src: photos[0].dataURL, alt: '' }),
        el('div', { class: 'pacts' }, [
          el('button', {
            class: 'pcancel', type: 'button', text: 'Cancel',
            onclick () { back.remove(); stopEarlyActivity() }
          }),
          el('button', {
            class: 'pdone', type: 'button', text: photos.length > 1 ? `Send ${photos.length}` : 'Send',
            onclick () {
              back.remove()
              sendAll({})
            }
          })
        ])
      ]))
      root.appendChild(back)
      return
    }

    const hint = el('div', { class: 'phint' })
    const wheel = buildWheel(
      BURST_OPTIONS,
      Math.max(0, BURST_OPTIONS.findIndex((o) => o.secs === 10)),
      (o) => {
        hint.textContent = photos.length > 1
          ? `Each opens once · bursts after ${o.label}`
          : `Opens once · bursts after ${o.label}`
      }
    )
    back.appendChild(el('div', { class: 'psheet' }, [
      el('button', {
        class: 'psx',
        type: 'button',
        'aria-label': 'Close',
        html: IC.x,
        onclick () { back.remove(); stopEarlyActivity() }
      }),
      el('img', { class: 'pprev', src: photos[0].dataURL, alt: '' }),
      el('div', { class: 'plabel', text: photos.length > 1 ? `Private photos · ${photos.length}` : 'Private photo' }),
      wheel.pick,
      hint,
      el('button', {
        class: 'pdone',
        type: 'button',
        text: photos.length > 1 ? `Send ${photos.length}` : 'Send',
        onclick () {
          const secs = wheel.selected().secs
          back.remove()
          sendAll({ viewOnce: true, burst: secs })
        }
      })
    ]))
    root.appendChild(back)
    wheel.init()
  }

  /**
   * Photos/Camera picks route through the fullscreen editor. While it is
   * open the early 'photo' keep-alive keeps pinging (pickerArmed is false,
   * so the focus heuristic leaves it alone). A null resolve is a full
   * cancel; a ①-toggled resolve hands the EDITED batch to the burst wheel
   * (one wheel choice for every photo). Plain batches send in order as
   * separate image messages, each with its own caption.
   */
  function editThenSend (dataURLs) {
    openPhotoEditor(dataURLs).then((res) => {
      if (!mounted) return
      if (!res) { stopEarlyActivity(); return }
      const photos = res.photos || [{ dataURL: res.dataURL, caption: res.caption }]
      if (res.privatePhoto) {
        viewOncePick = true
        openPhotoSheet(photos)
        return
      }
      for (const p of photos) {
        const partial = { kind: 'image', data: p.dataURL }
        if (p.caption) partial.text = p.caption
        sendAttachmentWithUI(partial)
      }
    })
  }

  photoInput.addEventListener('change', () => {
    let files = Array.from(photoInput.files || [])
    photoInput.value = ''
    if (!files.length) { stopEarlyActivity(); return }
    pickerArmed = false   // picker answered — the editor/sheet keeps the signal alive
    if (viewOncePick) {
      // The Private-photo tile keeps its direct single-photo path to the wheel.
      if (files.length > 1) ctx.toast('Private photos send one at a time')
      compressImage(files[0])
        .then(({ dataURL }) => { if (mounted) openPhotoSheet(dataURL) })
        .catch(() => { stopEarlyActivity(); ctx.toast('Could not read that image') })
      return
    }
    if (files.length > MAX_BATCH_PHOTOS) {
      ctx.toast('Up to 10 photos at once')
      files = files.slice(0, MAX_BATCH_PHOTOS)
    }
    Promise.all(files.map((f) =>
      compressImage(f, EDIT_MAX_EDGE, EDIT_QUALITY).then((r) => r.dataURL).catch(() => null)
    )).then((urls) => {
      if (!mounted) return
      const ok = urls.filter(Boolean)
      if (!ok.length) { stopEarlyActivity(); ctx.toast('Could not read that image'); return }
      if (ok.length < urls.length) ctx.toast('Some photos could not be read')
      editThenSend(ok)
    })
  })

  // Camera capture lands in the SAME editor flow (single photo, never
  // viewOnce by default).
  cameraInput.addEventListener('change', () => {
    const file = cameraInput.files?.[0]
    cameraInput.value = ''
    if (!file) { stopEarlyActivity(); return }
    pickerArmed = false
    viewOncePick = false
    compressImage(file, EDIT_MAX_EDGE, EDIT_QUALITY)
      .then(({ dataURL }) => { if (mounted) editThenSend(dataURL) })
      .catch(() => { stopEarlyActivity(); ctx.toast('Could not read that photo') })
  })

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) { stopEarlyActivity(); return }
    pickerArmed = false
    // Same pre-check as video: a 40 MB "file" fails the same way for the same
    // reason, and used to fail just as slowly and just as mutely.
    const verdict = await precheckAttachment(file).catch(() => ({ ok: true }))
    if (!verdict.ok) { stopEarlyActivity(); ctx.toast(verdict.message); return }
    fileToDataURL(file)
      .then(({ dataURL, name, size }) => {
        sendAttachmentWithUI({ kind: 'file', data: dataURL, fileName: name, fileSize: size })
      })
      .catch((e) => { stopEarlyActivity(); ctx.toast(e.message) })
  })

  /** Video: whole-clip send over the existing chunked binary path. No fake
   * trimmer — trimming honestly waits for the native app. */
  function sendVideo (file) {
    /* REFUSE BEFORE THE FIRST BYTE MOVES.
     *
     * Without this the clip was read, base64'd, chunked and pushed 128 KB at a
     * time for minutes before failing — and the refusal, when it came, said
     * only "That transfer did not complete — try again", which is advice to
     * repeat something that cannot work. Everything needed to know it was
     * doomed is readable in the first millisecond. */
    precheckAttachment(file)
      .then((verdict) => {
        if (!verdict.ok) { stopEarlyActivity(); ctx.toast(verdict.message); return }
        sendVideoChecked(file)
      })
      .catch(() => sendVideoChecked(file))   // never block a send on the check itself
  }

  function sendVideoChecked (file) {
    fileToDataURL(file, VIDEO_CAP_BYTES)
      .then(({ dataURL, name, size }) => {
        sendAttachmentWithUI({ kind: 'video', data: dataURL, fileName: name, fileSize: size })
      })
      .catch((e) => { stopEarlyActivity(); ctx.toast(e.message) })
  }

  /** Video choice sheet: Send / Trim plus a STATIC quality line — the web
   * build always ships the original bytes, honestly stated, no fake toggle. */
  function openVideoSheet (file) {
    if (root.querySelector('.vq-back')) return
    const back = el('div', { class: 'ms-back vq-back' })
    const close = () => back.remove()
    const mountedAt = Date.now()
    back.addEventListener('click', (e) => {
      if (Date.now() - mountedAt < 400) { e.stopPropagation(); e.preventDefault() }
    }, true)
    back.addEventListener('click', (e) => { if (e.target === back) { close(); stopEarlyActivity() } })
    back.appendChild(el('div', { class: 'ms-sheet' }, [
      el('div', { class: 'fw-title', text: 'Send video' }),
      el('div', { class: 'vq-row' }, [
        el('b', { text: 'Quality: Original' }),
        el('span', { text: ' — compression arrives with the native app' })
      ]),
      el('button', {
        class: 'ms-item', type: 'button', text: 'Send entire video',
        onclick () { close(); sendVideo(file) }
      }),
      el('button', {
        class: 'ms-item', type: 'button', text: 'Trim video',
        onclick () { close(); stopEarlyActivity(); ctx.toast('Trimming arrives with the native app') }
      }),
      el('button', {
        class: 'ms-item cancel', type: 'button', text: 'Cancel',
        onclick () { close(); stopEarlyActivity() }
      })
    ]))
    root.appendChild(back)
  }

  videoInput.addEventListener('change', () => {
    const file = videoInput.files?.[0]
    videoInput.value = ''
    if (!file) { stopEarlyActivity(); return }
    pickerArmed = false   // choice sheet open — keep-alive keeps signalling
    openVideoSheet(file)
  })

  /* -------------------------------------------------------- voice note */
  /**
   * Live recording waveform: an AnalyserNode on the mic stream drives the
   * REC_BARS bars via rAF while recording. Decorative — any failure (blocked
   * AudioContext, odd device) leaves the bars flat and recording untouched.
   */
  let recSource = null
  let recAnalyser = null
  let recRaf = 0

  function startRecWave (stream) {
    try {
      const ac = getAudioCtx()
      if (!ac || !stream) return
      recSource = ac.createMediaStreamSource(stream)
      recAnalyser = ac.createAnalyser()
      recAnalyser.fftSize = 128
      recSource.connect(recAnalyser)   // analyser only — never to the speakers
      const buf = new Uint8Array(recAnalyser.frequencyBinCount)
      const bars = [...recWave.children]
      const step = Math.max(1, Math.floor(buf.length / bars.length))
      const loop = () => {
        if (!mounted || !recAnalyser) return
        recAnalyser.getByteFrequencyData(buf)
        for (let i = 0; i < bars.length; i++) {
          let peak = 0
          for (let j = i * step; j < (i + 1) * step && j < buf.length; j++) {
            if (buf[j] > peak) peak = buf[j]
          }
          bars[i].style.height = `${3 + Math.round((peak / 255) * 19)}px`
        }
        recRaf = requestAnimationFrame(loop)
      }
      recRaf = requestAnimationFrame(loop)
    } catch { /* no waveform — the recording itself is unaffected */ }
  }

  function stopRecWave () {
    if (recRaf) { cancelAnimationFrame(recRaf); recRaf = 0 }
    try { recSource?.disconnect() } catch { /* already detached */ }
    recSource = null
    recAnalyser = null
    for (const b of recWave.children) b.style.height = ''
  }

  function setRecordingUI (on) {
    plusBtn.style.display = on ? 'none' : ''
    field.style.display = on ? 'none' : ''
    recbar.style.display = on ? 'flex' : ''
    micBtn.classList.toggle('rec', on)
    micBtn.innerHTML = on ? IC.stop : IC.camera
    micBtn.setAttribute('aria-label', on ? 'Stop recording' : 'Take a photo')
    if (!on) updateMic()
  }

  /** Honest failure surfacing — phones fail for several distinct reasons. */
  function voiceError (e) {
    const name = e?.name || ''
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'Microphone permission denied — allow mic access for this site and try again'
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'No microphone found on this device'
    }
    if (name === 'NotReadableError') return 'The microphone is in use by another app'
    return `Could not start recording${e?.message ? ` — ${e.message}` : ''}`
  }

  let recStarting = false

  async function startRecording () {
    if (recording || recStarting || pendingClip) return
    if (!navigator.mediaDevices?.getUserMedia) {
      ctx.toast('Recording is not supported here — it needs HTTPS and a modern browser')
      return
    }
    if (typeof window.MediaRecorder === 'undefined') {
      ctx.toast('This browser cannot record audio — MediaRecorder is missing')
      return
    }
    recStarting = true
    let rec
    try {
      rec = await recordVoice()
    } catch (e) {
      recStarting = false
      ctx.toast(voiceError(e))
      return
    }
    recStarting = false
    if (!mounted) { rec.cancel(); return }
    recording = rec
    recStartedAt = Date.now()
    recTime.textContent = '0:00'
    setRecordingUI(true)
    startRecWave(rec.stream)
    rooms.typing(roomId, true, 'voice')
    activityPingAt = Date.now()
    recInterval = setInterval(() => {
      const s = Math.floor((Date.now() - recStartedAt) / 1000)
      recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      if (Date.now() - activityPingAt > ACTIVITY_PING_MS) {
        // Receivers expire the indicator after 4s — keep it alive.
        rooms.typing(roomId, true, 'voice')
        activityPingAt = Date.now()
      }
    }, 250)
  }

  function endRecordingUI () {
    if (recInterval) { clearInterval(recInterval); recInterval = null }
    stopRecWave()
    setRecordingUI(false)
  }

  /** Mic tap #2: stop, then hand the clip to the review bar. Nothing sends yet. */
  async function stopRecording () {
    if (!recording) return
    const rec = recording
    recording = null
    endRecordingUI()
    rooms.typing(roomId, false)
    let clip = null
    try { clip = await rec.stop() } catch { /* falls through to the size check */ }
    if (!mounted) return
    if (!clip || !clip.size) {
      ctx.toast('Nothing was recorded — the microphone produced no audio')
      return
    }
    showVoiceConfirm(clip)
  }

  const fmtClock = (secs) => {
    const s = Math.max(0, Math.round(secs || 0))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  /** The confirmation bar: preview player + Cancel + Send (ink pill). */
  function showVoiceConfirm (clip) {
    pendingClip = clip
    clear(confbar)
    confAudio = el('audio', { src: clip.dataURL, preload: 'metadata' })
    const playBtn = el('button', { class: 'vv-play', type: 'button', 'aria-label': 'Preview voice note', html: IC.play })
    const timeEl = el('span', { class: 'vv-time', text: `0:00 / ${fmtClock(clip.dur)}` })
    confStatus = timeEl
    let raf = 0
    const paint = () => {
      if (!confAudio) return
      timeEl.textContent = `${fmtClock(confAudio.currentTime)} / ${fmtClock(clip.dur)}`
      if (!confAudio.paused) raf = requestAnimationFrame(paint)
    }
    playBtn.addEventListener('click', () => {
      if (!confAudio) return
      if (confAudio.paused) playExclusive(confAudio).then((ok) => { if (!ok) ctx.toast('Could not play the recording') })
      else confAudio.pause()
    })
    confAudio.addEventListener('play', () => { playBtn.innerHTML = IC.pause; raf = requestAnimationFrame(paint) })
    const settle = () => {
      playBtn.innerHTML = IC.play
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      paint()
    }
    confAudio.addEventListener('pause', settle)
    confAudio.addEventListener('ended', settle)
    // Compact 'Translate ▾' select: 'Original' sends the clip untouched;
    // picking a language re-voices it via the sender's ElevenLabs clone.
    const trSel = el('select', {
      class: 'vv-lang', title: 'Translate', 'aria-label': 'Translate voice note'
    }, [
      el('option', { value: '', text: 'Original' }),
      ...VOICE_NOTE_LANGS.map((code) => el('option', { value: code, text: langName(code) }))
    ])
    const cancelBtn = el('button', { class: 'vv-cancel', type: 'button', text: 'Cancel', onclick: discardVoice })
    const sendBtn = el('button', {
      class: 'vv-send', type: 'button', text: 'Send',
      onclick: () => sendVoice(trSel, sendBtn, cancelBtn)
    })
    confbar.appendChild(playBtn)
    confbar.appendChild(timeEl)
    confbar.appendChild(trSel)
    confbar.appendChild(cancelBtn)
    confbar.appendChild(sendBtn)
    confbar.appendChild(confAudio)
    bar.style.display = 'none'
    confbar.style.display = 'flex'
  }

  function discardVoice () {
    if (confAudio) { try { confAudio.pause() } catch { /* detached */ } }
    confAudio = null
    confStatus = null
    // Nulling this is what aborts an in-flight translation: every step checks
    // pendingClip still matches, so Cancel stops the pipeline dead and nothing
    // half-translated is ever sent.
    pendingClip = null
    clear(confbar)
    confbar.classList.remove('busy')
    confbar.style.display = 'none'
    bar.style.display = ''
  }

  /**
   * Send the reviewed clip. 'Original' is the old path, untouched. A chosen
   * language runs STT → translate → cloned TTS and sends the resulting mp3
   * through the SAME voice-note path; any step failing leaves the original
   * clip sitting in the confirm bar, still sendable.
   */
  async function sendVoice (trSel, sendBtn, cancelBtn) {
    if (!pendingClip) return
    const lang = trSel?.value || ''
    if (!lang) {
      const clip = pendingClip
      discardVoice()
      sendAttachmentWithUI({ kind: 'voice', data: clip.dataURL, dur: clip.dur })
      return
    }
    const voiceId = db.profile().voiceId
    if (!voiceId) { ctx.toast('Create your voice in Settings first'); return }
    const clip = pendingClip

    /* Nothing is sent until all three steps finish — that ordering was already
     * right. What was wrong was the wait itself: Cancel was disabled and there
     * was no deadline, so a hung step left the bar frozen with no way out, and
     * the only label was "Translating…" squeezed into a pill that showed
     * "Tran…". Three network services run here; any of them can stall. */
    confbar.classList.add('busy')
    const sendLabel = sendBtn.textContent
    sendBtn.disabled = true
    trSel.disabled = true
    // Cancel stays LIVE. Being unable to abandon a stuck upload is the worst
    // state this bar can be in.
    cancelBtn.disabled = false

    let step = 'Transcription'
    const restore = () => {
      confbar.classList.remove('busy')
      sendBtn.textContent = sendLabel
      sendBtn.disabled = false
      cancelBtn.disabled = false
      trSel.disabled = false
      // Put the clock back, or the bar keeps reporting a step that has stopped.
      if (confStatus) confStatus.textContent = `0:00 / ${fmtClock(clip.dur)}`
    }
    /** The clip the user is waiting on. If they cancel or re-record, this
     *  stops matching and every later step becomes a no-op. */
    const stillWanted = () => mounted && pendingClip === clip

    /** Each step gets its own deadline, so one dead service cannot hold the
     *  note hostage. Generous, because a slow phone on 5G is not a failure. */
    const STEP_TIMEOUT_MS = 45_000
    const withDeadline = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT_MS))
    ])

    /* The step goes in the time slot, which has room for the whole word; the
     * capped Send pill just reads "Working". */
    const say = (label) => {
      if (!stillWanted()) return
      sendBtn.textContent = 'Working'
      if (confStatus) confStatus.textContent = label
    }

    try {
      say('Hearing…')
      const recorded = await (await fetch(clip.dataURL)).blob()
      const heard = await withDeadline(sttBlob(recorded), step)
      if (!stillWanted()) return
      if (!heard?.text) throw new Error('nothing heard')

      step = 'Translation'
      say('Translating…')
      const from = heard.lang ? String(heard.lang).slice(0, 2) : (db.profile().lang || null)
      const out = await withDeadline(translateText(heard.text, from, lang), step)
      if (!stillWanted()) return
      if (!out?.text) throw new Error('no translation')

      step = 'Voice generation'
      say('Voicing…')
      const spoken = await withDeadline(ttsClone(out.text, voiceId), step)
      if (!stillWanted()) return
      if (!spoken || !spoken.size) throw new Error('no audio')

      const dataURL = await blobToDataURL(spoken)
      const dur = await audioDuration(dataURL, clip.dur)
      // Last check before it leaves: only a fully voiced note is ever sent.
      if (!stillWanted()) return
      discardVoice()
      sendAttachmentWithUI({ kind: 'voice', data: dataURL, dur })
    } catch {
      if (!stillWanted()) return
      ctx.toast(`${step} failed — the original note is still ready to send`)
      restore()
    }
  }

  /* --------------------------------------------------------- dictation */
  /** Rewrite ONLY the text this dictation session produced; anything typed
   * before the session started stays untouched in front of it. */
  function setDictatedText (text) {
    const sep = dictBase && !/\s$/.test(dictBase) && text ? ' ' : ''
    input.value = dictBase + sep + (text || '')
    updatePreview()
    updateMic()
  }

  function setDictationUI (on) {
    field.classList.toggle('dicton', on)
    dictHint.style.display = on ? '' : 'none'
  }

  /** Offline fallback: the old Web Speech path. Keeps dictBase, so it can
   * take over an ElevenLabs session mid-flight without losing text. */
  function startWebSpeechDictation () {
    const rec = dictate(db.profile().lang, (text) => {
      setDictatedText(text)
    }, () => {
      dictating = null
      setDictationUI(false)
    })
    if (!rec) { ctx.toast('Dictation is not available on this device'); return }
    dictating = rec
    setDictationUI(true)
    ctx.toast('Listening — open Attach › Dictate again to stop')
  }

  /**
   * ElevenLabs dictation: MediaRecorder collects 4s slices; every boundary
   * sends the FULL accumulated take to sttBlob and rewrites the session's
   * text (whole-take passes self-correct earlier mishearings). Tap #2 stops,
   * runs one final pass and releases the mic. Any sttBlob failure mid-take
   * falls back to Web Speech so dictation still works offline.
   */
  async function startCloudDictation () {
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      ctx.toast(voiceError(e))
      return
    }
    if (!mounted || dictating) { stream.getTracks().forEach((t) => t.stop()); return }
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks = []
    let stopped = false
    let fellBack = false
    let pending = 0            // STT passes queued — coalesced, never stacked
    let sttChain = Promise.resolve()

    const release = () => stream.getTracks().forEach((t) => t.stop())

    const fallBackToWebSpeech = () => {
      if (fellBack || stopped || !mounted) return
      fellBack = true
      recorder.ondataavailable = null
      recorder.onstop = null
      try { recorder.stop() } catch { /* already stopped */ }
      release()
      dictating = null
      setDictationUI(false)
      startWebSpeechDictation()
    }

    /** Serialized whole-take transcription; at most one pass waiting. */
    const scheduleStt = () => {
      if (pending > 1) return sttChain
      pending++
      sttChain = sttChain.then(async () => {
        try {
          if (fellBack || !mounted || !chunks.length) return
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          const heard = await sttBlob(blob)
          if (fellBack || !mounted || dictating !== session) return
          if (typeof heard?.text === 'string') setDictatedText(heard.text.trim())
        } catch {
          if (stopped) ctx.toast('Could not transcribe — check your connection')
          else fallBackToWebSpeech()
        } finally {
          pending--
        }
      })
      return sttChain
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data)
      if (!stopped && !fellBack) scheduleStt()
    }
    recorder.onstop = async () => {
      release()
      if (fellBack) return
      await scheduleStt()      // final pass over the complete take
      if (dictating === session) dictating = null
      setDictationUI(false)
    }

    const session = {
      stop () {
        if (stopped) return
        stopped = true
        try { recorder.stop() } catch { release() }
      },
      abort () {               // unmount path — no final pass, just let go
        stopped = true
        fellBack = true
        recorder.ondataavailable = null
        recorder.onstop = null
        try { recorder.stop() } catch { /* already stopped */ }
        release()
      }
    }
    recorder.start(DICTATE_SLICE_MS)
    dictating = session
    setDictationUI(true)
    ctx.toast('Listening — open Attach › Dictate again to stop')
  }

  function toggleDictation () {
    if (dictating) {
      try { dictating.stop() } catch { /* already ended */ }
      return
    }
    dictBase = input.value
    if (navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined') {
      startCloudDictation()
    } else {
      startWebSpeechDictation()
    }
  }

  /* ---------------------------------------------------- event patching */
  function updateReactions (targetId) {
    const entry = msgEls.get(targetId)
    if (!entry) return
    const fresh = conn.store.list().find((x) => x.id === targetId)
    if (!fresh) return
    entry.message = fresh
    renderReacts(entry.wrap.querySelector('.reacts'), fresh.reactions)
  }

  function updateReadTicks () {
    for (const entry of msgEls.values()) {
      if (entry.message.from !== myId) continue
      entry.wrap.querySelector('.readRow')?.replaceWith(buildReadRow(entry.message))
    }
  }

  function updateSeen (id) {
    const entry = msgEls.get(id)
    if (!entry) return
    const cap = entry.wrap.querySelector('.cap')
    if (cap) cap.style.display = ''
  }

  /* ------------------------------------------------ incoming transfers */
  const rxPlaceholders = new Map()   // id -> element

  function showRxProgress (event) {
    let ph = rxPlaceholders.get(event.id)
    if (!ph) {
      const stick = nearBottom()
      const label = event.meta?.kind === 'voice' ? 'voice note'
        : event.meta?.kind === 'video' ? 'video'
        : event.meta?.kind === 'file' ? (event.meta.fileName || 'file') : 'photo'
      ph = el('div', { class: 'rxph' }, [
        el('span', { class: 'rxspin' }),
        el('span', { class: 'rxtext', text: `Receiving ${label}… 0%` })
      ])
      rxPlaceholders.set(event.id, ph)
      thread.appendChild(ph)
      if (stick) scrollBottom()
    }
    const pct = Math.round((event.progress || 0) * 100)
    const t = ph.querySelector('.rxtext')
    if (t) t.textContent = t.textContent.replace(/\d+%$/, `${pct}%`)
  }

  function clearRxProgress (id) {
    rxPlaceholders.get(id)?.remove()
    rxPlaceholders.delete(id)
  }

  /* ------------------------------------------------------ call overlay */
  let callOverlay = null
  let callTimer = null
  let callStartedAt = 0

  function closeCallOverlay () {
    if (callTimer) { clearInterval(callTimer); callTimer = null }
    callOverlay?.remove()
    callOverlay = null
  }

  function renderCall () {
    const call = conn.call
    closeCallOverlay()
    if (call.state === 'idle') return

    const kind = call.video ? 'Video call' : 'Voice call'
    const parts = []

    /* ONE TILE PER REMOTE PARTICIPANT.
     *
     * `call.remotes` is a Map of identity -> MediaStream, so 1:1 and group are
     * the same code path with a different count — a group call is not a mode
     * here, it is a longer map. The grid class carries the count so CSS can lay
     * out two people differently from six without this knowing how.
     *
     * A <video> element plays its own audio track, so video tiles deliberately
     * get no companion <audio>: that would play the same samples twice. */
    const remotes = [...(call.remotes?.entries() ?? [])]
    if (call.state === 'active' && remotes.length > 0) {
      if (call.video) {
        const grid = el('div', { class: `callgrid n${Math.min(remotes.length, 6)}` })
        for (const [identity, stream] of remotes) {
          /* BOTH playsinline SPELLINGS, as attribute AND property.
           *
           * The group grid arrived on one branch and the webkit-playsinline
           * fix on another, and the naive merge kept the grid while dropping
           * the second spelling — which on iOS means every remote tile hands
           * the call to the native fullscreen player. Same reasoning as
           * lib/video.js, which exists so these cannot drift apart again.
           *
           * videoEl() from that module is deliberately NOT reused here: it is
           * built for feed clips and sets muted, loop and preload. A muted
           * call tile is a call you cannot hear. */
          const tile = el('video', {
            class: 'callremote', autoplay: '', playsinline: '', 'webkit-playsinline': '',
          })
          tile.playsInline = true
          tile.srcObject = stream
          // Identity is the sender's user id; it is what the SFU knows them by
          // and the only stable handle we have for a tile.
          tile.dataset.identity = identity
          grid.appendChild(tile)
        }
        parts.push(grid)
        if (call.local) {
          const localV = el('video', { class: 'callpip', autoplay: '', playsinline: '', 'webkit-playsinline': '', muted: '' })
          localV.muted = true
          localV.srcObject = call.local
          parts.push(localV)
        }
      } else {
        for (const [identity, stream] of remotes) {
          const remoteA = el('audio', { autoplay: '' })
          remoteA.srcObject = stream
          remoteA.dataset.identity = identity
          parts.push(remoteA)
        }
      }
    }

    const timerEl = el('div', { class: 'calltime', text: '' })
    const face = call.video && call.state === 'active'
      ? null
      : el('div', { class: 'callface' }, [avatar(convo.peer || { name: convo.title }, 96)])

    const label = call.state === 'ringing-in' ? `Incoming ${kind.toLowerCase()}…`
      : call.state === 'ringing-out' ? 'Calling…'
      : call.state === 'connecting' ? 'Connecting…' : ''

    const actions = []
    if (call.state === 'ringing-in') {
      actions.push(
        el('button', { class: 'pill no big', type: 'button', text: 'Decline', onclick: () => conn.declineCall() }),
        el('button', {
          class: 'pill ok big',
          type: 'button',
          text: 'Accept',
          onclick: () => conn.acceptCall().catch((e) => ctx.toast(e.message || 'Permission needed'))
        })
      )
    } else {
      const muteBtn = el('button', {
        class: 'callmute', type: 'button', text: 'Mute',
        onclick () {
          const muted = conn.toggleMute()
          muteBtn.textContent = muted ? 'Unmute' : 'Mute'
          muteBtn.classList.toggle('on', muted)
        }
      })
      /* VIDEO IS OPT-IN, PER PARTICIPANT. A group call starts audio-only —
       * six cameras is the expensive case and rarely the wanted one — so this
       * is how someone turns theirs on, and it is theirs alone: it publishes
       * one more track and asks nothing of anybody else. */
      const camBtn = el('button', {
        class: 'callmute' + (call.videoOn ? ' on' : ''), type: 'button',
        text: call.videoOn ? 'Camera off' : 'Camera',
        onclick () {
          camBtn.disabled = true
          conn.toggleVideo()
            .then((on) => {
              camBtn.textContent = on ? 'Camera off' : 'Camera'
              camBtn.classList.toggle('on', on)
            })
            .catch((e) => ctx.toast(e.message || 'Camera permission needed'))
            .finally(() => { camBtn.disabled = false })
        }
      })
      actions.push(muteBtn, camBtn,
        el('button', { class: 'pill no big', type: 'button', text: 'End', onclick: () => conn.endCall() }))
    }

    callOverlay = el('div', { class: 'callov' + (call.video && call.state === 'active' ? ' video' : '') }, [
      ...parts,
      el('div', { class: 'callinfo' }, [
        face,
        el('b', { text: convo.title || 'Call' }),
        label ? el('span', { class: 'callst', text: label }) : timerEl
      ]),
      el('div', { class: 'callacts' }, actions)
    ])
    root.appendChild(callOverlay)

    if (call.state === 'active') {
      if (!callStartedAt) callStartedAt = Date.now()
      const fmt = () => {
        const s = Math.floor((Date.now() - callStartedAt) / 1000)
        timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      }
      fmt()
      callTimer = setInterval(fmt, 1000)
    } else if (call.state === 'idle') {
      callStartedAt = 0
    }
  }

  function onEvent (event) {
    if (!mounted) return
    switch (event.type) {
      case 'message': {
        /* An incoming message that DECRYPTED is the only honest proof the key
         * agrees again — the self-heal can repair a room without anything else
         * saying so. Clearing here is what stops the warning outliving the
         * fault it describes. `emit('message')` is the incoming path only, so
         * the user's own sends cannot clear it by accident. */
        if (roomUndecryptable) { roomUndecryptable = false; roomUndecryptableReason = null; renderList() }
        clearRxProgress(event.message?.id)
        /* The "Read messages aloud" switch wrote `settings.readAloud` and
         * nothing read it — the only working read-aloud was the manual
         * per-message item in the long-press sheet, which is not what the
         * toggle offers. This is the incoming path only, so it never reads the
         * user's own sends back to them. */
        if (db.settings().readAloud && event.message?.text) {
          speak(event.message.text, db.profile().lang)
        }
        const stick = nearBottom()
        appendMessage(event.message)
        rooms.markRead(roomId)
        if (stick) scrollBottom()
        else newChip.style.display = ''
        break
      }
      /* Re-agreement already ran and failed by the time this fires, so there is
       * nothing left to try automatically — the only remaining move is the
       * user's. Re-render rather than append: the warning belongs at the top of
       * the thread with the other system lines, not wherever we happen to be. */
      case 'undecryptable': {
        // 'wrong-key' is the stronger claim, so it may upgrade an existing
        // 'no-key' — never the other way round.
        const worse = event.reason === 'wrong-key' && roomUndecryptableReason !== 'wrong-key'
        if (!roomUndecryptable || worse) {
          roomUndecryptable = true
          roomUndecryptableReason = event.reason || roomUndecryptableReason || 'wrong-key'
          renderList()
        }
        break
      }
      /* The send threw and the store now says so. One row, rebuilt — the tick
       * becomes "Not delivered", which is what `buildReadRow` has always drawn
       * for an attachment and never had the chance to draw for text. */
      case 'sendfailed':
        refreshRow(event.id)
        break
      case 'history': {
        const stick = nearBottom()
        renderList()
        if (stick) scrollBottom()
        break
      }
      case 'edited':
        refreshRow(event.id)
        break
      case 'deleted':
      case 'expired':
        removeRow(event.id)
        break
      case 'typing':
        updateStatus()
        break
      /* This device ran out of storage and had to drop media from the saved
       * copy. It used to happen in complete silence — the tab kept showing
       * audio it had already dropped, and the user met "tap to load" on their
       * own voice note days later with no idea why. */
      case 'shed':
        ctx.toast(event.own
          ? 'Storage full — your own media was moved off this device. Tap to load it back.'
          : 'Storage full — older media was moved off this device. Tap to load it back.')
        break
      case 'read':
        updateReadTicks()
        break
      case 'reaction':
        updateReactions(event.payload?.target)
        break
      case 'seen':
        updateSeen(event.id)
        /* updateSeen only un-hides a .cap node, which the watching bubble does
         * not render — so a viewer who closed early left the sender's
         * countdown ticking on a photo that had already burned. The row has to
         * be rebuilt, exactly as 'viewing' does. */
        refreshRow(event.id)
        break
      /* They just opened a view-once of mine — swap that bubble for the live
       * countdown so the wait is something to watch rather than sit through. */
      case 'viewing':
        refreshRow(event.id)
        break
      /* Their name or picture arrived (or changed) over the handshake. */
      case 'peer':
        if (event.peer) convo.peer = event.peer
        who.querySelector('b').textContent = convo.title || convo.peer?.name || 'Chat'
        updateAvatar()
        break
      case 'peers':
        updateStatus()
        updateAvatar()
        break
      case 'locup':
        refreshRow(event.id)
        break
      case 'rxprogress':
        showRxProgress(event)
        break
      case 'rxdone':
        clearRxProgress(event.id)
        break
      case 'call':
        if (event.declined) ctx.toast(event.busy ? 'They are on another call' : 'Call declined')
        if (event.ended) ctx.toast('Call ended')
        // There is no peer-to-peer path left to quietly fall back to, so a
        // media failure has to be said out loud rather than left as a call that
        // never leaves "Connecting…".
        if (event.failed) ctx.toast(event.failed)
        if (conn.call.state === 'idle') callStartedAt = 0
        renderCall()
        break
    }
  }

  function onDb () {
    if (!mounted) return
    if (!db.convo(roomId)) { ctx.nav('#/chat'); return }
    updateToggles()
    updateStatus()
    updatePreview()
    updateTtlChip()
    refreshTranslations()
  }

  /* -------------------------------------------------------------- boot */
  const unsubConn = conn.on(onEvent)
  const unsubDb = db.subscribe(onDb)
  const unsubLobby = lobby.subscribe(updateStatus)

  db.setOpenRoom(roomId)
  rooms.markRead(roomId)
  updateAvatar()
  updateToggles()
  updateStatus()
  updateTtlChip()
  renderList()
  scrollBottom()
  later(scrollBottom, 80)
  // A call that kept running while the user was on another screen.
  if (conn.call.state !== 'idle') renderCall()
  // Warm the translation path the moment the chat opens, so the first live
  // preview and the first incoming translation are fast, not cold-started.
  warmup(db.profile().lang, convo.peer?.lang)

  /* ----------------------------------------------------------- cleanup */
  return function cleanup () {
    mounted = false
    db.setOpenRoom(null)
    if (earlyTimer) { clearInterval(earlyTimer); earlyTimer = null }
    window.removeEventListener('focus', onWindowFocus)
    rooms.typing(roomId, false)
    unsubConn()
    unsubDb()
    unsubLobby()
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const iv of countdowns) clearInterval(iv)
    countdowns.clear()
    // Live-location watches stop with the screen; the share message itself
    // stays live until Stop sharing (or its deadline) says otherwise.
    for (const share of liveShares.values()) {
      try { navigator.geolocation?.clearWatch?.(share.watchId) } catch { /* gone */ }
    }
    liveShares.clear()
    if (recInterval) clearInterval(recInterval)
    stopRecWave()
    if (recording) { try { recording.cancel() } catch { /* stopped */ } recording = null }
    if (confAudio) { try { confAudio.pause() } catch { /* detached */ } confAudio = null }
    pendingClip = null
    for (const stop of voiceStops) { try { stop() } catch { /* detached */ } }
    voiceStops.clear()
    // Countdown intervals outlive their rows otherwise, ticking against nodes
    // that are no longer on screen.
    for (const t of rowTimers) clearInterval(t)
    rowTimers.clear()
    if (dictating) { try { dictating.abort() } catch { /* ended */ } dictating = null }
    // The call itself lives at the rooms layer and keeps running; only the
    // overlay is torn down. Re-entering the thread rebuilds it.
    closeCallOverlay()
    // The photo editor mounts on <body>; leaving the thread cancels it.
    closePhotoEditor()
    root.classList.remove('v-chat')
  }
}
