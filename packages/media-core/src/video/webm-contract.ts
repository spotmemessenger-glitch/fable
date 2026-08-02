/**
 * The unified video-container contract.
 *
 * Reconciliation (evidence from the frozen branches — nothing copied):
 *   - Camera `webm-mux.js` exposes `muxWebm({codec,width,height,frames})` with
 *     a video-only, `{data,timestampMs,keyframe}` frame shape.
 *   - Studio `webm.js` exposes `muxWebM({video,audio?,durationMs})` with a
 *     `{data,tsMs,key}` frame shape and Opus passthrough + a demuxer.
 * These are incompatible CONTRACTS. This file defines the ONE canonical shape
 * they both migrate onto; the muxer/demuxer implementation is a LATER PR.
 *
 * Review-board correction folded in: the container is POLYMORPHIC. WebCodecs
 * paths produce WebM (VP8/VP9/AV1 + Opus); the iOS Safari `MediaRecorder`
 * fallback produces MP4 (H.264 + AAC), because WebKit does not emit WebM. A
 * manifest/pipeline that assumes "always WebM" is wrong on the exact platform
 * the fallback targets — so container + codecs are described, never assumed.
 */

export type ContainerFormat = 'webm' | 'mp4'
export type VideoCodec = 'vp8' | 'vp9' | 'av1' | 'h264'
export type AudioCodec = 'opus' | 'aac'

/** The canonical encoded-frame shape both branches migrate to (`tsMs`,`key`). */
export interface EncodedVideoFrame {
  /** Presentation timestamp, milliseconds. */
  readonly tsMs: number
  /** Whether this is a keyframe. */
  readonly key: boolean
  readonly data: Uint8Array
}

export interface VideoTrackDescriptor {
  readonly codec: VideoCodec
  readonly width: number
  readonly height: number
}

export interface AudioTrackDescriptor {
  readonly codec: AudioCodec
  readonly sampleRate: number
  readonly channels: number
}

/** Describes the container + tracks of an encoded media object. */
export interface ContainerDescriptor {
  readonly format: ContainerFormat
  readonly video: VideoTrackDescriptor
  readonly audio?: AudioTrackDescriptor
  /** Total duration, milliseconds, when known (camera derives from frames). */
  readonly durationMs?: number
}

/** Which codecs each container legitimately carries (the closed matrix). */
export const CONTAINER_CODECS: Readonly<
  Record<ContainerFormat, { video: readonly VideoCodec[]; audio: readonly AudioCodec[] }>
> = Object.freeze({
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus'] },
  mp4: { video: ['h264'], audio: ['aac'] },
})

/** The natural container for a video codec (WebCodecs→WebM, Safari→MP4). */
export function containerForVideoCodec(codec: VideoCodec): ContainerFormat {
  return codec === 'h264' ? 'mp4' : 'webm'
}

/** True when the descriptor's codecs are legal for its declared container. */
export function isContainerConsistent(d: ContainerDescriptor): boolean {
  const allowed = CONTAINER_CODECS[d.format]
  if (!allowed.video.includes(d.video.codec)) return false
  if (d.audio && !allowed.audio.includes(d.audio.codec)) return false
  return true
}
