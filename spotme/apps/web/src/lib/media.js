/**
 * Spot Me — media helpers: images, voice notes, files, location.
 *
 * Everything is serialised to data URLs and travels as JSON over the data
 * channel — the transport chunks large payloads internally. Wasteful next to raw
 * binary (+33%), but it removes an API ambiguity and keeps the store/persist
 * path uniform. Attachments are size-capped instead.
 */

export const IMAGE_MAX_EDGE = 1280
export const IMAGE_QUALITY = 0.8
/** Photo-editor flatten presets: standard (default) vs the HD toggle. */
export const PHOTO_STD = { edge: 1280, q: 0.82 }
export const PHOTO_HD = { edge: 2048, q: 0.9 }
/**
 * File size ceiling — now conditional, because the reason for it moved.
 *
 * 2.5 MB was "what keeps WebRTC and localStorage happy", and localStorage was
 * the binding half: a data URL is ~1.33x the file, against a 5-10 MB quota
 * shared with the entire conversation. Media now persists as Blobs in
 * IndexedDB (lib/blobstore.js), which is bounded by a share of free disk, so
 * that half of the constraint is gone.
 *
 * It is NOT raised unconditionally. Safari private mode and locked-down
 * WebViews refuse IndexedDB, and store.js correctly falls back to data URLs in
 * localStorage there — handing those devices a 25 MB file would put them
 * straight into the quota-shedding ladder, which is exactly the "your voice
 * note vanished" experience this work exists to end. So the cap follows the
 * storage that is actually available.
 *
 * Videos are unaffected: they were already on the chunked binary path at
 * VIDEO_CAP_BYTES and never consulted this number.
 */
const FILE_CAP_DURABLE = 25_000_000        // IndexedDB present
const FILE_CAP_FALLBACK = 2_500_000        // localStorage only — unchanged

export const FILE_CAP_BYTES = (() => {
  try {
    return (typeof indexedDB !== 'undefined' && indexedDB !== null)
      ? FILE_CAP_DURABLE
      : FILE_CAP_FALLBACK
  } catch {
    return FILE_CAP_FALLBACK
  }
})()
export const VIDEO_CAP_BYTES = 40_000_000  // videos ride the chunked binary path; bigger waits for native streaming
export const VOICE_MAX_SECS = 60

/**
 * Avatars are never drawn larger than 96 CSS px, so 256 covers a 2x screen
 * with room to spare. They also ride the room handshake now, and a 1024px
 * portrait is a third of a megabyte re-sent on every reconnect — most of a
 * mobile-data conversation spent on a picture nobody sees at that size.
 */
export const AVATAR_EDGE = 256
export const AVATAR_QUALITY = 0.85

/**
 * Re-encode an existing data URL smaller. Used to heal avatars captured
 * before the cap above existed, so old profiles do not keep paying for them.
 */
export function shrinkDataURL (dataURL, maxEdge = AVATAR_EDGE, quality = AVATAR_QUALITY) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    // On failure keep the original: a heavy avatar beats a lost one.
    img.onerror = () => resolve(dataURL)
    img.src = dataURL
  })
}

/** Compress a picked image to a bounded JPEG data URL. */
export function compressImage (file, maxEdge = IMAGE_MAX_EDGE, quality = IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve({
        dataURL: canvas.toDataURL('image/jpeg', quality),
        width: canvas.width,
        height: canvas.height
      })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')) }
    img.src = url
  })
}

/**
 * The blurred stand-in for a private photo, made ON THE SENDER'S DEVICE.
 *
 * The masked bubble used to be the real photo behind `filter: blur(22px)`. A
 * CSS filter is a rendering instruction — the pixels are untouched, so one
 * devtools line, or simply unticking the filter, recovered the original before
 * it was ever opened, and no `seen` was sent so the sender was never told.
 *
 * 16 pixels on the long edge at quality 0.4 is a few hundred bytes of colour
 * smear: enough for the mask to feel like it belongs to the photo, far too
 * little to reconstruct anything. The detail is destroyed before transmission,
 * which is the only place destroying it means anything.
 */
export const MASK_EDGE = 16

export function maskDataURL (dataURL, maxEdge = MASK_EDGE) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.4))
    }
    // No mask is fine — the bubble falls back to grain and sparkles. Sending
    // the real photo as its own mask is what must never happen.
    img.onerror = () => resolve(null)
    img.src = dataURL
  })
}

/** Read any file as a data URL, enforcing the size cap. */
export function fileToDataURL (file, cap = FILE_CAP_BYTES) {
  return new Promise((resolve, reject) => {
    if (file.size > cap) {
      // "the P2P cap" was wrong twice over: the app has been server-backed
      // since the transport migration, and this limit is now a property of
      // THIS device's storage — 25 MB with IndexedDB, 2.5 MB without.
      reject(new Error(cap === VIDEO_CAP_BYTES
        ? "Videos over 40 MB arrive with the native app's streaming transfer"
        : `File is ${(file.size / 1e6).toFixed(1)} MB — the limit on this device is ${(cap / 1e6).toFixed(1)} MB`))
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve({ dataURL: reader.result, name: file.name, size: file.size })
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/**
 * Record a voice note. Returns { stop, cancel, stream } — stop resolves with
 * the clip; stream is the live MediaStream so callers can drive a waveform.
 * iOS Safari records audio/mp4; Chrome records audio/webm. We keep whichever
 * the device produced; <audio> on the receiving side plays both.
 */
export async function recordVoice () {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
  /* Speech, not music. With no bitrate set the browser picks ~128 kbps, and a
   * measured recording came out at 16.2 kB/s — so a note crossed the 128 KiB
   * transport slice at EIGHT SECONDS, and nine 30-second notes filled the
   * localStorage quota, after which the store silently sheds the sender's own
   * audio. 24 kbps is the range voice messengers actually use: it cuts every
   * note 5-6x, moves the slice threshold to ~45s, and takes a 30s note on 3G
   * from 23s to about 4s. Browsers that do not support the hint ignore it. */
  const recorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    audioBitsPerSecond: 24000
  })
  const chunks = []
  const startedAt = Date.now()
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.start()

  const finish = () => new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      const reader = new FileReader()
      reader.onload = () => resolve({
        dataURL: reader.result,
        dur: Math.round((Date.now() - startedAt) / 1000),
        size: blob.size
      })
      reader.readAsDataURL(blob)
    }
    recorder.stop()
  })

  return {
    stop: finish,
    cancel () {
      recorder.onstop = null
      try { recorder.stop() } catch { /* already stopped */ }
      stream.getTracks().forEach((t) => t.stop())
    },
    stream
  }
}

/* ------------------------------------------------- leaving the app with it */

const EXT = {
  jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp',
  mpeg: 'mp3', mp3: 'mp3', webm: 'webm', ogg: 'ogg', wav: 'wav',
  mp4: 'mp4', quicktime: 'mov', pdf: 'pdf', plain: 'txt'
}

/** "data:audio/webm;codecs=opus;base64,…" → Blob, parameters and all. */
export function dataURLToBlob (dataURL) {
  const match = /^data:([^,]*?);base64,(.+)$/.exec(String(dataURL || ''))
  if (!match) return null
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: match[1] })
}

/** A File the OS share sheet and the download link can both take. */
export function fileFromDataURL (dataURL, baseName) {
  const blob = dataURLToBlob(dataURL)
  if (!blob) return null
  const subtype = (blob.type.split('/')[1] || '').split(';')[0].toLowerCase()
  const name = `${baseName}.${EXT[subtype] || subtype || 'bin'}`
  return new File([blob], name, { type: blob.type.split(';')[0] || 'application/octet-stream' })
}

/** Save to the device. Returns false when the browser refuses the download. */
export function downloadFile (file) {
  if (!file) return false
  try {
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return true
  } catch { return false }
}

/**
 * Hand something to the OS share sheet (WhatsApp, Mail, Files…).
 * Returns 'shared' | 'cancelled' | 'unsupported' — the caller decides what to
 * do instead, because file sharing exists on phones but often not on desktop.
 */
export async function shareOut ({ text, title, file, files }) {
  if (typeof navigator === 'undefined' || !navigator.share) return 'unsupported'
  const payload = {}
  if (title) payload.title = title
  if (text) payload.text = text
  const batch = (files && files.length ? files : (file ? [file] : [])).filter(Boolean)
  if (batch.length) {
    if (!navigator.canShare?.({ files: batch })) return 'unsupported'
    payload.files = batch
  }
  try {
    await navigator.share(payload)
    return 'shared'
  } catch (e) {
    // The user dismissing the sheet is not a failure worth reporting.
    return e?.name === 'AbortError' ? 'cancelled' : 'unsupported'
  }
}

/** One geolocation fix for location sharing. */
export function currentLocation () {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('no geolocation')); return }
    navigator.geolocation.getCurrentPosition(
      (fix) => resolve({ lat: fix.coords.latitude, lon: fix.coords.longitude }),
      () => reject(new Error('location denied')),
      { enableHighAccuracy: true, timeout: 10_000 }
    )
  })
}

/** OpenStreetMap link for a shared location — works without any API key. */
export function mapLink (lat, lon) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`
}
