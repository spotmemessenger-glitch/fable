/**
 * Spot Me — pending-knock relay (Vercel Node serverless function).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * reach.js's knock is pure P2P: the sender joins the recipient's inbox room
 * and waits for them to show up. That works as long as the SENDER stays
 * online long enough to catch the recipient coming online too. If the sender
 * closes the app (or their device dies) before that overlap happens, the
 * knock is gone — nothing was ever durable, because nothing but the two
 * devices ever held it.
 *
 * This function is that durable holding place. reach() calls STORE the same
 * knock payload here (best-effort, fire-and-forget) at the moment it also
 * tries P2P delivery. The recipient's device calls GET on boot and on regaining
 * focus; anything found is handed to the exact same code path a live P2P
 * knock uses, then ACKed (deleted) so it is not replayed. The sender does not
 * need to be present for either half of that.
 *
 * WHAT THE SERVER LEARNS — same disclosure as api/push.js
 *
 * It stores who is trying to reach whom, the room id/secret for that one
 * conversation, and up to 300 chars of the opening message — exactly what a
 * live P2P knock already carries, just held for longer. It still never sees
 * anything exchanged after the chat opens; ongoing messages stay P2P only.
 *
 * ---------------------------------------------------------------------------
 * ROUTES
 *
 *   GET  /api/knock?userId=<id>                       -> { knocks: [...] }
 *   POST /api/knock {action:'store', toId, knock}      -> { ok:true }
 *   POST /api/knock {action:'ack', userId, roomIds:[]}  -> { ok:true }
 *
 * Uses the SAME Upstash Redis project already configured for api/push.js
 * (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) — no new service, no
 * new credentials, no SDK.
 * ------------------------------------------------------------------------- */

const KNOCK_TTL_SECONDS = 30 * 24 * 60 * 60   // 30 days — long enough to survive a real absence
const MAX_PENDING_PER_USER = 100              // caps one inbox against spam-knocking
const MAX_TEXT_CHARS = 300
const MAX_ROOM_IDS_PER_ACK = 200
const MODES = new Set(['meet', 'nearby', 'bluetooth'])

/** Spot Me ids are hex from randomHex — anything else is not one. */
const isId = (value) => typeof value === 'string' && /^[a-f0-9]{4,64}$/i.test(value)
/** roomId/secret are stableHash hex, but keep this generous rather than brittle. */
/* The optional `<prefix>-` matters: reach.js builds room ids as
 * `dm-${stableHash(...)}` and `inbox-${stableHash(...)}`, and a hyphen is not a
 * hex digit. The old pattern therefore rejected EVERY direct-message knock with
 * 400 "invalid knock" — and `relayStore` posts through `safe()`, which swallows
 * the rejection, so the durable offline path for DMs had never once worked and
 * nothing said so. Group rooms use bare `randomHex(16)`, which still matches. */
const isToken = (value) => typeof value === 'string' && /^(?:[a-z]{1,8}-)?[a-f0-9]{4,128}$/i.test(value)

const inboxKey = (userId) => `knock:inbox:${userId}`
const dataKey = (roomId) => `knock:data:${roomId}`

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

/** One HTTP round trip for several commands — Upstash's REST pipeline endpoint. */
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

  const roomIds = await redis(['SMEMBERS', inboxKey(userId)])
  if (!Array.isArray(roomIds) || !roomIds.length) { send(res, 200, { knocks: [] }); return }

  const values = await redisPipeline(roomIds.map((roomId) => ['GET', dataKey(roomId)]))
  const knocks = []
  const stale = []
  roomIds.forEach((roomId, i) => {
    const raw = values[i]
    const parsed = typeof raw === 'string' ? safeJson(raw) : null
    if (parsed) knocks.push(parsed)
    else stale.push(roomId)   // expired or never written — the index outlived the data
  })
  // Self-heal the index rather than leaving dead members to re-check forever.
  if (stale.length) await redisPipeline(stale.map((roomId) => ['SREM', inboxKey(userId), roomId]))

  send(res, 200, { knocks })
}

async function handleStore (res, body) {
  const toId = body.toId
  const knock = body.knock || {}
  const roomId = knock.roomId
  const secret = knock.secret
  const fromId = knock.from?.id

  if (!isId(toId) || !isId(fromId) || !isToken(roomId) || !isToken(secret)) {
    send(res, 400, { error: 'invalid knock' })
    return
  }

  const count = await redis(['SCARD', inboxKey(toId)])
  if (typeof count === 'number' && count >= MAX_PENDING_PER_USER) {
    send(res, 429, { error: 'inbox full' })
    return
  }

  const record = {
    from: {
      id: fromId,
      name: String(knock.from?.name || 'Unknown').slice(0, 64),
      avatar: typeof knock.from?.avatar === 'string' ? knock.from.avatar.slice(0, 200_000) : null,
      lang: String(knock.from?.lang || 'en').slice(0, 16)
    },
    roomId,
    secret,
    text: String(knock.text || '').slice(0, MAX_TEXT_CHARS),
    mode: MODES.has(knock.mode) ? knock.mode : 'meet',
    /* THE RELAY MUST NOT DOWNGRADE THE ROOM.
     *
     * This record is an allowlist rebuild, not a passthrough, so any field not
     * named here is dropped. e2eVersion and senderKey were being dropped —
     * which meant every knock delivered by the relay (the offline path: sender
     * goes away before the recipient comes online) arrived without the public
     * key needed to agree a v2 key, and receiveKnock silently opened an e2e_v1
     * room. P2P knocks were v2, relayed ones were not, and nothing said so.
     *
     * `senderKey` is bounded and shape-checked because it lands in a public
     * inbox: a raw X25519/P-256 key is 32 or 65 bytes, so 256 base64 chars is
     * already generous. It is NOT trusted — the recipient's own agreement
     * either succeeds against it or the room is recorded as downgraded. */
    e2eVersion: knock.e2eVersion === 'e2e_v2' ? 'e2e_v2' : 'e2e_v1',
    senderKey: typeof knock.senderKey === 'string' && /^[A-Za-z0-9+/]{1,256}={0,2}$/.test(knock.senderKey)
      ? knock.senderKey
      : null,
    ts: Date.now()
  }

  await redisPipeline([
    ['SET', dataKey(roomId), JSON.stringify(record), 'EX', String(KNOCK_TTL_SECONDS)],
    ['SADD', inboxKey(toId), roomId]
  ])
  send(res, 200, { ok: true })
}

async function handleAck (res, body) {
  const userId = body.userId
  const roomIds = Array.isArray(body.roomIds) ? body.roomIds.slice(0, MAX_ROOM_IDS_PER_ACK) : []
  if (!isId(userId) || !roomIds.every(isToken)) { send(res, 400, { error: 'invalid ack' }); return }
  if (!roomIds.length) { send(res, 200, { ok: true }); return }

  const commands = roomIds.flatMap((roomId) => [
    ['SREM', inboxKey(userId), roomId],
    ['DEL', dataKey(roomId)]
  ])
  await redisPipeline(commands)
  send(res, 200, { ok: true })
}

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  try {
    if (req.method === 'GET') { await handleGet(res, req.query?.userId); return }

    if (req.method === 'POST') {
      const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
      if (body.action === 'store') { await handleStore(res, body); return }
      if (body.action === 'ack') { await handleAck(res, body); return }
      send(res, 400, { error: 'unknown action' })
      return
    }

    send(res, 405, { error: 'method not allowed' })
  } catch (error) {
    send(res, 500, { error: error?.message || 'server error' })
  }
}
