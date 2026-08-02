import {
  generateNotifKeypair,
  sealRichPayload,
  unsealRichPayload,
} from '../../src/notifications/envelope/notif-crypto';
import { RichNotificationPayload, SealedEnvelope } from '../../src/notifications/envelope/rich-payload.types';

/**
 * Seal/unseal with TEST-generated keys (no persisted device key anywhere). This
 * exercises the gated encrypted-payload construction: X25519 ECDH-ES →
 * HKDF-SHA256 → AES-256-GCM, the same family as e2e_v2, built on node:crypto
 * only. Nothing here runs in production unless BOTH flags are set (owner §12
 * sign-off) — these are the correctness proofs the review will need.
 */

const payload: RichNotificationPayload = {
  class: 'message',
  room: 'room-42',
  route: 'thread/room-42',
  actor: 'Alice',
  preview: '1 new message',
  count: 1,
  seq: 7,
  actions: ['reply', 'mute'],
};

describe('notif-crypto seal/unseal', () => {
  it('round-trips a rich payload to the exact plaintext for the right device key', () => {
    const device = generateNotifKeypair();
    const sealed = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    const opened = unsealRichPayload(device.privateKey, sealed, 'ntf_1');
    expect(opened).toEqual(payload);
  });

  it('produces a fresh ephemeral key each seal (no nonce/epk reuse)', () => {
    const device = generateNotifKeypair();
    const a = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    const b = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    expect(a.epk).not.toEqual(b.epk);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ct).not.toEqual(b.ct); // random salt+iv ⇒ different ciphertext
  });

  it('the sealed blob leaks no plaintext field (opaque to the provider)', () => {
    const device = generateNotifKeypair();
    const sealed = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    const asText = JSON.stringify(sealed);
    expect(asText).not.toContain('Alice');
    expect(asText).not.toContain('room-42');
    expect(asText).not.toContain('thread/');
    expect(asText).not.toContain('new message');
    // Only opaque, base64url members.
    expect(Object.keys(sealed).sort()).toEqual(['ct', 'epk', 'iv', 'salt', 'v']);
  });

  it('rejects the WRONG device private key (GCM auth failure)', () => {
    const device = generateNotifKeypair();
    const attacker = generateNotifKeypair();
    const sealed = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    expect(() => unsealRichPayload(attacker.privateKey, sealed, 'ntf_1')).toThrow();
  });

  it('rejects a blob replayed against a DIFFERENT notifId (AAD binding)', () => {
    const device = generateNotifKeypair();
    const sealed = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    expect(() => unsealRichPayload(device.privateKey, sealed, 'ntf_OTHER')).toThrow();
  });

  it('rejects a tampered ciphertext', () => {
    const device = generateNotifKeypair();
    const sealed = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    const bytes = Buffer.from(sealed.ct, 'base64url');
    bytes[0] ^= 0xff;
    const tampered: SealedEnvelope = { ...sealed, ct: bytes.toString('base64url') };
    expect(() => unsealRichPayload(device.privateKey, tampered, 'ntf_1')).toThrow();
  });

  it('rejects an unsupported envelope version', () => {
    const device = generateNotifKeypair();
    const sealed = sealRichPayload(device.publicKeySpki, payload, 'ntf_1');
    const bad = { ...sealed, v: 2 as unknown as 1 };
    expect(() => unsealRichPayload(device.privateKey, bad, 'ntf_1')).toThrow(/version/i);
  });

  it('refuses to seal without a device public key', () => {
    expect(() => sealRichPayload('', payload, 'ntf_1')).toThrow(/public key/i);
  });
});
