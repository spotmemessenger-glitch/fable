/**
 * Spot Me — BLE CHUNKING: MTU-sized framing for GATT writes. ADR-012b.
 *
 * A Web Bluetooth characteristic write carries AT MOST 512 bytes (the spec's
 * hard cap), and the effective ATT payload on many stacks is far smaller
 * (23-byte default MTU − 3 header = 20 bytes until a data-length extension
 * negotiates up). An envelope does not fit; a chunker is not optional.
 *
 * WIRE FORMAT, 6-byte header per chunk, little-endian:
 *
 *   [0]    tag        one byte identifying the frame this chunk belongs to
 *                     (rolling 0..255 per sender; collision-safe because a
 *                     link is a serialized point-to-point stream and stale
 *                     partials expire)
 *   [1..2] index      chunk index, 0-based
 *   [3..4] total      chunk count for this frame
 *   [5]    flags      bit0: last chunk (redundant with index==total-1, kept
 *                     as a cheap integrity cross-check)
 *
 * GATT writes-with-response are delivered IN ORDER per link, so no
 * per-chunk sequence beyond the index is needed; the tag exists so a frame
 * abandoned mid-transfer (link drop) cannot be completed by chunks of the
 * NEXT frame. The reassembler holds at most `maxPartials` frames and expires
 * partials after `partialTtlMs` — bounded memory under any peer behaviour,
 * malformed input returns null (drop + count, never throw).
 *
 * Payloads are OPAQUE BYTES throughout (INV-2): the chunker splits and
 * rejoins without reading them.
 */

export const CHUNK_HEADER_BYTES = 6
export const BLE_CHUNK_DEFAULTS = Object.freeze({
  chunkPayloadBytes: 180,     // conservative post-DLE ATT payload; configurable
  maxChunkPayloadBytes: 506,  // 512 − header
  maxFrameBytes: 64_000,      // reassembly bound per frame
  maxPartials: 8,             // concurrent frames mid-reassembly per link
  partialTtlMs: 30_000
})

/** Split opaque bytes into ordered chunk buffers. */
export function chunkFrame (bytes, { tag, chunkPayloadBytes = BLE_CHUNK_DEFAULTS.chunkPayloadBytes } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new Error('chunk: bytes required')
  if (!Number.isInteger(tag) || tag < 0 || tag > 255) throw new Error('chunk: tag must be 0..255')
  const size = Math.min(Math.max(1, chunkPayloadBytes), BLE_CHUNK_DEFAULTS.maxChunkPayloadBytes)
  if (bytes.byteLength > BLE_CHUNK_DEFAULTS.maxFrameBytes) {
    throw new Error(`chunk: frame ${bytes.byteLength}B exceeds maxFrameBytes ${BLE_CHUNK_DEFAULTS.maxFrameBytes}B`)
  }
  const total = Math.max(1, Math.ceil(bytes.byteLength / size))
  if (total > 0xffff) throw new Error('chunk: frame needs more than 65535 chunks')
  const out = []
  for (let i = 0; i < total; i++) {
    const slice = bytes.subarray(i * size, Math.min(bytes.byteLength, (i + 1) * size))
    const chunk = new Uint8Array(CHUNK_HEADER_BYTES + slice.byteLength)
    chunk[0] = tag
    chunk[1] = i & 0xff
    chunk[2] = (i >> 8) & 0xff
    chunk[3] = total & 0xff
    chunk[4] = (total >> 8) & 0xff
    chunk[5] = i === total - 1 ? 1 : 0
    chunk.set(slice, CHUNK_HEADER_BYTES)
    out.push(chunk)
  }
  return out
}

/** Parse one chunk buffer. Null on malformation. */
export function parseChunk (buf) {
  if (!(buf instanceof Uint8Array) || buf.byteLength < CHUNK_HEADER_BYTES) return null
  const tag = buf[0]
  const index = buf[1] | (buf[2] << 8)
  const total = buf[3] | (buf[4] << 8)
  const last = (buf[5] & 1) === 1
  if (total === 0 || index >= total) return null
  if (last !== (index === total - 1)) return null
  return { tag, index, total, payload: buf.subarray(CHUNK_HEADER_BYTES) }
}

/**
 * Reassembler for one link. `push(buf, now)` returns:
 *   { frame: Uint8Array }  when a frame completed,
 *   { pending: true }      when the chunk was absorbed,
 *   { drop: reason }       when it was discarded (malformed / bounds / stale).
 */
export function createReassembler ({ config = {} } = {}) {
  const cfg = { ...BLE_CHUNK_DEFAULTS, ...config }
  const partials = new Map()   // tag -> { total, got, chunks: Array, bytes, startedAt }
  const counters = { completed: 0, dropped: 0, expired: 0 }

  function expire (now) {
    for (const [tag, p] of partials) {
      if (now - p.startedAt > cfg.partialTtlMs) { partials.delete(tag); counters.expired++ }
    }
  }

  return Object.freeze({
    push (buf, now = 0) {
      expire(now)
      const c = parseChunk(buf)
      if (!c) { counters.dropped++; return { drop: 'malformed' } }

      let p = partials.get(c.tag)
      if (p && p.total !== c.total) {
        // Same tag, different geometry: the old transfer died mid-flight and
        // the tag rolled around. The new frame wins; the stale partial dies.
        partials.delete(c.tag)
        p = null
      }
      if (!p) {
        if (partials.size >= cfg.maxPartials) { counters.dropped++; return { drop: 'too-many-partials' } }
        p = { total: c.total, got: 0, chunks: new Array(c.total).fill(null), bytes: 0, startedAt: now }
        partials.set(c.tag, p)
      }
      if (p.chunks[c.index]) { counters.dropped++; return { drop: 'duplicate-chunk' } }
      p.bytes += c.payload.byteLength
      if (p.bytes > cfg.maxFrameBytes) {
        partials.delete(c.tag)
        counters.dropped++
        return { drop: 'frame-too-large' }
      }
      p.chunks[c.index] = c.payload
      p.got++
      if (p.got < p.total) return { pending: true }

      partials.delete(c.tag)
      const frame = new Uint8Array(p.bytes)
      let at = 0
      for (const part of p.chunks) { frame.set(part, at); at += part.byteLength }
      counters.completed++
      return { frame }
    },
    stats: () => ({ ...counters, partials: partials.size })
  })
}
