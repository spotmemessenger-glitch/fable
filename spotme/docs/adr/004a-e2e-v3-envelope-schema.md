# e2e_v3 — envelope schema and compatibility package

**Companion to ADR-004 (PROPOSED). Design only; no production code.**
Status: **awaiting review.** Nothing here is implemented, and PR #15 stays
unmerged until it is reviewed.

ADR-004 chose *whether* to build a ratchet and *with what*. This document
specifies *what goes on the wire*, how it coexists with `e2e_v1` and `e2e_v2`,
and how an implementation would be proved correct. Every hex value in §10 was
computed by running the derivation, not composed by hand.

---

## 1. What already ships, so the delta is visible

The current frame the client emits (`socket-transport.js`):

```js
{ roomId, type, payload, meta, target, attachId }
```

- `payload` — base64 of `IV(12) || AES-GCM ciphertext||tag`
- `meta` — routing only: `{ id, seq, total, cm, once?, burn? }`, where `cm` is
  the sealed envelope JSON. The server reads `id/seq/total`; `cm` it cannot open.
- Room key: `e2e_v1` = PBKDF2 over the cyrb53 secret · `e2e_v2` = X25519 ECDH +
  HKDF, room-bound (ADR-001).
- `e2eVersion` is **per conversation**, stored client-side, decided at creation.

**v3 changes `payload` only.** `roomId`, `type`, `meta`, `target` and `attachId`
keep their exact current meaning, so **no server schema change and no database
migration is required** for the message path. The prekey tables in ADR-004 §8
are additive and independent of this.

## 2. The v3 payload

```
payload = base64(
    MAGIC   u8      0x53                'S'
    VERSION u8      0x03
    HDRLEN  u16 BE  byte length of HEADER
    HEADER  [HDRLEN]
    IV      [12]    AES-GCM nonce
    CT      [..]    ciphertext || 16-byte GCM tag
)
```

`HEADER` is **cleartext and authenticated** — the receiver must read the ratchet
public key and counters *before* it can derive the key that decrypts `CT`, so the
header cannot live inside the ciphertext. It is bound with AES-GCM
`additionalData` instead (§6), which makes it unmodifiable without breaking the
tag.

### HEADER

```
  FLAGS   u8       bit0 = X3DH prologue present; bits 1-7 MUST be 0
  SDEV    [16]     sender device id
  RDEV    [16]     intended recipient device id
  DH      [32]     sender's current ratchet public key (X25519, raw)
  PN      u32 BE   length of the previous sending chain
  N       u32 BE   message number within the current chain
  --- present only when FLAGS bit0 is set: ---
  IK      [32]     sender long-term identity public key (X25519, raw)
  EK      [32]     sender ephemeral key (X25519, raw)
  SPKID   u32 BE   which of the recipient's signed prekeys was used
  OPKID   u32 BE   which one-time prekey; 0xFFFFFFFF = none was available
```

**Steady state: 73 bytes. With prologue: 145 bytes.** Against a ~40-byte
overhead today, v3 costs **+33 bytes** per message in steady state — about 0.02%
of a 128 KB attachment slice, and roughly a 25% overhead on a short text
message. Stated so the cost is a decision rather than a discovery.

## 3. Field-by-field justification

| Field | Why it exists | What breaks without it |
|---|---|---|
| `MAGIC` | Distinguishes a v3 payload from a v1/v2 one whose first byte is a random IV byte | Nothing immediately — §7 makes room state authoritative — but a mis-routed frame fails with an opaque GCM error instead of a clear parse refusal |
| `VERSION` | In-band version, and it is inside the AAD | An attacker could re-frame a v3 payload as a future version to trigger different parsing |
| `HDRLEN` | The header is variable-length (prologue or not) | The IV offset would be ambiguous; a receiver could be steered to read key material as ciphertext |
| `FLAGS` | One bit, explicit, reserved bits **must** be zero | An implicit "prologue if length is 145" rule makes length a control field, and length is attacker-chosen |
| `SDEV` | Which of the sender's devices produced this | Multi-device is impossible to add later without a format change (§9) |
| `RDEV` | Which device this was sealed for | A second device cannot tell "not for me" from "corrupt", and would raise a false key-mismatch alarm on every message |
| `DH` | The Double Ratchet public key; its change is what triggers a DH step | No forward secrecy — this is the mechanism |
| `PN` | Previous chain length, so a receiver knows how many skipped keys to derive across a ratchet step | Messages that arrive after a ratchet step but were sent before it are permanently undecryptable |
| `N` | Position in the current chain | Out-of-order and dropped messages cannot be resolved |
| `IK` | Sender's long-term identity, for X3DH | The receiver cannot authenticate who initiated |
| `EK` | Sender's ephemeral, for X3DH | No forward secrecy on the *initial* message |
| `SPKID` | Names the signed prekey used | After rotation the receiver cannot tell which private key to use, and every rotation breaks in-flight initial messages |
| `OPKID` | Names the one-time prekey, or says none was used | Without the "none" sentinel, prekey exhaustion is indistinguishable from prekey 0 — a silent downgrade of the initial message's forward secrecy |

**Not included, deliberately:** no timestamp (the server already sees arrival
time; an in-envelope one adds a lie surface and nothing else), no sender userId
(`SDEV` plus the session identifies it, and the server already knows), and no
plaintext length (it is recoverable after decryption and leaks size before it).

## 4. Device and session identifiers

**`deviceId`** — 16 random bytes, generated once per install, stored beside the
identity key in IndexedDB, published with the prekey bundle. Not derived from
hardware: a derived id is a fingerprint, and this one is disclosed to peers.

**`sessionId`** — **never transmitted.** Local IndexedDB key only:

```
sessionId = HKDF-SHA256(root_key, salt=0^32, info="spotme/e2e_v3/session-id", 16)
```

Derived rather than random so both sides independently agree on it, and so a
session cannot be confused with another between the same pair of devices.

**Session state stored per `sessionId`:** root key, sending chain key + counter,
receiving chain key + counter, the peer's current `DH`, `PN`, and the skipped
message keys (§5).

## 5. Prekey and ratchet metadata

**Bundle published to the server** (ADR-004 §8 tables, unchanged here):

```
{ userId, deviceId, ik: <32B pub>, spk: { id, pub, sig }, opks: [{ id, pub }] }
```

`sig` is Ed25519 over `IK || SPK`, verified by the fetcher before any DH.
ADR-004 verified Ed25519 generates natively in WebCrypto, so no polyfill.

**Skipped message keys.** A hard bound, per ADR-004's non-negotiable mitigations:

- `MAX_SKIP_PER_CHAIN = 1000` — a header claiming `N` further ahead than this is
  **refused**, not honoured. Without a bound, a single forged header with
  `N = 2^32-1` makes the client derive four billion keys: a trivial remote DoS.
- `MAX_SKIPPED_STORED = 2000` per session, evicted oldest-first.
- Skipped keys expire after **7 days**; an unarrived message past that is
  undecryptable, which is the forward-secrecy property working as designed.

**Every one of those three limits is a message-loss policy, not a tuning knob.**
Crossing them loses messages permanently and the UI must say so, using the
existing undecryptable surface rather than failing silently.

**Eviction order is FIFO — oldest skipped key first — and that is Spot Me's
decision, not an inherited one.** The reference implementation selected in
`004c` also evicts FIFO, but an implementation choosing LRU would diverge while
both looked correct, so it is stated here rather than discovered.

### 5a. Prekey-message representation

The X3DH prologue (`FLAGS` bit 0) is carried on **every message until the
sender has decrypted one from the recipient** — not only on the very first.

The reason is delivery, not cryptography. A prologue-bearing message may be
lost, delayed behind a push wake-up, or refused by a full mailbox; if only
message 0 carried it, the recipient would receive messages 1..n with no way to
establish the session and no way to ask for one. Repeating it costs 72 bytes per
message for the short window before the first reply.

The recipient treats a repeated prologue as **idempotent**: the first one
establishes the session, later ones with the same `EK` and `OPKID` are matched
to the existing session rather than establishing a second. A prologue with a
*different* `EK` is a new session — that is a legitimate re-initiation after the
peer lost state, and it resets the ratchet rather than failing.

**One-time prekey consumption is atomic and single-use.** The server deletes the
`OneTimePreKey` row in the same transaction that serves the bundle; two fetchers
never receive the same `OPKID`. When the pool is exhausted the bundle is served
without one and `OPKID = 0xFFFFFFFF`, which is weaker but functional — and the
sentinel makes the degradation visible rather than silent.

### 5b. Replay and duplicate handling

Three distinct cases, deliberately separated because they warrant different
answers:

| Case | Detection | Response |
|---|---|---|
| **Duplicate within a live chain** | `N` is below the receiving chain counter and no skipped key is stored for it | Drop silently. The key was deleted on first use, so it *cannot* decrypt — this is the ratchet's own replay defence |
| **Replay of a message whose skipped key is still held** | Skipped key exists for `(DH, N)` | Decrypt **once**, then delete the key. A second delivery hits the case above |
| **Replay into a different room** | AAD mismatch | GCM tag failure (§6) |

**Message keys are deleted on use, so replay protection is a property of the
ratchet rather than a table we maintain.** There is deliberately no separate
seen-message-id set: it would be unbounded, and it would duplicate a guarantee
the construction already gives.

A duplicate must **not** advance the replay cursor differently from a first
delivery, and must not surface to the user. Vector 08 in `004b` pins the
rejection.

### 5c. Canonical serialization rules

Every multi-byte value in the header and AAD is **big-endian**. This is stated
because it is exactly the kind of detail that two implementations get differently
and neither notices until they interoperate.

- Integers: unsigned, big-endian, fixed width as declared in §2 (`u8`, `u16`, `u32`)
- Public keys: **raw** X25519, 32 bytes — never SPKI, never PEM, never base64
  inside the header
- `roomId` in the AAD: UTF-8 bytes of the id exactly as the client holds it, with
  no normalisation, no trimming and no case folding. It is an opaque identifier;
  normalising it would make two clients disagree about the AAD for ids that
  differ only in form
- No padding anywhere, and **no length prefix except `HDRLEN`**. Every other
  field is fixed width, so the header parses by offset
- Reserved `FLAGS` bits **must** be zero on send and are **refused** on receive
  (§7), so the encoding cannot be extended silently
- The payload is base64 **text** on the wire, matching v1/v2 — binary
  `Uint8Array` frames split socket.io packets and break the decoder, which is a
  bug this codebase has already paid for once

**Session state persisted to IndexedDB is not part of the wire format** and has
no canonical form: it is local, versioned by the app, and may change without a
protocol version bump. Vector 09 in `004b` pins that a round-trip preserves
skipped keys and both chain counters, which is the property that actually
matters.

### 5d. Legacy conversation migration

**There is none, and that is the design.**

`e2eVersion` is decided at room creation and never changes (§7). An `e2e_v1` or
`e2e_v2` room stays on its scheme for its whole life. Concretely:

- **No re-encryption of history.** v2 history is readable only with the v2 room
  key; re-encrypting it under a v3 session would require decrypting it all,
  holding it in memory, and rewriting every `RoomEvent` — with no forward-secrecy
  benefit, because the old ciphertext the server already holds does not go away.
- **No in-place upgrade of an existing room.** A room that changed version
  mid-life would have a history in two schemes and a cursor that cannot express
  the boundary.
- **The upgrade path is a new conversation.** Two peers who both support v3 get
  v3 on their *next* room. The existing one keeps working.
- **v1's known weakness is not fixed by v3** and is not meant to be: `e2e_v1`
  keys derive from `cyrb53` of two public ids and are server-recomputable (R3 in
  `10-PRIORITY-0-AUDIT.md`). Migrating those rooms would destroy their history,
  which is why R3 is *accepted* rather than open.

**What must be verified before v3 ships** is therefore not a migration but an
absence of one: that adding v3 changes nothing about how v1 and v2 rooms behave.
Compatibility tests 1 and 2 in §11 exist for exactly that, and they must run
against real v1 and v2 rooms rather than synthetic ones.

## 6. AAD — what the ciphertext is bound to

```
AAD = "spotme/e2e_v3" || 0x03 || roomId(utf8) || HEADER
```

This binds every message to its version, its room, and its full header. A frame
cannot be replayed into another room, re-versioned, or have its counters edited
— all of those change the AAD and the GCM tag fails.

`roomId` is included because the server routes by it and the server is the
adversary in this model: without it, a frame moved between two rooms that share
a session would still authenticate.

## 7. Version negotiation, and unknown versions

**Negotiation happens once, at room creation, and never again.**

```
if (flag off)                       -> e2e_v2
else if (no v3 bundle for peer)     -> e2e_v2
else if (X3DH fails to produce a session) -> e2e_v2, surfaced visibly
else                                -> e2e_v3
```

Fallback is **visible, never silent** — the pattern `reach.js` already uses.
A silent fallback is how `setRoomKey` alone let v2 rooms revert to v1 keys
(see the `setRoomKeyProvider` comment in `socket-transport.js`); the same
mistake must not be repeated one version up.

**Receiving a frame whose version is not the room's version:**

| Room state | Frame | Action |
|---|---|---|
| v3 | v3 | Normal path |
| v3 | v1/v2 (no magic) | **Refuse.** Do not decrypt. This is the downgrade attack (§8) |
| v1/v2 | v3 | **Refuse.** Surface as undecryptable |
| any | version > 3 | **Refuse.** Sender is on a newer build |
| v3 | `FLAGS` with a reserved bit set | **Refuse.** Unknown extension |

**Cursor behaviour for a refusal — this is the part that is easy to get wrong.**
`socket-transport.js` already distinguishes *repairable* failures (wrong key →
hold the cursor, re-agree, retry) from *unrepairable* ones (malformed JSON,
unregistered type → advance and move on), and `replay-cursor-hold.test.js` pins
it.

**A version mismatch is unrepairable.** Holding the cursor would stall the room
forever behind a frame this build can never read. So: **advance the cursor,
surface the gap.** A newer peer must not be able to freeze an older client's
history — which is exactly what holding would allow, at zero cost to the
attacker.

## 8. Downgrade protection

Four independent mechanisms, because any one of them can be wrong:

1. **Local room state is authoritative, the frame is only a parsing hint.** A v3
   room refuses a v1/v2 frame regardless of what the frame claims. The server
   cannot talk a client down a version.
2. **`e2eVersion` is monotonic.** `db.upsertConvo` must reject any write that
   lowers it. Today nothing enforces this, and it is a required change.
3. **The version is inside the AAD.** Re-framing a payload as another version
   fails the GCM tag.
4. **The signed prekey signature** binds `SPK` to `IK`, so a substituted bundle
   cannot establish a session as someone else. **This is only as strong as the
   identity key's authenticity, which is exactly what safety numbers (ADR-003,
   PR #12/#14) exist to give the user a way to check.** v3 does not replace
   that; it depends on it.

**What none of this protects against:** a peer who genuinely reinstalls and
publishes a new identity key is indistinguishable, to the protocol, from an
attacker substituting one. That is the TOFU gap R2 in `10-PRIORITY-0-AUDIT.md`,
still open, and v3 makes it *more* consequential rather than less.

## 9. Multi-device — what this format allows and what it does not

**Spot Me is effectively single-device today.** The identity key lives in
IndexedDB, non-extractable; a second install mints a new identity and there is
no sync. `SDEV`/`RDEV` are in the header so the format does not need to change
later — but **multi-device is not designed here and this document does not
deliver it.**

What would still be needed: fan-out encryption (one ciphertext per recipient
device, N sessions per conversation), a device list with its own authenticity
problem, per-device prekey bundles, and a policy for a device that is added
mid-conversation and has no history. That last one has no good answer that also
preserves forward secrecy — re-encrypting history to a new device defeats it.

**Until then:** `RDEV` is the sole known device of the peer, and a frame whose
`RDEV` does not match this device is ignored quietly rather than surfaced as an
error, so that adding devices later does not spray alarms on old clients.

## 10. Test vectors

Computed by running the derivations (`node:crypto`, X25519 + HKDF-SHA256).
Private keys are repeating bytes so they are unmistakably test-only.

**Reproduce them rather than trusting them:**

```
node spotme/docs/adr/004a-e2e-v3-vectors.mjs
```

That script is the source of every hex value below. It is deliberately **not**
in `npm test` — v3 is unapproved, and putting a spec-only artifact in the chain
would presume a decision that has not been made.

**Keys** — private `0x11`×32 etc., public derived:

```
alice_ik  pub = 7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13
alice_ek  pub = 0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20
bob_ik    pub = 7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14
bob_spk   pub = ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b
bob_opk   pub = 38ab664bd86f77d7e66bdd9ae0792913a94fd8b33a1260027e4b46c1f4884c67
```

**X3DH** — `SS = DH(IK_A,SPK_B) || DH(EK_A,IK_B) || DH(EK_A,SPK_B) || DH(EK_A,OPK_B)`:

```
DH1 = b21afd23cc289c5c693adc6d9c7198657e590320fa4dd7a0aaf606e441a2ea46
DH2 = 1fdc192faa0212a9aae7bb4f41b580227fd5ad3e5d777faae230dfe973f3e805
DH3 = d31a1338a14cf92083e61f66bf842151cf156318bcddc07e42443937c05dd640
DH4 = 25bed864771ea4f3d83d9fdaa0ebe218d9feca2ba8f9b4940d069e505ff91d31
```

**HKDF ladder** — salt is 32 zero bytes; labels are domain-separated:

```
label "spotme/e2e_v3/root"     root key  = a3ed97dda551a5c3f96a52f6e57c0ad9aab98d74e1ce3a4e43154302c4a78ac2
label "spotme/e2e_v3/chain"    root key' = c7266d479d2c1298dbe408feafc2ee3c9dea300a01218712dead712af9d90b87
                               chain key = e86220bb4e5e444be58723d09b628324bb2ed64f012f4989dd103fc77bd8119f
label "spotme/e2e_v3/msg/0"    msg key   = c4234af3fc1263c7acbfb2dddd5da81c88b3690637f021a9534a4f80756691f1
label "spotme/e2e_v3/chain/next" chain'  = 595d0f705b465ba74d74c5d9eb914b4ccf98912ad8d101ad6a2d5269a248bceb
```

**Header encoding** — `SDEV = 0xa1`×16, `RDEV = 0xb2`×16:

```
steady state (PN=3, N=7), 73 bytes:
00 a1×16 b2×16 0faa684e...78570f20 00000003 00000007

with prologue (SPKID=1, OPKID=42), 145 bytes:
01 a1×16 b2×16 0faa684e...78570f20 00000000 00000000
   7b4e909b...b0f73f13 0faa684e...78570f20 00000001 0000002a

prekeys exhausted — same as above but OPKID = ffffffff
```

**AAD**, `roomId = "dm_0123456789abcdef"`, 106 bytes, prefix:

```
73706f746d652f6532655f7633 03 646d5f30313233343536373839616263646566 00
"spotme/e2e_v3"            v3  "dm_0123456789abcdef"                  header...
```

**Full payload framing** (IV `0x9c`×12, 20 bytes of stand-in ciphertext), 109
bytes total:

```
5303 0049 [73-byte header] 9c9c9c9c9c9c9c9c9c9c9c9c eeee...
MAGIC/VER HDRLEN=73
```

**These vectors cover framing, AAD and the KDF ladder — not the ratchet.**
Chain-advance and skipped-key vectors must come from a reference implementation
and **do not exist yet**; producing them is a prerequisite for implementation,
not a follow-up. That is the single largest piece of unfinished work in this
document.

## 11. Compatibility test plan

Each of these must **fail against a deliberately broken build** to be worth
writing — the standard the existing suites are held to.

| # | Test | Must fail when |
|---|---|---|
| 1 | A v1 room's whole existing suite passes untouched | Any v3 code executes on a v1 path |
| 2 | A v2 room's whole existing suite passes untouched | Same, for v2 |
| 3 | A v3 frame delivered to a v2 room is refused and does **not** advance to a key fetch | The version check is missing |
| 4 | A v2 frame delivered to a v3 room is refused | **This is the downgrade test** |
| 5 | `e2eVersion` cannot be lowered by `upsertConvo` | The monotonic guard is absent |
| 6 | Flipping one bit of `HEADER` fails the GCM tag | The header is not in the AAD |
| 7 | Flipping `VERSION` fails the tag | Version is not in the AAD |
| 8 | Replaying a frame into another `roomId` fails the tag | `roomId` is not in the AAD |
| 9 | `N` beyond `MAX_SKIP_PER_CHAIN` is refused without deriving keys | The DoS bound is missing |
| 10 | Out-of-order delivery (2,1,4,3) decrypts all four | Skipped-key storage is wrong |
| 11 | A dropped message leaves the others readable | Chain advance is wrong |
| 12 | A duplicate is detected and not re-processed | Replay within a chain is possible |
| 13 | Messages across a DH ratchet step, delivered out of order, all decrypt | `PN` is unused or wrong |
| 14 | A frame for another `RDEV` is ignored quietly, not alarmed | Multi-device forward compatibility broken |
| 15 | `OPKID = 0xFFFFFFFF` establishes a session without a one-time prekey | Exhaustion is mishandled |
| 16 | Reserved `FLAGS` bits set → refused | Unknown extensions silently accepted |
| 17 | Cursor **advances** past a version-mismatch frame | A newer peer can freeze an older client's history |
| 18 | Differential vectors match a reference implementation | The ratchet is subtly wrong — **blocked on §10** |

Tests 1–17 are writable today against the design. **Test 18 is the one that
actually proves correctness, and it cannot be written until a reference
implementation is chosen.**

## 12. Rollout and rollback

Unchanged from ADR-004 §7, restated with the concrete flag:

- Flag: `localStorage['spotme.e2e3']`, **absent by default**; `'on'` is the only
  enabling value — the same shape as `spotme.media` in phase C.
- **Before rollout:** delete the module and the flag; nothing else references it.
- **After rollout:** flag off → new rooms resume at v2. **Existing v3 rooms keep
  working and cannot be downgraded** — their history would be unreadable. So
  removing v3 *code* strands those rooms permanently. **The flag is the
  rollback; code removal is not.**
- Server: the prekey tables are additive. Dropping them breaks new v3 sessions
  only, not existing ones.

## 13. Open questions for the owner

1. **§10's ratchet vectors do not exist.** Which reference implementation should
   they be generated from? This blocks test 18, and test 18 is the one that
   would catch a subtly wrong ratchet.
2. **+33 bytes per message in steady state, and +105 on the first.** Acceptable?
3. **`MAX_SKIP_PER_CHAIN = 1000` / 7-day expiry are message-loss policies.** Are
   those the numbers you want users to live with?
4. **v3 raises the stakes on TOFU key pinning (R2), which is still open.** Should
   pinning land before v3 rather than after?
5. ADR-004's prior question stands and is not answered here: **accept owning a
   ratchet, or defer forward secrecy and close Priority 1 at ADR-003?** This
   document specifies the format either way — it does not argue for building it.
