/**
 * The integrity manifest — the authenticated root of trust for one attachment.
 *
 * Two review-board corrections are baked into this contract:
 *   1. Integrity is a LIST of per-chunk ciphertext hashes plus a root computed
 *      over that list — NOT a single whole-file digest. WebCrypto has no
 *      streaming digest, so a whole-file hash would force the entire plaintext
 *      resident and blow the streaming-memory budget. Per-chunk hashing lets a
 *      chunk be verified as it arrives; the root commits the whole set.
 *   2. The container is POLYMORPHIC (see video/webm-contract): a manifest can
 *      describe a WebM/VP9|AV1 object OR an MP4/H.264 object, because the iOS
 *      Safari MediaRecorder fallback emits MP4, not WebM.
 *
 * Crypto note (design-only): the AEAD is AES-256-GCM (canonical). The per-
 * attachment content key is RANDOM and delivered in the P1 ratcheted envelope;
 * it never appears in the manifest. This package computes NO hashes and does NO
 * crypto — the actual SHA-256 over each ciphertext chunk and over the root
 * preimage is the crypto package's job. Here we define the SHAPE and a pure,
 * dependency-free canonicalisation + structural validator.
 */

import type { MediaClass } from './media-class.js'
import type { MediaKind, PixelDimensions } from './attachment.js'
import type { ContainerDescriptor } from '../video/webm-contract.js'

export const MEDIA_MANIFEST_VERSION = 1 as const

/** Canonical AEAD suite. AES-256-GCM per owner decision; versioned for agility. */
export type AeadAlg = 'aes-256-gcm'

/** A hex-encoded SHA-256 (64 lowercase hex chars). */
export type Sha256Hex = string

const SHA256_HEX = /^[0-9a-f]{64}$/

export interface ChunkDigest {
  /** 0-based chunk index; must be contiguous 0..chunkCount-1. */
  readonly index: number
  /** Ciphertext length of this chunk in bytes (includes the AEAD tag). */
  readonly ciphertextLength: number
  /** SHA-256 of the sealed chunk bytes, hex. */
  readonly sha256: Sha256Hex
}

export interface MediaManifest {
  readonly v: typeof MEDIA_MANIFEST_VERSION
  readonly attachmentId: string
  readonly mediaClass: MediaClass
  readonly kind: MediaKind
  readonly alg: AeadAlg
  /** Plaintext chunk size in bytes (the AEAD framing unit, e.g. 262144). */
  readonly chunkBytes: number
  readonly chunkCount: number
  readonly plaintextLength: number
  /** Per-chunk ciphertext hashes, ordered by `index`. */
  readonly chunks: readonly ChunkDigest[]
  /**
   * Root over the ordered chunk hashes. The crypto layer sets this to
   * SHA-256(rootPreimage(chunks)); this package only defines the preimage.
   */
  readonly rootSha256: Sha256Hex
  readonly mime: string
  /** Magic-byte detection result, if the sender ran it (detection beats claim). */
  readonly detectedSignature?: string
  readonly dims?: PixelDimensions
  readonly durationMs?: number
  /** EXIF orientation 1..8 for images, when known. */
  readonly orientation?: number
  /** Container descriptor for video/audio (polymorphic: webm or mp4). */
  readonly container?: ContainerDescriptor
  readonly viewOnce: boolean
  readonly createdAt: number
}

/**
 * The deterministic string the root hash is computed over. Pure and dependency-
 * free: the crypto layer hashes this with SHA-256 to obtain `rootSha256`, and a
 * verifier recomputes it to detect a reordered/added/dropped/truncated chunk.
 * Format is line-oriented and unambiguous: `index:ciphertextLength:sha256`.
 */
export function rootPreimage(chunks: readonly ChunkDigest[]): string {
  return chunks
    .map((c) => `${c.index}:${c.ciphertextLength}:${c.sha256}`)
    .join('\n')
}

export interface ManifestStructureResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

/**
 * Structural validation only (no hashing, no crypto): checks the manifest is
 * internally consistent — contiguous 0-based indexes, matching counts, sane
 * lengths, well-formed hex hashes. Whether the hashes are CORRECT is verified
 * later by the crypto layer after download.
 */
export function validateManifestStructure(m: MediaManifest): ManifestStructureResult {
  const errors: string[] = []
  if (m.v !== MEDIA_MANIFEST_VERSION) errors.push(`unsupported manifest version ${String(m.v)}`)
  if (!m.attachmentId) errors.push('attachmentId is required')
  if (m.chunkBytes <= 0) errors.push('chunkBytes must be positive')
  if (m.chunkCount < 0) errors.push('chunkCount must be non-negative')
  if (m.plaintextLength < 0) errors.push('plaintextLength must be non-negative')
  if (m.chunks.length !== m.chunkCount) {
    errors.push(`chunkCount ${m.chunkCount} does not match chunks.length ${m.chunks.length}`)
  }
  if (!SHA256_HEX.test(m.rootSha256)) errors.push('rootSha256 is not a hex SHA-256')
  for (let i = 0; i < m.chunks.length; i++) {
    const c = m.chunks[i]!
    if (c.index !== i) errors.push(`chunk ${i} has non-contiguous index ${c.index}`)
    if (c.ciphertextLength <= 0) errors.push(`chunk ${i} ciphertextLength must be positive`)
    if (!SHA256_HEX.test(c.sha256)) errors.push(`chunk ${i} sha256 is not a hex SHA-256`)
  }
  return { ok: errors.length === 0, errors }
}
