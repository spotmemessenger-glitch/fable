// The same gate /api/knock and /api/translate use.
import { verifyAccessToken } from './_auth.js'
/**
 * Spot Me — native presence/invite relay (Vercel Node serverless function).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Autobase has no equivalent of "reach a Spot Me id I don't share a room
 * with yet" — a room is a specific cryptographic object two peers already
 * agree on, and Hyperswarm only finds peers who already announce the SAME
 * discovery key. Something has to carry the very first "here is a room key,
 * come join" message out of band, exactly the job api/knock.js does for the
 * web app's Trystero rooms. This is that same job, for native.
 *
 * THE TWO-STEP HANDSHAKE THIS CARRIES
 *
 * Autobase rooms have writers, not just readers — unlike a Trystero room,
 * holding the room key only grants READ access (core/room.js: "Joining is
 * read-only"). So reaching someone for the first time is two envelopes, not
 * one:
 *
 *   1. 'invite'    sender -> recipient: "here's a room key, join me"
 *   2. 'writerkey' recipient -> sender: "I joined read-only, here's my
 *                  writer key — invite() me so I can post"
 *
 * Both directions use the SAME generic per-user mailbox below; only the
 * envelope's `kind` differs. A future presence-ping (nearby/online) can
 * reuse this same mailbox with another `kind` rather than a new endpoint.
 *
 * ---------------------------------------------------------------------------
 * ROUTES
 *
 *   GET  /api/presence?userId=<id>                          -> { envelopes: [...] }
 *   POST /api/presence {action:'send', toId, envelope}       -> { ok:true }
 *   POST /api/presence {action:'ack', userId, envelopeIds:[]} -> { ok:true }
 *
 * Same Upstash Redis as api/knock.js and api/push.js — no new service, no
 * new credentials, no SDK.
 * ------------------------------------------------------------------------- */

const ENVELOPE_TTL_SECONDS = 30 * 24 * 60 * 60   // 30 days, same reasoning as api/knock.js
const MAX_PENDING_PER_USER = 200
const MAX_TEXT_CHARS = 300
const MAX_IDS_PER_ACK = 200
const KINDS = new Set(['invite', 'writerkey'])

/** Spot Me ids are hex from randomHex — anything else is not one. */
const isId = (value) => typeof value === 'string' && /^[a-f0-9]{4,64}$/i.test(value)
/** roomKey/writerKey are Autobase/Hypercore public keys — 64 hex chars, but
 *  kept generous like api/knock.js's isToken rather than brittle on length. */
const isKey = (value) => typeof value === 'string' && /^[a-f0-9]{4,128}$/i.test(value)
const isEnvelopeId = (value) => typeof value === 'string' && /^[a-f0-9]{8,128}$/i.test(value)

const inboxKey = (userId) => `presence:inbox:${userId}`
const envKey = (envelopeId) => `presence:env:${envelopeId}`

async function redis (command) {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    })
    if (!response.ok) return null
    const json = await response.json().catch(() => null)
    return json?.result ?? null
  } catch { return null }
}

async function redisPipeline (commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token || !commands.length) return []
  try {
    const response = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    })
    if (!response.ok) return []
    const json = await response.json().catch(() => null)
    return Array.isArray(json) ? json.map((entry) => entry?.result ?? null) : []
  } catch { return [] }
}

const safeJson = (text) => { try { return JSON.parse(text) } catch { return null } }

function send (res, status, body) {
  res.status(status)
  res.json(body)
}

async function handleGet (res, userId) {
  if (!isId(userId)) { send(res, 400, { error: 'invalid userId' }); return }

  const envelopeIds = await redis(['SMEMBERS', inboxKey(userId)])
  if (!Array.isArray(envelopeIds) || !envelopeIds.length) { send(res, 200, { envelopes: [] }); return }

  const values = await redisPipeline(envelopeIds.map((id) => ['GET', envKey(id)]))
  const envelopes = []
  const stale = []
  envelopeIds.forEach((id, i) => {
    const raw = values[i]
    const parsed = typeof raw === 'string' ? safeJson(raw) : null
    if (parsed) envelopes.push(parsed)
    else stale.push(id)
  })
  if (stale.length) await redisPipeline(stale.map((id) => ['SREM', inboxKey(userId), id]))

  send(res, 200, { envelopes })
}

async function handleSend (res, body) {
  const toId = body.toId
  const envelope = body.envelope || {}
  const envelopeId = envelope.id
  const fromId = envelope.fromId

  if (!isId(toId) || !isId(fromId) || !isEnvelopeId(envelopeId) || !KINDS.has(envelope.kind)) {
    send(res, 400, { error: 'invalid envelope' })
    return
  }
  if (envelope.kind === 'invite' && !isKey(envelope.roomKey)) {
    send(res, 400, { error: 'invalid roomKey' })
    return
  }
  if (envelope.kind === 'writerkey' && (!isKey(envelope.roomKey) || !isKey(envelope.writerKey))) {
    send(res, 400, { error: 'invalid writerkey envelope' })
    return
  }

  const count = await redis(['SCARD', inboxKey(toId)])
  if (typeof count === 'number' && count >= MAX_PENDING_PER_USER) {
    send(res, 429, { error: 'inbox full' })
    return
  }

  const record = {
    id: envelopeId,
    kind: envelope.kind,
    fromId,
    fromName: String(envelope.fromName || 'Unknown').slice(0, 64),
    fromAvatar: typeof envelope.fromAvatar === 'string' ? envelope.fromAvatar.slice(0, 200_000) : null,
    fromLang: String(envelope.fromLang || 'en').slice(0, 16),
    roomKey: envelope.roomKey,
    writerKey: envelope.writerKey || null,
    text: String(envelope.text || '').slice(0, MAX_TEXT_CHARS),
    ts: Date.now()
  }

  await redisPipeline([
    ['SET', envKey(envelopeId), JSON.stringify(record), 'EX', String(ENVELOPE_TTL_SECONDS)],
    ['SADD', inboxKey(toId), envelopeId]
  ])
  send(res, 200, { ok: true })
}

async function handleAck (res, body) {
  const userId = body.userId
  const envelopeIds = Array.isArray(body.envelopeIds) ? body.envelopeIds.slice(0, MAX_IDS_PER_ACK) : []
  if (!isId(userId) || !envelopeIds.every(isEnvelopeId)) { send(res, 400, { error: 'invalid ack' }); return }
  if (!envelopeIds.length) { send(res, 200, { ok: true }); return }

  const commands = envelopeIds.flatMap((id) => [
    ['SREM', inboxKey(userId), id],
    ['DEL', envKey(id)]
  ])
  await redisPipeline(commands)
  send(res, 200, { ok: true })
}

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  /* Same hole `/api/knock` had, same fix. This endpoint hands back `roomKey`
   * and `writerKey`, and `GET ?userId=<anyone>` answered for any id a caller
   * named — ids the username search gives out for free. `_auth.js` is the gate
   * that already existed for it. */
  const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const claims = verifyAccessToken(bearer)
  if (!claims?.sub) { send(res, 401, { error: 'unauthorized' }); return }

  try {
    // The caller's own id, never a parameter they chose.
    if (req.method === 'GET') { await handleGet(res, claims.sub); return }

    if (req.method === 'POST') {
      const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
      if (body.action === 'send') { await handleSend(res, { ...body, fromId: claims.sub }); return }
      if (body.action === 'ack') { await handleAck(res, { ...body, userId: claims.sub }); return }
      send(res, 400, { error: 'unknown action' })
      return
    }

    send(res, 405, { error: 'method not allowed' })
  } catch (error) {
    // Never relay the raw message — it names internals to the caller.
    send(res, 500, { error: 'server error' })
  }
}
