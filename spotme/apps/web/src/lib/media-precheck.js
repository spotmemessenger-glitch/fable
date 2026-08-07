/**
 * Spot Me — refuse a doomed attachment BEFORE it starts, with real numbers.
 *
 * WHY THIS EXISTS. A chat video was accepted, chunked, and pushed 128 KB at a
 * time through the socket for minutes, and then failed — leaving "That transfer
 * did not complete — try again" and no way to know that trying again would fail
 * the same way. Every fact needed to refuse it was available in the first
 * millisecond: the file's size, and the device's own storage numbers.
 *
 * THE MESSAGE CARRIES THE NUMBERS. "That file is too large" tells the reader
 * nothing they can act on — too large compared to what? Every refusal here
 * names the actual size, the actual limit, and the actual duration when we
 * could read one. A limit the reader can see is a limit they can work with.
 *
 * NOTHING HERE BLOCKS ON THE NETWORK, and nothing here throws: an
 * unreadable duration is not grounds to refuse a file, so it degrades to
 * checking what it could measure.
 */

/** Chat attachments move slice-by-slice over the socket; past this it is not a
 *  transfer, it is an outage. Matches the durability the transport can promise. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** Long clips are the ones that fail after the longest wait. */
export const MAX_VIDEO_SECONDS = 300

const MB = (n) => (n / 1048576).toFixed(1)
const mmss = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`

/**
 * Read a video's duration WITHOUT decoding the whole clip.
 *
 * `preload: 'metadata'` and a timeout, because a container this browser cannot
 * decode never fires `loadedmetadata` and would otherwise hang the send. An
 * unknown duration resolves to null and the caller judges on size alone —
 * refusing a file because we could not measure it would reject exactly the
 * formats least likely to be at fault.
 */
export function videoDuration (file, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let url = null
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (url) { try { URL.revokeObjectURL(url) } catch { /* already gone */ } }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      const el = document.createElement('video')
      el.preload = 'metadata'
      el.muted = true
      url = URL.createObjectURL(file)
      el.addEventListener('loadedmetadata', () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null), { once: true })
      el.addEventListener('error', () => finish(null), { once: true })
      el.src = url
    } catch { finish(null) }
  })
}

/**
 * Decide whether this file can be sent, before a single byte moves.
 *
 * Returns `{ ok: true, bytes, seconds }` or `{ ok: false, reason, message }`.
 * `message` is written for the person holding the phone and always contains the
 * measured numbers.
 */
export async function precheckAttachment (file, { maxBytes = MAX_ATTACHMENT_BYTES, maxSeconds = MAX_VIDEO_SECONDS } = {}) {
  if (!file) return { ok: false, reason: 'no-file', message: 'No file was chosen.' }

  const bytes = Number(file.size) || 0
  const isVideo = String(file.type || '').startsWith('video/') ||
    /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name || '')

  if (bytes === 0) {
    return { ok: false, reason: 'empty', message: 'That file is empty — it may still be downloading from iCloud.' }
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      bytes,
      message: `That file is ${MB(bytes)} MB. The limit for a chat attachment is ${MB(maxBytes)} MB — trim it, or send it at a lower quality.`
    }
  }

  let seconds = null
  if (isVideo) {
    seconds = await videoDuration(file)
    if (seconds !== null && seconds > maxSeconds) {
      return {
        ok: false,
        reason: 'too-long',
        bytes,
        seconds,
        message: `That video is ${mmss(seconds)}. The limit is ${mmss(maxSeconds)} — trim it and send the part you want.`
      }
    }
  }

  return { ok: true, bytes, seconds }
}
