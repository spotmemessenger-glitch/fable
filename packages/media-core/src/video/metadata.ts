/**
 * Video metadata contract + a pure, dependency-free container sniff.
 *
 * The full probe (dimensions, duration, exact codec) needs a demuxer and runs
 * in a worker in a later PR. Here we provide only the TYPE and a byte-header
 * container detector that is safe to run on the first few bytes of any file —
 * enough to route a blob and to cross-check a claimed MIME.
 */

import type { ContainerFormat } from './webm-contract.js'

export interface VideoMetadata {
  readonly container: ContainerFormat
  readonly width?: number
  readonly height?: number
  readonly durationMs?: number
  /** Number of frames, when a full probe supplies it. */
  readonly frameCount?: number
}

/**
 * Detect the container from leading bytes. Pure; reads at most 12 bytes.
 *   - WebM/Matroska: EBML magic `1A 45 DF A3` at offset 0.
 *   - MP4/ISO-BMFF: `ftyp` box type at offset 4 (`66 74 79 70`).
 * Returns null when neither signature is present.
 */
export function detectVideoContainer(head: Uint8Array): ContainerFormat | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'webm'
  }
  if (
    head.length >= 8 &&
    head[4] === 0x66 && // f
    head[5] === 0x74 && // t
    head[6] === 0x79 && // y
    head[7] === 0x70 //   p
  ) {
    return 'mp4'
  }
  return null
}
