import { webcrypto } from 'node:crypto';

/**
 * Server-side mirror of the web transcript framing (ADR-006 §3a,
 * `web/src/lib/crypto/signing-identity.js`). The framing is LENGTH-PREFIXED,
 * NOT DELIMITED: every part is `uint32be(length) || bytes` under a leading
 * `uint32be(part count)`, so no field boundary can move without changing the
 * signed bytes. JSON and delimiter-joins are forbidden for signed structures
 * (#29 review, revision 1) — `["ab","c"]` and `["a","bc"]` must not encode
 * identically.
 *
 * Kept deliberately narrower than the web module: the server only ever
 * VERIFIES, only over string fields, and only for the supersession domain.
 * The cross-implementation guarantee is pinned by a fixed byte vector asserted
 * in BOTH suites (`test/signing-keys.e2e-spec.ts` here,
 * `web/test/signing-key-publication.test.js` there) — if either side drifts,
 * one of the two vectors breaks.
 */

export const SUPERSEDE_DOMAIN = 'spotme-signing-supersede-v1';

const MAX_FIELD_BYTES = 64 * 1024;
const MAX_FIELDS = 64;

export function transcript(domain: string, fields: string[]): Uint8Array {
  if (!domain) throw new Error('a transcript needs a domain');
  if (fields.length > MAX_FIELDS) throw new Error('too many transcript fields');
  const enc = new TextEncoder();
  const parts = [enc.encode(domain), ...fields.map((f) => enc.encode(f))];
  for (const p of parts) {
    if (p.length > MAX_FIELD_BYTES) throw new Error('transcript field too long');
  }
  let total = 0;
  for (const p of parts) total += 4 + p.length;
  const out = new Uint8Array(4 + total);
  const view = new DataView(out.buffer);
  view.setUint32(0, parts.length, false);
  let at = 4;
  for (const p of parts) {
    view.setUint32(at, p.length, false);
    at += 4;
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const ED25519 = 'Ed25519';
export const ECDSA_P256 = 'ECDSA-P-256';

/** Raw public-key lengths per algorithm. `algo` is REQUIRED, never inferred
 *  from length — Ed25519 and X25519 are both 32 bytes, and importing an
 *  AGREEMENT key as a SIGNING key is the silent cross-protocol failure the
 *  web module documents. The same rule holds here. */
export const RAW_LEN: Record<string, number> = {
  [ED25519]: 32,
  [ECDSA_P256]: 65,
};

const SIG_LEN = 64;

const importParams = (algo: string) =>
  algo === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
const verifyParams = (algo: string) =>
  algo === ED25519 ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };

/**
 * Verify a supersession signature. EVERY failure — bad base64, wrong length,
 * unknown algo, unimportable key, genuine mismatch — funnels to `false`, same
 * as the web module's `verifyBytes`: a verifier that throws pushes callers
 * into `try { } catch { }`, one careless edit away from "accepted".
 *
 * This is a COHERENCE check, not a trust claim — the server stays the
 * adversary in the threat model and clients verify chains themselves when
 * they consume them. Checking here merely keeps the ledger from accepting
 * garbage it would then serve.
 */
export async function verifySupersession(
  oldPublicKeyB64: string,
  oldAlgo: string,
  bytes: Uint8Array,
  sigB64: string,
): Promise<boolean> {
  try {
    if (!RAW_LEN[oldAlgo]) return false;
    const raw = Buffer.from(oldPublicKeyB64, 'base64');
    if (raw.length !== RAW_LEN[oldAlgo]) return false;
    const sig = Buffer.from(sigB64, 'base64');
    if (sig.length !== SIG_LEN) return false;
    const key = await webcrypto.subtle.importKey(
      'raw',
      raw,
      importParams(oldAlgo) as EcKeyImportParams,
      false,
      ['verify'],
    );
    return await webcrypto.subtle.verify(
      verifyParams(oldAlgo) as EcdsaParams,
      key,
      sig,
      bytes as BufferSource,
    );
  } catch {
    return false;
  }
}
