/**
 * Spot Me — ElevenLabs voice proxy. The API key lives in env vars only,
 * never in the client bundle.
 *
 * POST /api/voice?op=stt      {audio: dataURL}         → {text, lang}
 * POST /api/voice?op=tts      {text, voiceId}          → {audio: mp3 dataURL}
 * POST /api/voice?op=clone    {audio: dataURL, name}   → {voiceId}
 * POST /api/voice?op=unclone  {voiceId}                → {ok: true}
 *
 * Every request/response body is JSON; audio crosses as base64 data URLs —
 * the same uniform JSON-transport choice the app makes everywhere else.
 * On ElevenLabs failures we pass through their status code and body text
 * so the client (and Vercel logs) can see exactly what was rejected.
 */
const EL_BASE = 'https://api.elevenlabs.io/v1'
const MAX_AUDIO_CHARS = 8_000_000   // ~6 MB decoded; fail fast before hitting EL
const MAX_TTS_CHARS = 2500
const VOICE_ID_RE = /^[A-Za-z0-9]{8,64}$/

function elHeaders () {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured')
  return { 'xi-api-key': key }
}

/**
 * data:audio/webm;codecs=opus;base64,… → Blob keeping the declared mime.
 * Phone recorders always append codec parameters, so the media type is
 * everything before ";base64," — anchoring on an unparameterised type
 * rejected every real recording.
 */
function audioBlob (dataURL) {
  if (typeof dataURL !== 'string' || dataURL.length > MAX_AUDIO_CHARS) {
    throw new Error('audio missing or too large')
  }
  const match = /^data:([^,]*?);base64,(.+)$/.exec(dataURL)
  if (!match) throw new Error('audio must be a base64 data URL')
  return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] })
}

/** EL wants a filename on the multipart part; give it the right extension. */
function audioName (blob) {
  const type = String(blob.type || '')
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'audio.m4a'
  if (type.includes('ogg')) return 'audio.ogg'
  if (type.includes('mpeg') || type.includes('mp3')) return 'audio.mp3'
  if (type.includes('wav')) return 'audio.wav'
  return 'audio.webm'
}

/** Relay an ElevenLabs error verbatim: their status code + body text. */
async function elFail (res, op, upstream) {
  const text = await upstream.text()
  res.status(upstream.status).json({ error: `elevenlabs ${op} ${upstream.status}: ${text}` })
}

async function stt (body, res) {
  const form = new FormData()
  form.append('model_id', 'scribe_v1')
  /* Fixed filename, real mime from the dataURL: EL sniffs content but
     wants a name on the multipart file part. */
  const clip = audioBlob(body?.audio)
  form.append('file', clip, audioName(clip))
  const upstream = await fetch(`${EL_BASE}/speech-to-text`, {
    method: 'POST', headers: elHeaders(), body: form
  })
  if (!upstream.ok) { await elFail(res, 'stt', upstream); return }
  const json = await upstream.json()
  res.status(200).json({ text: json.text || '', lang: json.language_code || null })
}

async function tts (body, res) {
  const text = typeof body?.text === 'string' ? body.text.slice(0, MAX_TTS_CHARS) : ''
  const voiceId = typeof body?.voiceId === 'string' ? body.voiceId : ''
  if (!text || !VOICE_ID_RE.test(voiceId)) {
    res.status(400).json({ error: 'need text and voiceId' })
    return
  }
  /* eleven_v3 is the most expressive model but not every voice/plan has it
     enabled — one retry on the battle-tested multilingual v2 keeps this
     endpoint dead-end free. */
  let upstream = null
  for (const modelId of ['eleven_v3', 'eleven_multilingual_v2']) {
    upstream = await fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { ...elHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId })
    })
    if (upstream.ok) {
      const audio = Buffer.from(await upstream.arrayBuffer()).toString('base64')
      res.status(200).json({ audio: 'data:audio/mpeg;base64,' + audio })
      return
    }
  }
  await elFail(res, 'tts', upstream)
}

async function clone (body, res) {
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 96) : ''
  if (!name) { res.status(400).json({ error: 'need name' }); return }
  const form = new FormData()
  form.append('name', name)
  const sample = audioBlob(body?.audio)
  form.append('files', sample, audioName(sample).replace('audio.', 'sample.'))
  const upstream = await fetch(`${EL_BASE}/voices/add`, {
    method: 'POST', headers: elHeaders(), body: form
  })
  if (!upstream.ok) { await elFail(res, 'clone', upstream); return }
  const json = await upstream.json()
  if (!json?.voice_id) { res.status(502).json({ error: 'clone returned no voice_id' }); return }
  res.status(200).json({ voiceId: json.voice_id })
}

async function unclone (body, res) {
  const voiceId = typeof body?.voiceId === 'string' ? body.voiceId : ''
  if (!VOICE_ID_RE.test(voiceId)) { res.status(400).json({ error: 'need voiceId' }); return }
  const upstream = await fetch(`${EL_BASE}/voices/${voiceId}`, {
    method: 'DELETE', headers: elHeaders()
  })
  if (!upstream.ok) { await elFail(res, 'unclone', upstream); return }
  res.status(200).json({ ok: true })
}

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }

  /* req.query.op can be undefined in this deploy — fall back to the raw URL. */
  let op = req.query?.op
  if (!op && req.url) {
    try { op = new URL(req.url, 'http://x').searchParams.get('op') } catch { /* no op */ }
  }

  const ops = { stt, tts, clone, unclone }
  if (!ops[op]) { res.status(400).json({ error: 'unknown op — use stt|tts|clone|unclone' }); return }

  try {
    await ops[op](body, res)
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
