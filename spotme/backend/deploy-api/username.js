/**
 * Spot Me — username registry (Vercel Node serverless function).
 *
 * One PUBLIC Vercel Blob store maps `usernames/<name>.json` to a small JSON
 * record `{username, id, name, ts}`. No SDK: plain fetch against the Blob
 * REST API authorised by the project's BLOB_READ_WRITE_TOKEN env var.
 *
 *   GET  /api/username?check=<name>   -> { available: boolean }
 *   GET  /api/username?q=<prefix>     -> { results: [{username,id,name}] } (max 8)
 *   POST /api/username {username,id,name,secret} -> 200 {ok:true} | 409 {error:'taken'}
 *   POST /api/username {op:'release',username,secret} -> 200 {ok:true}
 *
 * Release exists because a claim outlives the device that made it: clearing
 * site data mints a new profile id, leaving the old record pointing at a peer
 * nobody can reach — the name is burnt and search sends people into a void.
 *
 * It is gated by a secret the claimer generates and keeps locally; only its
 * SHA-256 is stored, so reading the record (the blob store is public) does not
 * let you release someone else's name. The profile id cannot serve as that
 * gate: search hands it to every caller by design.
 */

import { createHash } from 'node:crypto'

const BLOB_API = 'https://blob.vercel-storage.com'
const USERNAME_RE = /^[a-z0-9_]{3,16}$/
const PREFIX_RE = /^[a-z0-9_]{1,16}$/
const MAX_RESULTS = 8
const LIST_LIMIT = 10
const MAX_NAME_CHARS = 64
const MAX_ID_CHARS = 64

const authHeaders = () => ({
  authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
})

const normalize = (value) => String(value ?? '').trim().toLowerCase()

const pathnameFor = (name) => `usernames/${name}.json`

async function listBlobs (prefix, limit = LIST_LIMIT) {
  const url = `${BLOB_API}/?prefix=${encodeURIComponent(prefix)}&limit=${limit}`
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error(`blob list failed (${res.status})`)
  const data = await res.json()
  return Array.isArray(data.blobs) ? data.blobs : []
}

async function usernameExists (name) {
  const blobs = await listBlobs(pathnameFor(name))
  return blobs.some((blob) => blob.pathname === pathnameFor(name))
}

/** Reads one public blob record; null on any failure so one bad blob never kills a search. */
async function readRecord (url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function send (res, status, body) {
  res.status(status)
  if (status === 204) { res.end(); return }
  res.json(body)
}

async function handleCheck (res, raw) {
  const name = normalize(raw)
  if (!USERNAME_RE.test(name)) { send(res, 400, { error: 'invalid username' }); return }
  const exists = await usernameExists(name)
  send(res, 200, { available: !exists })
}

async function handleSearch (res, raw) {
  const prefix = normalize(raw)
  if (!PREFIX_RE.test(prefix)) { send(res, 400, { error: 'invalid query' }); return }
  const blobs = (await listBlobs(`usernames/${prefix}`))
    .filter((blob) => typeof blob.pathname === 'string' && blob.pathname.endsWith('.json'))
    .slice(0, MAX_RESULTS)
  const records = await Promise.all(blobs.map((blob) => readRecord(blob.url)))
  const results = records
    .filter((record) => record && typeof record.username === 'string')
    .map((record) => ({ username: record.username, id: record.id, name: record.name }))
  send(res, 200, { results })
}

const hash = (secret) => createHash('sha256').update(String(secret)).digest('hex')

/** The record and its blob URL, or null when the name is free. */
async function findRecord (name) {
  const blob = (await listBlobs(pathnameFor(name)))
    .find((entry) => entry.pathname === pathnameFor(name))
  if (!blob) return null
  const record = await readRecord(blob.url)
  return record ? { record, url: blob.url } : null
}

/**
 * Give a name back to the pool.
 *
 * Records written before secrets existed fall back to matching the profile id.
 * That is a weaker gate — the id is public via search — but it only applies to
 * the handful of names claimed before this shipped, and refusing them outright
 * would strand those names forever.
 */
async function handleRelease (res, body) {
  const username = normalize(body.username)
  if (!USERNAME_RE.test(username)) { send(res, 400, { error: 'invalid username' }); return }

  const found = await findRecord(username)
  if (!found) { send(res, 200, { ok: true, already: true }); return }

  const secret = String(body.secret ?? '')
  const id = String(body.id ?? '').trim()
  const holder = found.record.keyHash
    ? Boolean(secret) && found.record.keyHash === hash(secret)
    : Boolean(id) && found.record.id === id
  if (!holder) { send(res, 403, { error: 'not your username' }); return }

  const del = await fetch(`${BLOB_API}/delete`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [found.url] })
  })
  if (!del.ok) throw new Error(`blob delete failed (${del.status})`)
  send(res, 200, { ok: true })
}

async function handleClaim (req, res, body) {
  const username = normalize(body.username)
  const id = String(body.id ?? '').trim()
  const displayName = String(body.name ?? '').trim().slice(0, MAX_NAME_CHARS)

  if (!USERNAME_RE.test(username)) { send(res, 400, { error: 'invalid username' }); return }
  if (!id || id.length > MAX_ID_CHARS) { send(res, 400, { error: 'invalid id' }); return }
  if (!displayName) { send(res, 400, { error: 'invalid name' }); return }

  if (await usernameExists(username)) { send(res, 409, { error: 'taken' }); return }

  const putRes = await fetch(`${BLOB_API}/${pathnameFor(username)}`, {
    method: 'PUT',
    headers: {
      ...authHeaders(),
      // Verified against the live Blob API: version 7 honours exact
      // pathnames with x-add-random-suffix 0; version 11 rejects them.
      'x-api-version': '7',
      'x-add-random-suffix': '0',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      username,
      id,
      name: displayName,
      ts: Date.now(),
      // Only the digest — the blob store is public, so the secret itself must
      // never be written here.
      ...(body.secret ? { keyHash: hash(body.secret) } : {})
    })
  })
  // Newer Blob API versions reject overwrites of an existing pathname — that
  // closes the exists-check race, so surface it as "taken" rather than a 500.
  if (putRes.status === 409) { send(res, 409, { error: 'taken' }); return }
  if (!putRes.ok) throw new Error(`blob put failed (${putRes.status})`)
  send(res, 200, { ok: true })
}

export default async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')

  if (req.method === 'OPTIONS') { send(res, 204); return }

  try {
    if (req.method === 'GET') {
      const query = req.query || {}
      if (query.check !== undefined) { await handleCheck(res, query.check); return }
      if (query.q !== undefined) { await handleSearch(res, query.q); return }
      send(res, 400, { error: 'missing check or q parameter' })
      return
    }

    if (req.method === 'POST') {
      let body = req.body
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { body = null }
      }
      if (!body || typeof body !== 'object') { send(res, 400, { error: 'invalid body' }); return }
      if (body.op === 'release') { await handleRelease(res, body); return }
      await handleClaim(req, res, body)
      return
    }

    send(res, 405, { error: 'method not allowed' })
  } catch (error) {
    send(res, 500, { error: error?.message || 'server error' })
  }
}
