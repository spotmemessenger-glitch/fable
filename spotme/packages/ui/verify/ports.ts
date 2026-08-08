/**
 * Verify — ports (ADR-035 final slice, session 4, behind spotme.ui.verify).
 *
 * This is the RENDERING of views/verify.js, never its engine. Every crypto
 * value crosses this port pre-formatted as a display string, shaped by the
 * app-side adapter (views/verify-island.js) over the SAME lib/crypto modules
 * the legacy screen drives — safety-number derivation, the trust record,
 * accept/reject, QR encode/scan all stay app-side. This package never sees a
 * key, a payload, or a crypto module:
 *
 *   - `digits` is the already-formatted 60-digit safety number (a string of
 *     digit groups), not key material.
 *   - `qrUrl` is a data:image/svg+xml URL the adapter drew from the encoded
 *     payload; the payload itself never arrives here.
 *   - trust/scan verdicts arrive as finished sentences (`banner`, `scan.status`).
 *
 * ADR-008 §12 stays untouched by construction: nothing here can generate,
 * persist, or publish anything — there is no storage, no network, no crypto
 * import to do it with (packages/ui fence).
 */

export type VerifyPhase = 'missing' | 'unverifiable' | 'loading' | 'ready' | 'error';

export interface VerifySnapshot {
  phase: VerifyPhase;
  /** Display name only — used to address the person in the on-screen copy. */
  peerName: string;
  /** Full app-shaped sentence for the missing / unverifiable / error phases. */
  message: string;
  /** The stored trust verdict (legacy trustLine), or null to hide it. */
  banner: { warn: boolean; text: string } | null;
  /** Present exactly when the peer's key CHANGED and needs a decision; the
   *  note explains what sending does while undecided (enforcement-aware). */
  changed: { note: string } | null;
  /** Formatted 60-digit safety number — a display string, never raw keys. */
  digits: string;
  /** This device's QR as a data: URL (app-encoded, refreshed app-side). */
  qrUrl: string | null;
  scan: { available: boolean; status: string; scanning: boolean };
  /** Closing paragraph — enforcement-aware, so the sentence is decided
   *  app-side (legacy: the isEnforcing() branch). Empty string hides it. */
  footer: string;
}

export interface VerifyPort {
  subscribe(fn: () => void): () => void;
  /** MUST return a cached object, invalidated on notify (useSyncExternalStore). */
  snapshot(): VerifySnapshot;
  back(): void;
  /** CHANGED-key resolutions — legacy A5 semantics, executed app-side. */
  acceptNewKey(): void;
  keepOldKey(): void;
  /** Camera + decode + payload verification are entirely app-side; results
   *  come back as scan.status / banner sentences. */
  startScan(): void;
}

/** Fixture port for tests. */
export function fixtureVerifyPort(
  over?: Partial<VerifySnapshot>,
): VerifyPort & { calls: string[]; setSnapshot: (next: VerifySnapshot) => void } {
  let snap: VerifySnapshot = {
    phase: 'ready',
    peerName: 'Asha',
    message: '',
    banner: null,
    changed: null,
    digits: '12345 67890 11223 34455 56677 88990 12345 67890 11223 34455 56677 88990',
    qrUrl: 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E',
    scan: { available: true, status: '', scanning: false },
    footer: 'Spot Me remembers a successful check on this device.',
    ...over,
  };
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  return {
    calls,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot: () => snap,
    back: () => calls.push('back'),
    acceptNewKey: () => calls.push('accept'),
    keepOldKey: () => calls.push('reject'),
    startScan: () => calls.push('scan'),
    setSnapshot(next) { snap = next; for (const fn of listeners) fn(); },
  };
}
