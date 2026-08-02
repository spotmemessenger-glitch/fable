/**
 * Spot Me — Creative Studio WebM container: minimal EBML muxer + reader.
 *
 * WHY HAND-ROLLED. WebCodecs encodes FRAMES (VP8/VP9 chunks, Opus packets)
 * but writes no container, and the zero-dependency rule is absolute — so the
 * container is implemented from the EBML/Matroska spec directly: exactly the
 * subset WebM players require (header, segment, info, tracks,
 * clusters/SimpleBlocks). The reader half exists for two honest reasons:
 * round-trip tests that PROVE the writer's structure rather than eyeballing
 * bytes, and extracting Opus packets out of MediaRecorder voice-note files so
 * the composer can pass an audio track through WITHOUT re-encoding.
 *
 * Byte budgets are enforced: this is an in-memory writer sized for stories
 * (≤ 5 min, ≤ 256 MB), not a streaming recorder.
 */

export const MAX_WEBM_BYTES = 256_000_000

/* ---------------------------------------------------------------- writing */

class ByteSink {
  constructor () {
    this.chunks = []
    this.length = 0
  }

  push (bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
    if (this.length > MAX_WEBM_BYTES) throw new RangeError('webm: output over the in-memory budget')
  }

  concat () {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const c of this.chunks) { out.set(c, at); at += c.length }
    return out
  }
}

/** EBML variable-length size. Always minimal-width, 1..8 bytes. */
export function encodeVint (value) {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('vint: bad value')
  for (let width = 1; width <= 8; width++) {
    const max = Math.pow(2, 7 * width) - 2          // all-ones is reserved ("unknown")
    if (value <= max) {
      const out = new Uint8Array(width)
      let v = value
      for (let i = width - 1; i > 0; i--) {
        out[i] = v & 0xff
        v = Math.floor(v / 256)
      }
      out[0] = v | (0x80 >> (width - 1))
      return out
    }
  }
  throw new RangeError('vint: value too large')
}

function idBytes (id) {
  // Element ids are stored with their marker bits already in the constant.
  const out = []
  let v = id
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256) }
  return new Uint8Array(out)
}

function uintBytes (value) {
  if (value === 0) return new Uint8Array([0])
  const out = []
  let v = value
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256) }
  return new Uint8Array(out)
}

function floatBytes (value) {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, value)
  return b
}

function stringBytes (s) { return new TextEncoder().encode(s) }

/** One element: id + size vint + payload. */
export function element (id, payload) {
  const idb = idBytes(id)
  const size = encodeVint(payload.length)
  const out = new Uint8Array(idb.length + size.length + payload.length)
  out.set(idb, 0)
  out.set(size, idb.length)
  out.set(payload, idb.length + size.length)
  return out
}

const master = (id, children) => {
  let len = 0
  for (const c of children) len += c.length
  const payload = new Uint8Array(len)
  let at = 0
  for (const c of children) { payload.set(c, at); at += c.length }
  return element(id, payload)
}

/* EBML / Matroska element ids (WebM subset). */
export const ID = Object.freeze({
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3
})

export const VIDEO_CODECS = Object.freeze({ vp8: 'V_VP8', vp9: 'V_VP9', av1: 'V_AV1' })

/**
 * Mux encoded frames (and optionally pre-encoded Opus packets) into WebM.
 *
 *   video:  { codec: 'vp8'|'vp9'|'av1', width, height,
 *             frames: [{ tsMs, key, data: Uint8Array }] }  ordered by tsMs
 *   audio?: { codecPrivate: Uint8Array, sampleRate, channels,
 *             packets: [{ tsMs, data: Uint8Array }] }       Opus passthrough
 *   durationMs: total duration written into Info.
 */
export function muxWebM ({ video, audio = null, durationMs }) {
  if (!video || !VIDEO_CODECS[video.codec]) throw new RangeError('webm: video codec must be vp8|vp9|av1')
  if (!Array.isArray(video.frames) || video.frames.length === 0) throw new RangeError('webm: no frames')
  const sink = new ByteSink()

  sink.push(master(ID.EBML, [
    element(ID.EBMLVersion, uintBytes(1)),
    element(ID.EBMLReadVersion, uintBytes(1)),
    element(ID.EBMLMaxIDLength, uintBytes(4)),
    element(ID.EBMLMaxSizeLength, uintBytes(8)),
    element(ID.DocType, stringBytes('webm')),
    element(ID.DocTypeVersion, uintBytes(2)),
    element(ID.DocTypeReadVersion, uintBytes(2))
  ]))

  const info = master(ID.Info, [
    element(ID.TimestampScale, uintBytes(1_000_000)),      // 1 tick = 1 ms
    element(ID.MuxingApp, stringBytes('spotme-studio')),
    element(ID.WritingApp, stringBytes('spotme-studio')),
    element(ID.Duration, floatBytes(Math.max(1, durationMs)))
  ])

  const trackEntries = [master(ID.TrackEntry, [
    element(ID.TrackNumber, uintBytes(1)),
    element(ID.TrackUID, uintBytes(1)),
    element(ID.TrackType, uintBytes(1)),                   // video
    element(ID.CodecID, stringBytes(VIDEO_CODECS[video.codec])),
    master(ID.Video, [
      element(ID.PixelWidth, uintBytes(video.width)),
      element(ID.PixelHeight, uintBytes(video.height))
    ])
  ])]
  if (audio) {
    if (!(audio.codecPrivate instanceof Uint8Array) || audio.codecPrivate.length < 8) {
      throw new RangeError('webm: audio needs its OpusHead CodecPrivate')
    }
    trackEntries.push(master(ID.TrackEntry, [
      element(ID.TrackNumber, uintBytes(2)),
      element(ID.TrackUID, uintBytes(2)),
      element(ID.TrackType, uintBytes(2)),                 // audio
      element(ID.CodecID, stringBytes('A_OPUS')),
      element(ID.CodecPrivate, audio.codecPrivate),
      master(ID.Audio, [
        element(ID.SamplingFrequency, floatBytes(audio.sampleRate || 48000)),
        element(ID.Channels, uintBytes(audio.channels || 1))
      ])
    ]))
  }
  const tracks = master(ID.Tracks, trackEntries)

  /* Clusters: start at every video keyframe or 4 s, whichever first (the
   * SimpleBlock timestamp is a SIGNED 16-bit offset from the cluster's, so a
   * cluster must never span more than ±32 s; 4 s keeps seeking snappy). Audio
   * packets are interleaved by timestamp. */
  const blocks = []
  for (const f of video.frames) {
    if (!(f.data instanceof Uint8Array)) throw new TypeError('webm: frame data must be Uint8Array')
    blocks.push({ track: 1, tsMs: Math.round(f.tsMs), key: Boolean(f.key), data: f.data })
  }
  if (audio) {
    for (const p of audio.packets) {
      if (!(p.data instanceof Uint8Array)) throw new TypeError('webm: audio packet must be Uint8Array')
      blocks.push({ track: 2, tsMs: Math.round(p.tsMs), key: true, data: p.data })
    }
  }
  blocks.sort((a, b) => a.tsMs - b.tsMs || a.track - b.track)

  const clusters = []
  let cluster = null
  let clusterTs = 0
  for (const blk of blocks) {
    const needNew = !cluster ||
      (blk.track === 1 && blk.key && cluster.children.length > 1) ||
      blk.tsMs - clusterTs > 4000 ||
      blk.tsMs - clusterTs > 32000
    if (needNew) {
      if (cluster) clusters.push(master(ID.Cluster, cluster.children))
      clusterTs = blk.tsMs
      cluster = { children: [element(ID.Timestamp, uintBytes(clusterTs))] }
    }
    const rel = blk.tsMs - clusterTs
    const head = new Uint8Array(4)
    head[0] = 0x80 | blk.track                             // track vint (1-byte form)
    head[1] = (rel >> 8) & 0xff
    head[2] = rel & 0xff
    head[3] = blk.key ? 0x80 : 0x00
    const payload = new Uint8Array(4 + blk.data.length)
    payload.set(head, 0)
    payload.set(blk.data, 4)
    cluster.children.push(element(ID.SimpleBlock, payload))
  }
  if (cluster) clusters.push(master(ID.Cluster, cluster.children))

  sink.push(master(ID.Segment, [info, tracks, ...clusters]))
  return sink.concat()
}

/* ---------------------------------------------------------------- reading */

function readVintAt (b, at, keepMarker) {
  if (at >= b.length) return null
  const first = b[at]
  let width = 1
  for (let mask = 0x80; mask > 0; mask >>= 1, width++) {
    if (first & mask) break
  }
  if (width > 8 || at + width > b.length) return null
  let value = keepMarker ? first : first & (0xff >> width)
  for (let i = 1; i < width; i++) value = value * 256 + b[at + i]
  return { value, width }
}

/** Walk children of a master element's payload → [{id, at, size}]. */
export function readChildren (b, start, end) {
  const out = []
  let at = start
  while (at < end) {
    const id = readVintAt(b, at, true)
    if (!id) break
    const size = readVintAt(b, at + id.width, false)
    if (!size) break
    out.push({ id: id.value, at: at + id.width + size.width, size: size.value })
    at = at + id.width + size.width + size.value
  }
  return out
}

/**
 * Parse just enough of a WebM file for tests and audio passthrough:
 * → { docType, durationMs, tracks: [{number, type, codec, width?, height?,
 *     sampleRate?, channels?, codecPrivate?}], blocks: [{track, tsMs, key, size}] }
 */
export function parseWebM (bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const top = readChildren(b, 0, b.length)
  const out = { docType: null, durationMs: null, tracks: [], blocks: [] }
  const utf8 = new TextDecoder()
  const uintAt = (c) => { let v = 0; for (let i = c.at; i < c.at + c.size; i++) v = v * 256 + b[i]; return v }
  for (const el of top) {
    if (el.id === ID.EBML) {
      for (const c of readChildren(b, el.at, el.at + el.size)) {
        if (c.id === ID.DocType) out.docType = utf8.decode(b.subarray(c.at, c.at + c.size))
      }
    }
    if (el.id !== ID.Segment) continue
    for (const seg of readChildren(b, el.at, el.at + el.size)) {
      if (seg.id === ID.Info) {
        for (const c of readChildren(b, seg.at, seg.at + seg.size)) {
          if (c.id === ID.Duration) {
            const dv = new DataView(b.buffer, b.byteOffset + c.at, c.size)
            out.durationMs = c.size === 4 ? dv.getFloat32(0) : dv.getFloat64(0)
          }
        }
      } else if (seg.id === ID.Tracks) {
        for (const te of readChildren(b, seg.at, seg.at + seg.size)) {
          if (te.id !== ID.TrackEntry) continue
          const track = {}
          for (const c of readChildren(b, te.at, te.at + te.size)) {
            if (c.id === ID.TrackNumber) track.number = uintAt(c)
            else if (c.id === ID.TrackType) track.type = uintAt(c)
            else if (c.id === ID.CodecID) track.codec = utf8.decode(b.subarray(c.at, c.at + c.size))
            else if (c.id === ID.CodecPrivate) track.codecPrivate = b.slice(c.at, c.at + c.size)
            else if (c.id === ID.Video) {
              for (const v of readChildren(b, c.at, c.at + c.size)) {
                if (v.id === ID.PixelWidth) track.width = uintAt(v)
                if (v.id === ID.PixelHeight) track.height = uintAt(v)
              }
            } else if (c.id === ID.Audio) {
              for (const a of readChildren(b, c.at, c.at + c.size)) {
                if (a.id === ID.SamplingFrequency) {
                  const dv = new DataView(b.buffer, b.byteOffset + a.at, a.size)
                  track.sampleRate = a.size === 4 ? dv.getFloat32(0) : dv.getFloat64(0)
                }
                if (a.id === ID.Channels) track.channels = uintAt(a)
              }
            }
          }
          out.tracks.push(track)
        }
      } else if (seg.id === ID.Cluster) {
        let clusterTs = 0
        for (const c of readChildren(b, seg.at, seg.at + seg.size)) {
          if (c.id === ID.Timestamp) clusterTs = uintAt(c)
          else if (c.id === ID.SimpleBlock) {
            const tr = readVintAt(b, c.at, false)
            if (!tr) continue
            const rel = ((b[c.at + tr.width] << 8) | b[c.at + tr.width + 1]) << 16 >> 16
            const flags = b[c.at + tr.width + 2]
            out.blocks.push({
              track: tr.value,
              tsMs: clusterTs + rel,
              key: Boolean(flags & 0x80),
              size: c.size - tr.width - 3,
              at: c.at + tr.width + 3
            })
          }
        }
      }
    }
  }
  return out
}

/**
 * Pull the Opus track out of a MediaRecorder voice-note WebM so the composer
 * can remux it untouched. Returns null (never throws) when there is no clean
 * Opus track — the caller then renders silent video and SAYS so in metadata.
 */
export function extractOpusTrack (bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const parsed = parseWebM(b)
    const track = parsed.tracks.find((t) => t.codec === 'A_OPUS' && t.codecPrivate)
    if (!track) return null
    const packets = parsed.blocks
      .filter((blk) => blk.track === track.number)
      .map((blk) => ({ tsMs: blk.tsMs, data: b.slice(blk.at, blk.at + blk.size) }))
    if (!packets.length) return null
    return {
      codecPrivate: track.codecPrivate,
      sampleRate: track.sampleRate || 48000,
      channels: track.channels || 1,
      packets
    }
  } catch {
    return null
  }
}
