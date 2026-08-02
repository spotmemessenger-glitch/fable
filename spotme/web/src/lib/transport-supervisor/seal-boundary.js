/**
 * Spot Me — the SEAL BOUNDARY. Priority 2, ADR-012 addendum. SCAFFOLDING ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEAL-LIFT IS DEFERRED. THIS FILE DEFINES THE BOUNDARY; IT DOES NOT MOVE
 * ANY CRYPTO. Read before touching anything crypto-adjacent.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHERE SEALING LIVES TODAY. transport/room.js documents it exactly: AES-GCM
 * seal/open live INSIDE socket-transport.js (`sendAction`/`dispatch`), BELOW the
 * adapter. So for Socket.IO the crypto sits UNDER the transport and all is well;
 * a keyless transport (Centrifugo) has no seal step, which is why room.js refuses
 * to route chat through it — publishing raw would send plaintext (the V-19
 * failure). ADR-002 §2 says adapters carry opaque bytes and sealing happens
 * ABOVE them; the code does not yet match that, and reconciling them is the
 * "seal-lift".
 *
 * WHAT THE SEAL-LIFT WOULD DO. Move seal/open ABOVE the transport, so EVERY
 * transport — Socket.IO, Centrifugo, and Bluetooth mesh — receives an
 * already-sealed SealedEnvelope and can be keyless. That is the precondition for
 * the adaptive layer to switch transports safely: you cannot let the selector
 * hand a room to the mesh while sealing still lives inside socket-transport.js,
 * or the mesh would carry plaintext.
 *
 * WHY IT IS DEFERRED, NOT DONE HERE.
 *   - It is CRYPTO-ADJACENT: it relocates the AES-GCM seal, a change to how and
 *     where encryption happens. The build brief for this scaffolding PR forbids
 *     implementing it.
 *   - It is a REAL REFACTOR of the message layer (room.js §1), not a wiring
 *     change — createNet needs per-type channels, binary sends with progress,
 *     request/response, and live streams that the narrow contract does not model.
 *   - It is GATED ON PRIORITY 1 ACTIVATION. The ADR-008 §12 hard stop (no
 *     signing-key generation/persistence/publication, prekeys, X3DH, ratchet, or
 *     multi-device until rollback-after-publication is executable or separately
 *     authorised) governs the crypto this lift would sit on top of. Until P1 is
 *     active and rollback-after-publication is executable, the seal stays where
 *     it is.
 *
 * So this file gives the boundary a NAME and a SHAPE and nothing else. The
 * sealer it hands back THROWS — the interface exists, the behaviour does not.
 */

/** Machine-readable status so a test/report can assert "still deferred". */
export const SEAL_LIFT_STATUS = Object.freeze({
  implemented: false,
  phase: 'ADR-012 seal-lift',
  gate: 'Priority 1 activation + rollback-after-publication executable (ADR-008 §12)',
  today: 'AES-GCM seal/open live inside socket-transport.js, BELOW the transport (transport/room.js)',
  deferredReason: 'crypto-adjacent relocation of the AES-GCM seal; a message-layer refactor, not wiring'
})

/**
 * The interface an ISealer WOULD implement, ABOVE the transport:
 *   seal(roomId, plaintextBytes) -> Promise<ciphertextBytes>
 *   open(roomId, ciphertextBytes) -> Promise<plaintextBytes>
 * ITransport.send() consumes ONLY the ciphertext side of this — it never sees
 * plaintext or the key, which is the whole point of lifting the seal above it.
 */
export const SEALER_METHODS = Object.freeze(['seal', 'open'])

/** A marker so callers/tests can positively identify the deferred stub. */
export const DEFERRED_SEALER = Symbol('spotme.sealLift.deferred')

/**
 * Return the boundary as an object whose crypto methods THROW.
 *
 * This is the crux of "define the interface, do not implement the behaviour":
 * the shape is present so the supervisor's types line up and tests can assert
 * the contract, while any attempt to actually seal or open fails loudly with the
 * reason it is deferred. It holds NO key material and performs NO crypto.
 */
export function createDeferredSealer () {
  const refuse = (op) => () => {
    throw new Error(
      `seal-lift is DEFERRED: ${op}() is not implemented. Moving AES-GCM seal/open ` +
      'above the transport is gated on Priority 1 activation and rollback-after-' +
      'publication being executable (ADR-008 §12; ADR-012 addendum). ' +
      'Do NOT implement it in the adaptive-transport scaffolding.'
    )
  }
  return Object.freeze({
    [DEFERRED_SEALER]: true,
    seal: refuse('seal'),
    open: refuse('open')
  })
}

/**
 * Assert the sealer really is the deferred, non-functional boundary — used by
 * the invariant tests to PROVE the seal-lift has not been implemented. Encoding
 * the deferral as an executable check is what stops it drifting into existence
 * unnoticed.
 */
export function assertSealLiftNotImplemented (sealer) {
  if (!sealer || sealer[DEFERRED_SEALER] !== true) {
    throw new Error('seal boundary: expected the DEFERRED sealer stub; a real sealer must not appear in scaffolding')
  }
  for (const op of SEALER_METHODS) {
    let threw = false
    try { sealer[op]('room', new Uint8Array([1])) } catch { threw = true }
    if (!threw) throw new Error(`seal boundary: ${op}() did not throw — the seal-lift appears implemented, which is forbidden here`)
  }
  if (SEAL_LIFT_STATUS.implemented !== false) {
    throw new Error('seal boundary: SEAL_LIFT_STATUS.implemented must be false in scaffolding')
  }
  return true
}
