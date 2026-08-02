/**
 * The RICH notification payload — the plaintext the GATED encrypted envelope
 * seals to a per-device notification key so ONLY the device can read it while
 * the push provider (FCM/APNs/Mozilla) stays blind (design §4.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT MESSAGE CONTENT.
 * ─────────────────────────────────────────────────────────────────────────────
 * The server cannot read E2E message plaintext, so it is not — and can not be —
 * here. These are the ROUTING + SERVER-KNOWN DISPLAY fields the content-less
 * floor deliberately omits from the wire (room, route, actor, coalesced count):
 * richer than the floor, still never the message bytes. `preview` is a GENERIC
 * catalog string ("1 new message"), never message text — the type has no field
 * that could hold decrypted content.
 */
export interface RichNotificationPayload {
  /** Notification class (message|call|mention|…). */
  readonly class: string;
  /** Opaque room id — routing only; the floor hides it, this reveals it to the DEVICE. */
  readonly room?: string;
  /** Deep-link route the device opens on tap (a screen the recipient already owns). */
  readonly route?: string;
  /** Server-known display name of the actor (room membership), never message text. */
  readonly actor?: string;
  /** GENERIC preview — e.g. "1 new message". NEVER the message body. */
  readonly preview: string;
  /** Coalesced event count (for "3 new messages"). */
  readonly count: number;
  /** Event seq for client ordering (optional). */
  readonly seq?: number;
  /** The set of typed actions the device may render (reply/mute/accept/…). */
  readonly actions?: readonly string[];
}

/**
 * The sealed envelope placed OPAQUELY in the transport `data.e` field. Every
 * member is base64url of random / ciphertext bytes — the provider sees only
 * opaque blobs. Self-describing (`v`) so the construction can evolve without a
 * silent format break; the device rejects an unknown version and falls back to
 * the content-less floor.
 */
export interface SealedEnvelope {
  /** Construction version. */
  readonly v: 1;
  /** Ephemeral X25519 public key, SPKI DER, base64url (the "eph" of ECDH-ES). */
  readonly epk: string;
  /** HKDF-SHA256 salt, base64url. */
  readonly salt: string;
  /** AES-256-GCM nonce (12 bytes), base64url. */
  readonly iv: string;
  /** Ciphertext ‖ GCM tag, base64url. */
  readonly ct: string;
}
