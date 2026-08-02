# Security review — why NO cryptographic behaviour changes (P2D)

**Claim under review:** the adaptive network production layer changes zero
cryptographic behaviour, moves zero key material, and cannot leak plaintext —
while every flag is off AND after any future activation, up to the explicitly
gated seal-lift.

## 1. The opaque-envelope argument

1. Every unit the layer moves is a `SealedEnvelope`: ciphertext is opaque
   bytes/base64 the layer never parses (INV-2). The envelope codec
   (`adapter-kit.js`) copies ciphertext through byte-identically and its
   round-trip test proves bit-identity for text AND binary.
2. `assertSealedBeforeSend` (INV-6) runs at the supervisor's single send
   choke point, at the migration re-send path, at the drain's submit, and at
   EVERY adapter's send — five independent throws between a plaintext object
   and any wire. Tests drive each.
3. No object in the layer exposes a key surface (INV-1, ADR-002's
   FORBIDDEN_KEY_SURFACE, asserted over every factory product) or a crypto
   op (INV-3). The generalised contract check `assertImplementsITransport`
   rejects any adapter that grows one.
4. Identifiers (envelopeId, frameId, ack ids, discovery ids) derive from
   routing metadata + ciphertext digests only (INV-4) — asserted, including
   over the new ack-frame shape.
5. Mesh relays forward ciphertext bit-identically (INV-5) — now proven not
   just for one `forward()` call but END-TO-END across a 4-hop line of real
   engines (the multi-hop test compares every byte at arrival).

## 2. INV-1..6 status

| Invariant | Status in production layer | Evidence |
|---|---|---|
| INV-1 keys never cross | HOLDS | contract asserts + fence: adapters reach live modules only lazily; no key-shaped member anywhere |
| INV-2 payload opacity | HOLDS | codec round-trip; makeSealedEnvelope refusal of cleartext fields; scaffold tests unchanged |
| INV-3 supervisor never seals/opens | HOLDS | assertNoSealSurface over pipeline/tracker/engines; no crypto import in the layer |
| INV-4 opaque id inputs | HOLDS | scaffold test + ack-frame key-set test |
| INV-5 relay preserves ciphertext | HOLDS (multi-hop) | 4-hop bit-identity + tamper tests from scaffold |
| INV-6 no unsealed send | HOLDS | five choke points, each with a refusal test |

## 3. The seal-lift is untouched — the load-bearing deferral

- `seal-boundary.js` is byte-identical to the scaffold: `seal()`/`open()`
  THROW; `SEAL_LIFT_STATUS.implemented === false`.
- `assertSealLiftNotImplemented` is asserted in BOTH `adaptive-scaffold.test.js`
  (unchanged) and the new fence suite — this PR provably did not implement it.
- Consequence, stated where wiring will read it (network.js header,
  activation guide step 0): **chat over any NEW transport (BLE, LAN, mesh,
  Centrifugo) cannot activate** until P1 activation delivers sealed frames
  above the transport, because today's chat sealing lives inside
  socket-transport.js. The SocketIO adapter is the one transport that can
  carry supervisor envelopes safely TODAY, precisely because the existing
  room seal wraps them below (double-wrapped, both layers opaque here).
- `transport/room.js`'s loud Centrifugo fallback and
  `transport-seam.test.js`'s plaintext tripwire are unchanged.

## 4. Existing-file surface audit

| File | Change | Crypto relevance |
|---|---|---|
| `web/src/lib/db.js` | +1 wipe-list line + comment | none — deletes a (today nonexistent) IndexedDB by name; improves post-activation privacy |
| `web/package.json` | test invocations | none |
| `web/src/lib/transport-supervisor/outbox.js` | additive `get()` | none — read-only lookup |
| `web/src/lib/transport-supervisor/index.js` | barrel exports + header | none — pure re-exports |
| everything else | new files | dark, unwired, fence-tested |

Frozen files verified untouched: `socket-transport.js`, `transport/*` (all),
`reach.js`, `net.js`, `views/bluetooth.js`, all `crypto/`, notifications,
translation, live-voice (`git diff` against the branch base shows no edits).

## 5. Residual risks the reviewer should carry forward

1. **Wire JSON growth.** The envelope wire adds `origin` + ordering counters
   to what crosses inside the sealed room action. This is routing metadata
   the server-side already infers (sender, ordering), and it rides INSIDE
   the room seal on the socket path — no new server-visible surface. On
   FUTURE keyless transports it is relay-visible routing metadata; the
   threat-model update §2 prices it.
2. **Reputation ≠ trust** must stay true in wiring: no code may branch on
   reputation for anything but neighbour ordering. The threat model (T12)
   and the module header both say so; a review gate item in the checklist.
3. **The db.js wipe line runs before activation** — intentionally; it must
   never be "cleaned up" as dead code, or activation re-opens the wipe gap.
