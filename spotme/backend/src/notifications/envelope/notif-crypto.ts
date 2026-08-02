/**
 * Notification payload SEAL/UNSEAL — the cryptographic core of the gated
 * encrypted-envelope upgrade (design §4.2). Built on Node's `crypto` ONLY (no
 * hand-rolled primitives): X25519 ECDH-ES → HKDF-SHA256 → AES-256-GCM — the
 * SAME ephemeral-static sealed-box construction FAMILY as e2e_v2, INDEPENDENTLY
 * implemented here with ZERO shared code or imports with the Priority-1 crypto
 * (the isolation fence asserts this). It is a separate, notification-scoped key
 * hierarchy; nothing here touches signing/ratchet/x3dh/prekey/e2e.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KEY CUSTODY (the property the ADR-008 §12 review turns on)
 * ─────────────────────────────────────────────────────────────────────────────
 *   • The DEVICE generates its own notification keypair. In production that is
 *     WebCrypto `subtle.generateKey({name:'X25519'}, extractable=false, …)` so
 *     the PRIVATE half is NON-EXTRACTABLE and never leaves the device.
 *   • ONLY the PUBLIC half (`publicKeySpki`) is ever registered server-side.
 *   • The SERVER holds NO device private key. `sealRichPayload` generates a
 *     fresh EPHEMERAL keypair per seal and discards its private half on return —
 *     so there is no persisted notification private key anywhere on the server.
 *
 * `generateNotifKeypair` / `unsealRichPayload` model the DEVICE side; they exist
 * for tests and as executable documentation of the exact construction. The
 * server-side send path calls only `sealRichPayload`.
 *
 * ⚠️  ACTIVATION IS GATED. These functions are reachable in production ONLY
 * through `EncryptedEnvelopeBuilder`, which refuses unless BOTH
 * `NOTIFICATIONS_V2_ENABLED` and `NOTIF_ENCRYPTED_PAYLOAD_ENABLED` are set — and
 * flipping that sub-flag on requires the owner's ADR-008 §12 security-review
 * sign-off (a public wrapping-key registration must be ruled NOT "key
 * publication" in the §12 sense). See docs/priority-2/security-review-encrypted-payload.md.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  KeyObject,
} from 'node:crypto';
import { RichNotificationPayload, SealedEnvelope } from './rich-payload.types';

/**
 * Domain-separation label. Binds every derived key to THIS construction so a
 * notification key can never be confused with an e2e_v2/ratchet key, even by
 * accident. It is a local string constant — NOT a symbol shared with the P1
 * crypto (the fence forbids such an import).
 */
const HKDF_INFO = Buffer.from('spotme/notif-seal/v1');
const AAD_PREFIX = 'spotme/notif-seal/v1|';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM nonce
const SALT_BYTES = 16; // HKDF salt
const TAG_BYTES = 16; // GCM tag
/** Reject an absurd plaintext early — a notification payload is tiny. */
const MAX_PLAINTEXT_BYTES = 4 * 1024;

export interface NotifKeypair {
  /** base64 SPKI DER — the ONLY half registered server-side. */
  readonly publicKeySpki: string;
  /** Stays on the device (non-extractable in prod); in tests, in-memory only. */
  readonly privateKey: KeyObject;
}

/**
 * Generate an X25519 notification keypair. PRODUCTION runs this ON THE DEVICE
 * (non-extractable private key) and sends only `publicKeySpki`. Provided here
 * for tests and as executable documentation; the server never calls it for a
 * device key.
 */
export function generateNotifKeypair(): NotifKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKeySpki: exportSpki(publicKey, 'base64'),
    privateKey,
  };
}

/** Export an X25519 public KeyObject as SPKI DER in the requested encoding. */
function exportSpki(key: KeyObject, enc: 'base64' | 'base64url'): string {
  return key.export({ type: 'spki', format: 'der' }).toString(enc);
}

/** Import an X25519 public key from SPKI DER bytes. Throws on malformed input. */
function importSpkiPublic(der: Buffer): KeyObject {
  return createPublicKey({ key: der, type: 'spki', format: 'der' });
}

/** HKDF-SHA256(sharedSecret, salt, info) → 32-byte AES key. */
function deriveKey(shared: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, KEY_BYTES));
}

/**
 * Additional authenticated data. Binds the ciphertext to its outbox-row handle
 * so a sealed blob cannot be replayed against a different notification. Both
 * sides know `notifId` from the cleartext `data.n` field, so no extra channel is
 * needed (the class rides inside the authenticated plaintext).
 */
function aadFor(notifId: string): Buffer {
  return Buffer.from(AAD_PREFIX + notifId, 'utf8');
}

/**
 * SEAL a rich payload to the device's public key. ECDH-ES(ephemeral, devicePub)
 * → HKDF → AES-256-GCM. The ephemeral private key is created here and discarded
 * on return; the server persists no notification private key.
 */
export function sealRichPayload(
  devicePublicKeySpki: string,
  payload: RichNotificationPayload,
  notifId: string,
): SealedEnvelope {
  if (!devicePublicKeySpki) throw new Error('notif-crypto: missing device public key');
  const devicePub = importSpkiPublic(Buffer.from(devicePublicKeySpki, 'base64'));

  const pt = Buffer.from(JSON.stringify(payload), 'utf8');
  if (pt.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('notif-crypto: payload too large to seal');
  }

  // Ephemeral X25519 keypair — the "eph" of ECDH-ES. Discarded when this
  // function returns; never stored.
  const eph = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: devicePub });
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(shared, salt);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(notifId));
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    epk: exportSpki(eph.publicKey, 'base64url'),
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    ct: Buffer.concat([ct, tag]).toString('base64url'),
  };
}

/**
 * UNSEAL — the DEVICE side, for tests and reference. Production runs this on the
 * device with its non-extractable private key. Throws on ANY authentication
 * failure (wrong key, tampered blob, bad version) so a foreign/corrupt blob
 * degrades to the content-less fallback rather than rendering attacker text.
 */
export function unsealRichPayload(
  devicePrivateKey: KeyObject,
  sealed: SealedEnvelope,
  notifId: string,
): RichNotificationPayload {
  if (sealed.v !== 1) throw new Error('notif-crypto: unsupported envelope version');
  const ephPub = importSpkiPublic(Buffer.from(sealed.epk, 'base64url'));
  const shared = diffieHellman({ privateKey: devicePrivateKey, publicKey: ephPub });
  const salt = Buffer.from(sealed.salt, 'base64url');
  const key = deriveKey(shared, salt);
  const iv = Buffer.from(sealed.iv, 'base64url');

  const ctTag = Buffer.from(sealed.ct, 'base64url');
  if (ctTag.length <= TAG_BYTES) throw new Error('notif-crypto: ciphertext too short');
  const ct = ctTag.subarray(0, ctTag.length - TAG_BYTES);
  const tag = ctTag.subarray(ctTag.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aadFor(notifId));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as RichNotificationPayload;
}
