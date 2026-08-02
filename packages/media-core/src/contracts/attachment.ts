/**
 * The attachment reference — the handle every layer above the bytes speaks.
 *
 * Design-only TYPE contract. Notes that shape later PRs but change nothing here:
 *   - `attachmentId` is SERVER-ASSIGNED and unguessable. Clients never choose
 *     it (a client-chosen id enables intra-conversation object clobber — a
 *     review-board finding). It is opaque: it encodes no room/user identity.
 *   - The attachment content key is RANDOM per attachment and delivered inside
 *     the Priority-1 ratcheted envelope. It is NEVER derived from a room key
 *     and never appears in this contract.
 */

import type { MediaClass, MediaTier } from './media-class.js'

/** The coarse decode family (routing only; the fine MIME lives in the manifest). */
export type MediaKind = 'image' | 'video' | 'audio' | 'file'

export interface PixelDimensions {
  readonly width: number
  readonly height: number
}

/**
 * A committed attachment as referenced by the app/UI. Carries only what a
 * caller needs to request, render-gate, and label an attachment — never keys,
 * never plaintext, never the manifest secrets.
 */
export interface AttachmentRef {
  /** Server-assigned, unguessable, opaque. */
  readonly attachmentId: string
  readonly mediaClass: MediaClass
  readonly tier: MediaTier
  readonly kind: MediaKind
  /** Fine MIME as CLAIMED by the sender (advisory; detection beats claim — see safety/). */
  readonly mime: string
  /** Total ciphertext byte length across all chunks. */
  readonly byteLength: number
  /** Number of AEAD chunks (crypto chunks, not provider multipart parts). */
  readonly chunkCount: number
  readonly viewOnce: boolean
  /** Present for image/video. */
  readonly dims?: PixelDimensions
  /** Present for video/audio, milliseconds. */
  readonly durationMs?: number
  /** Epoch millis; caller-supplied at construction, never inferred in this pure package. */
  readonly createdAt: number
}
