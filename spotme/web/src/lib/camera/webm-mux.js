/**
 * Spot Me camera — a minimal WebM (Matroska subset) muxer for WebCodecs
 * output, written here because VideoEncoder emits BARE encoded chunks and
 * a chunk without a container is not a video file — and the engine ships
 * zero dependencies.
 *
 * WHAT IT WRITES: EBML header → Segment(Info, Tracks, Cluster*) with one
 * video track (V_VP8 / V_VP9 / V_AV1) and SimpleBlocks. Sizes are exact
 * (assembly is post-hoc, everything is in memory), timestamps are
 * millisecond TimestampScale, clusters rotate before the int16 relative
 * timestamp would overflow and always open on a keyframe when one arrives.
 * NO Cues/seeking index — playback-only files, honestly non-seekable, the
 * standard shape for short clips.
 *
 * WHAT IT DOES NOT PRETEND: no audio, no mp4 (that is a licensing and
 * complexity cliff — mp4 assembly on Safari uses the MediaRecorder replay
 * path instead, labeled), no streaming write. `readEbml` walks the output
 * back so tests assert real structure rather than "some bytes exist".
 */

/* --------------------------------------------------------- EBML atoms ---- */

const ID = Object.freeze({
  EBML: 0x1A45DFA3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42F7,
  EBMLMaxIDLength: 0x42F2,
  EBMLMaxSizeLength: 0x42F3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549A966,
  TimestampScale: 0x2AD7B1,
  MuxingApp: 0x4D80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackUID: 0x73C5,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xE0,
  PixelWidth: 0xB0,
  PixelHeight: 0xBA,
  Cluster: 0x1F43B675,
  Timestamp: 0xE7,
  SimpleBlock: 0xA3,
})

export const WEBM_CODEC_IDS = Object.freeze({
  vp8: 'V_VP8', vp9: 'V_VP9', av1: 'V_AV1',
})

function idBytes (id) {
  const out = []
  let v = id
  while (v > 0) { out.unshift(v & 0xFF); v = Math.floor(v / 256) }
  return Uint8Array.from(out)
}

/** EBML variable-width size. Width chosen minimally; 8-byte max. */
export function vintBytes (value) {
  for (let width = 1; width <= 8; width++) {
    const max = 2 ** (7 * width) - 2      // all-ones is reserved ("unknown")
    if (value <= max) {
      const out = new Uint8Array(width)
      let v = value
      for (let i = width - 1; i >= 0; i--) { out[i] = v & 0xFF; v = Math.floor(v / 256) }
      out[0] |= 1 << (8 - width)
      return out
    }
  }
  throw new Error(`vint overflow: ${value}`)
}

function concat (parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}

function element (id, payload) {
  const body = payload instanceof Uint8Array ? payload : concat(payload)
  return concat([idBytes(id), vintBytes(body.length), body])
}

function uintPayload (value) {
  const out = []
  let v = value
  do { out.unshift(v & 0xFF); v = Math.floor(v / 256) } while (v > 0)
  return Uint8Array.from(out)
}

function floatPayload (value) {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, value)
  return new Uint8Array(buf)
}

function stringPayload (s) {
  return new TextEncoder().encode(s)
}

/* -------------------------------------------------------------- muxing --- */

const CLUSTER_LIMIT_MS = 30_000           // int16 relative ts caps at 32767

/**
 * @param codec  'vp8' | 'vp9' | 'av1'
 * @param frames [{ data: Uint8Array, timestampMs, keyframe }] ascending ts
 * @returns Uint8Array — a playable .webm
 */
export function muxWebm ({ codec, width, height, frames }) {
  const codecId = WEBM_CODEC_IDS[codec]
  if (!codecId) throw new Error(`unsupported webm codec: ${codec} (vp8|vp9|av1)`)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('muxWebm needs integer width/height')
  }
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('muxWebm needs frames')

  const header = element(ID.EBML, [
    element(ID.EBMLVersion, uintPayload(1)),
    element(ID.EBMLReadVersion, uintPayload(1)),
    element(ID.EBMLMaxIDLength, uintPayload(4)),
    element(ID.EBMLMaxSizeLength, uintPayload(8)),
    element(ID.DocType, stringPayload('webm')),
    element(ID.DocTypeVersion, uintPayload(2)),
    element(ID.DocTypeReadVersion, uintPayload(2)),
  ])

  const durationMs = frames[frames.length - 1].timestampMs - frames[0].timestampMs
  const info = element(ID.Info, [
    element(ID.TimestampScale, uintPayload(1_000_000)),   // 1 tick = 1 ms
    element(ID.Duration, floatPayload(Math.max(1, durationMs))),
    element(ID.MuxingApp, stringPayload('spotme-camera')),
    element(ID.WritingApp, stringPayload('spotme-camera')),
  ])

  const tracks = element(ID.Tracks, [
    element(ID.TrackEntry, [
      element(ID.TrackNumber, uintPayload(1)),
      element(ID.TrackUID, uintPayload(1)),
      element(ID.TrackType, uintPayload(1)),              // video
      element(ID.CodecID, stringPayload(codecId)),
      element(ID.Video, [
        element(ID.PixelWidth, uintPayload(width)),
        element(ID.PixelHeight, uintPayload(height)),
      ]),
    ]),
  ])

  const clusters = []
  let clusterStart = null
  let blocks = []
  const t0 = frames[0].timestampMs
  const flush = () => {
    if (clusterStart === null) return
    clusters.push(element(ID.Cluster, [element(ID.Timestamp, uintPayload(clusterStart)), ...blocks]))
    clusterStart = null
    blocks = []
  }
  for (const frame of frames) {
    const ts = Math.round(frame.timestampMs - t0)
    const rotate = clusterStart === null ||
      ts - clusterStart > CLUSTER_LIMIT_MS ||
      (frame.keyframe && blocks.length > 0 && ts - clusterStart > 1_000)
    if (rotate) { flush(); clusterStart = ts }
    const relative = ts - clusterStart
    const blockHead = new Uint8Array(4)
    blockHead[0] = 0x81                                   // track 1 as vint
    blockHead[1] = (relative >> 8) & 0xFF
    blockHead[2] = relative & 0xFF
    blockHead[3] = frame.keyframe ? 0x80 : 0x00
    blocks.push(element(ID.SimpleBlock, concat([blockHead, frame.data])))
  }
  flush()

  return concat([header, element(ID.Segment, [info, tracks, ...clusters])])
}

/* ------------------------------------------------- reading it back ------- */

const MASTER_IDS = new Set([ID.EBML, ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster])

/** Parse EBML into {id, size, offset, children|data} — the test's eyes. */
export function readEbml (bytes, start = 0, end = bytes.length) {
  const out = []
  let offset = start
  while (offset < end) {
    const idStart = offset
    const idWidth = leadingWidth(bytes[offset])
    let id = 0
    for (let i = 0; i < idWidth; i++) id = id * 256 + bytes[offset + i]
    offset += idWidth
    const sizeWidth = leadingWidth(bytes[offset])
    let size = bytes[offset] & (0xFF >> sizeWidth)
    for (let i = 1; i < sizeWidth; i++) size = size * 256 + bytes[offset + i]
    offset += sizeWidth
    const node = { id, size, offset: idStart }
    if (MASTER_IDS.has(id)) node.children = readEbml(bytes, offset, offset + size)
    else node.data = bytes.slice(offset, offset + size)
    out.push(node)
    offset += size
  }
  return out
}

function leadingWidth (byte) {
  for (let width = 1; width <= 8; width++) {
    if (byte & (1 << (8 - width))) return width
  }
  throw new Error('bad EBML width byte')
}

export const EBML_ID = ID
