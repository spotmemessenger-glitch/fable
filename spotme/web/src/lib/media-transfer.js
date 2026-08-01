/**
 * Spot Me — attachments straight to object storage. Phase 5.
 *
 * The old path put every 128 KB slice through the socket as base64 inside a
 * `bin` action, and the server stored each one as a `RoomEvent.payload Bytes`
 * row. A 25 MB file is ~200 rows of ciphertext in the primary database, its
 * backups and its replication stream, and every byte of it crosses a WebSocket
 * that also has to carry live conversation.
 *
 * Here the bytes go client -> bucket, and the socket carries an envelope of a
 * few hundred bytes.
 *
 * ---------------------------------------------------------------------------
 * THE OBJECT KEY IS DERIVED, NOT TRANSMITTED
 *
 * `rooms/<roomId>/<attachId>/<seq>` is computable by anyone who already has the
 * roomId and the attachId — and the receiver has both: roomId is the room it is
 * sitting in, and attachId already travels in cleartext routing meta as `id`,
 * because the server needs it to route slices. So the envelope carries no key
 * at all. Sending one would add a field, leak nothing new, and create a second
 * source of truth that could disagree with the first.
 *
 * WHAT CROSSES THE WIRE. Ciphertext to the bucket; `{id, seq, total}` plus the
 * sealed envelope (`cm`) over the socket. The filename, caption, dimensions and
 * mime type are all inside `cm`. Sealing happens HERE, before the presign
 * request is even made — `sealForRoom` never hands out the key, and the URL we
 * are given is only ever pointed at bytes that are already encrypted.
 */
import { API_BASE } from './api.js'
import { freshTokens, sealForRoom, openForRoom } from './socket-transport.js'

/** Matches rooms.js's SLICE_BYTES — one chunking rule, not two. */
export const SLICE_BYTES = 128 * 1024

/** Object keys are built the same way on both sides. Mirrors the backend's
 *  buildObjectKey() in storage/storage.interface.ts. */
export const objectKeyFor = (roomId, attachId, seq) => `rooms/${roomId}/${attachId}/${seq}`

/**
 * Whether this device sends attachments through object storage.
 *
 * DEFAULTS TO OFF, and that is not timidity. This is the live media path for
 * every user; it has never been exercised between two real devices, and the
 * lesson of Phase 1 was that a correct implementation nobody ran end to end
 * still counts as broken. It flips on per device for testing, and becomes the
 * default when a two-device send has actually been watched.
 */
export function objectStorageEnabled () {
  try { return localStorage.getItem('spotme.media') === 'object' } catch { return false }
}

async function authHeader () {
  const { accessToken } = (await freshTokens()) || {}
  if (!accessToken) throw new Error('not signed in')
  return { Authorization: `Bearer ${accessToken}` }
}

/**
 * Upload one already-sealed slice.
 *
 * The presign request names the room and the slice; the SERVER builds the
 * object key and checks membership and group media permission before signing
 * anything. A client never chooses where its bytes land.
 */
async function putSlice (roomId, attachId, seq, sealed) {
  const auth = await authHeader()
  const res = await fetch(`${API_BASE}/api/v2/media/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ roomId, attachId, seq, contentType: 'application/octet-stream' })
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.message || `presign failed: HTTP ${res.status}`)
  }
  const { uploadUrl, objectKey } = await res.json()
  if (!uploadUrl) throw new Error('presign returned no url')

  // The URL is absolute for S3/R2 and relative for the local adapter; both are
  // fetched the same way once resolved against the API origin.
  const target = /^https?:/i.test(uploadUrl) ? uploadUrl : `${API_BASE}${uploadUrl}`
  const put = await fetch(target, {
    /* PUT, NOT POST — and this was a live bug until R2 existed to catch it.
     *
     * `getUploadUrl` presigns a PutObjectCommand, so the S3/R2 signature covers
     * the PUT method only; a POST to that URL is rejected outright. It passed
     * every test up to this point purely because the LOCAL adapter's route
     * happened to be @Post(), so the mismatch was invisible until the first
     * real bucket existed. Both sides speak PUT now. */
    method: 'PUT',
    // Bound into the presigned signature — a mismatch is rejected by the
    // storage provider, which is the point of pinning it.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: sealed
  })
  if (!put.ok) throw new Error(`upload failed: HTTP ${put.status}`)
  return objectKey
}

/**
 * Seal a buffer, slice it, and push every slice to storage.
 *
 * Sequential rather than parallel, deliberately: the same reason
 * `deliverAttachment` awaits each socket slice. A phone on mobile data that
 * opens twenty concurrent uploads starves the connection the conversation is
 * still using, and progress becomes meaningless.
 *
 * Returns the slice count, which is what the envelope must declare so a
 * receiver can tell a complete transfer from a truncated one.
 */
export async function uploadAttachment (roomId, attachId, buffer, { password, onProgress } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const total = Math.max(1, Math.ceil(bytes.byteLength / SLICE_BYTES))
  for (let seq = 0; seq < total; seq++) {
    const slice = bytes.subarray(seq * SLICE_BYTES, (seq + 1) * SLICE_BYTES)
    const sealed = await sealForRoom(roomId, slice, password)
    await putSlice(roomId, attachId, seq, sealed)
    // Capped below 1: the transfer is not finished until the envelope is sent.
    onProgress?.(Math.min((seq + 1) / total, 0.99))
  }
  return { total }
}

/**
 * Fetch and decrypt every slice of an attachment back into one buffer.
 *
 * A MISSING SLICE IS AN ERROR, NOT A SHORTER FILE. This is the same truncation
 * hazard the RoomEvent path had to fix: an interrupted upload leaves a short
 * tail, the bytes that ARE there decode perfectly, and a voice note simply
 * stops early with nothing anywhere reporting a problem. `total` comes from the
 * sender's sealed envelope, so a gap is detectable — and is refused loudly.
 */
export async function downloadAttachment (roomId, attachId, total, { password, onProgress } = {}) {
  const auth = await authHeader()
  const parts = []
  for (let seq = 0; seq < total; seq++) {
    const key = objectKeyFor(roomId, attachId, seq)
    const res = await fetch(
      `${API_BASE}/api/v2/media/download-url/${encodeURIComponent(key)}`,
      { headers: auth }
    )
    if (res.status === 404) {
      // The server's word for "opened and destroyed". Distinguished from a
      // network failure so the UI can stop asking rather than retry forever.
      throw new Error('that private photo has been opened and destroyed')
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.message || `download-url failed: HTTP ${res.status}`)
    }
    const { downloadUrl } = await res.json()
    const target = /^https?:/i.test(downloadUrl) ? downloadUrl : `${API_BASE}${downloadUrl}`
    const bytes = await fetch(target)
    if (!bytes.ok) throw new Error(`fetch slice ${seq}: HTTP ${bytes.status}`)
    const sealed = new Uint8Array(await bytes.arrayBuffer())
    parts.push(await openForRoom(roomId, sealed, password))
    onProgress?.((seq + 1) / total)
  }
  if (parts.length !== total) throw new Error('transfer incomplete in storage')

  const size = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}
