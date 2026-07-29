/**
 * Spot Me — client for /api/voice (the ElevenLabs proxy). Speech-to-text,
 * cloned-voice TTS, and the one-per-profile voice clone lifecycle.
 *
 * Audio crosses the wire as base64 data URLs so every request stays plain
 * JSON — the serverless side rebuilds real blobs before talking to EL.
 * Every function throws an Error with a readable message on failure.
 */

/** Same-origin: the backend bridges the /api functions (vite proxies in dev). */
const API_BASE = ''

/* Cloning uploads ~0.5 MB and EL processes it — give slow ops more room. */
const CALL_TIMEOUT_MS = 30_000
const CLONE_TIMEOUT_MS = 60_000

export function blobToDataURL (blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('could not read the audio'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Recorders declare parameterised mimes — Android Chrome gives
 * "audio/webm;codecs=opus", iOS "audio/mp4;codecs=…" — so everything up to
 * ";base64," is the media type. Matching only an unparameterised type is what
 * made real phone recordings fail with "bad audio data".
 */
export function dataURLToBlob (dataURL) {
  const match = /^data:([^,]*?);base64,(.+)$/.exec(String(dataURL || ''))
  if (!match) throw new Error('bad audio data')
  const bin = atob(match[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: match[1] })
}

async function call (op, payload, timeoutMs = CALL_TIMEOUT_MS) {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}/api/voice?op=${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || json?.error) {
      throw new Error(json?.error || `voice ${op} failed (${res.status})`)
    }
    return json
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`voice ${op} timed out`)
    throw e
  } finally {
    clearTimeout(abortTimer)
  }
}

/** Transcribe a recorded clip → {text, lang} (lang is EL's language_code). */
export async function sttBlob (blob) {
  const audio = await blobToDataURL(blob)
  const { text, lang } = await call('stt', { audio })
  return { text, lang }
}

/** Speak text with a cloned voice → playable audio/mpeg Blob. */
export async function ttsClone (text, voiceId) {
  const { audio } = await call('tts', { text, voiceId }, CLONE_TIMEOUT_MS)
  if (!audio) throw new Error('no audio returned')
  return dataURLToBlob(audio)
}

/** Clone a voice from a recorded sample → the new ElevenLabs voiceId. */
export async function cloneVoice (blob, name) {
  const audio = await blobToDataURL(blob)
  const { voiceId } = await call('clone', { audio, name }, CLONE_TIMEOUT_MS)
  if (!voiceId) throw new Error('no voice id returned')
  return voiceId
}

/** Delete the cloned voice from ElevenLabs. Resolves true on success. */
export async function deleteClone (voiceId) {
  await call('unclone', { voiceId })
  return true
}
