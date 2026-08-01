# e2e_v3 — ratchet vector package

**Companion to `004a` (schema) and `004c` (decisions). Design artifact; no
production code.** These are the vectors a future Spot Me ratchet must
reproduce. They exist so that correctness is *tested* rather than asserted.

---

## Reproducing them

```bash
pip install 'DoubleRatchet==1.3.0' 'X3DH==1.3.0'
python3 spotme/docs/adr/004b-e2e-v3-ratchet-vectors.py > vectors.json
diff vectors.json spotme/docs/adr/004b-e2e-v3-ratchet-vectors.json   # must be empty
```

**Nothing here is an asserted expected value.** The generator is committed, its
output is committed, and the two must agree. Verified byte-identical across
three consecutive runs:

```
sha256  2f4b1ec44e11c29d01bd2b887c0407f419ba3d6e1757293d0cd96df71cf316ad
```

Determinism comes from overriding `DiffieHellmanRatchet._generate_priv` with a
counter-driven KDF stream instead of `os.urandom`. Those keys are test-only by
construction. The X3DH half of the derivation is pinned separately in `004a`
§10, by `004a-e2e-v3-vectors.mjs`; this file is about the **ratchet**.

## Where the vectors come from, and what that does not mean

Generated with `DoubleRatchet 1.3.0` (Syndace, MIT) — selected in `004c` §2.

**Spot Me's own values are injected, not inherited**: the HKDF labels, the
associated-data construction, the AEAD framing and the skip bounds are all
supplied by the generator. The library contributes only the *algorithm* — when
the DH ratchet steps, how chains advance, how skipped keys are stored. That
split is what stops `e2e_v3` from silently becoming "whatever this library
does". See `004c` §2 for the full argument and the two behaviours already
flagged as ours to decide.

---

## The 14 vector groups

| # | Group | What it pins |
|---|---|---|
| 00 | `inputs` | Fixed shared secret, Bob's ratchet key, room id, device ids, labels, bounds |
| 01 | `session_establishment_and_first_message` | X3DH secret → initialised session → message 0, with full header, AAD and framed payload |
| 02 | `first_message_decrypts` | Bob initialises independently and recovers the plaintext |
| 03 | `send_chain_advancement` | Three further sends: `n` = 1,2,3 with **`ratchet_pub` constant** |
| 04 | `receive_chain_advancement` | Bob walks the receiving chain in order |
| 05 | `bidirectional_ratchet_step` | Bob's reply carries a **new** `ratchet_pub`; a DH step occurs on Alice's decrypt |
| 06 | `out_of_order_delivery` | Delivered **3, 1, 0, 2** — all four recovered, none lost |
| 07 | `skipped_message_keys` | Receiving 3 first stores three skipped keys, consumed later out of order |
| 08 | `duplicate_and_replay_rejection` | Re-delivery refused — `DuplicateMessageException` |
| 09 | `state_serialization_and_restore` | Session serialised, rebuilt, still decrypts the next message |
| 10 | `associated_data_mismatch` | Same ciphertext into another `roomId` fails the tag |
| 11 | `tampered_ciphertext` | One flipped bit fails authentication |
| 12 | `wrong_device_or_session_routing` | An unrelated session cannot open it despite a well-formed header |
| 13 | `negative_subtly_wrong_advancement` | **The one that catches an off-by-one chain advance** |

### Measured outcomes of the four rejection cases

Not predicted — read out of the generated file:

```
08_duplicate_and_replay_rejection      rejected: DuplicateMessageException
10_associated_data_mismatch            rejected: AuthenticationFailedException
11_tampered_ciphertext                 rejected: AuthenticationFailedException
12_wrong_device_or_session_routing     rejected: AuthenticationFailedException
```

Each of those assertions is written so that acceptance would record
`ACCEPTED — WRONG` in the output rather than passing quietly. A vector file that
merely *says* a case is rejected proves nothing; this one fails visibly.

### Verified invariants

```
send chain:      n = [1, 2, 3], ratchet_pub identical across all three
DH step:         Alice's ratchet_pub != Bob's reply ratchet_pub
out of order:    delivered [3,1,0,2] -> recovered [burst 3, burst 1, burst 0, burst 2]
restore:         "after bob was restored from disk"
negative:        correct_message_key != off_by_one_message_key
```

---

## Vector 13, which is the reason for all the others

An implementation that advances the message chain **one step early** derives a
different message key from the same chain key:

```
chain_key                 2f0e...              (fixed)
correct_message_key       HMAC(ck, "spotme/e2e_v3/msg/0")
off_by_one_message_key    HMAC(ck, "spotme/e2e_v3/msg/1")
```

Both produce valid AES-GCM output. Both are internally consistent. A lone
implementation passes its own tests either way, review does not catch it, and
the symptom in production is that **the peer cannot read the transcript** —
which looks like a network problem, a key problem, or anything but an off-by-one.

**An implementation matching `off_by_one_message_key` is wrong, and this vector
fails it.** That is compatibility test 18 in `004a` §11, and it is the only test
in the plan that can catch this class of defect.

---

## Schema vectors — framing, AAD and the KDF ladder

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

---

## Compatibility test plan

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
| 18 | Differential vectors match a reference implementation | The ratchet is subtly wrong — **now unblocked; see `004b`** |
| 19 | `HDRLEN` other than 73 or 145 is refused before any key material is touched | Length is trusted from attacker-chosen input (§2a) |
| 20 | A payload truncated mid-header is refused, not read past its end | The parser reads by offset without a length check |
| 21 | A payload truncated mid-ciphertext fails the tag rather than returning partial plaintext | AES-GCM output is used before verification |
| 22 | `HDRLEN` larger than the payload is refused | Integer overflow or negative-length slice |
| 23 | An attachment key is destroyed with its bytes on view-once burn | §9a: bytes deleted, key retained — or the reverse |
| 24 | A crash between commit and cursor advance replays safely and does not double-advance the ratchet | §9a transactional order is wrong |

Tests 1-17 and 19-24 are writable today against the design. **Test 18 is the
one that actually proves correctness, and it is now unblocked** — the vectors
above supply its expected values.

## Compatibility manifest — every case to its vector group

The authoritative mapping from `004a` §11's compatibility tests to the vector
group that supplies its expected values. A test with **no** vector is a test
whose expected output is asserted rather than derived, and those are listed as
such rather than quietly omitted.

| `004a` §11 test | Vector group | Source of truth |
|---|---|---|
| 1 — v1 room suite unchanged | — | Existing v1 suites on master |
| 2 — v2 room suite unchanged | — | Existing v2 suites on master |
| 3 — v3 frame into a v2 room refused | — | Spot Me logic; no ratchet involved |
| 4 — **v2 frame into a v3 room refused (downgrade)** | — | Spot Me logic |
| 5 — `e2eVersion` cannot be lowered | — | Spot Me logic |
| 6 — header bit-flip fails the tag | **10** | AAD binds the header |
| 7 — version flip fails the tag | **10** | Version is inside the AAD |
| 8 — replay into another room fails | **10** | `roomId` is inside the AAD |
| 9 — `N` beyond `MAX_SKIP_PER_CHAIN` refused | **07** | Bound stated; oracle enforces `dos_protection_threshold` |
| 10 — out-of-order 2,1,4,3 all decrypt | **06** | Delivered 3,1,0,2; all recovered |
| 11 — a dropped message leaves others readable | **06, 07** | Skipped keys retained |
| 12 — duplicate detected, not re-processed | **08** | `DuplicateMessageException` |
| 13 — messages across a DH step, out of order, decrypt | **05, 06** | `PN` carries the previous chain length |
| 14 — frame for another `RDEV` ignored quietly | **12** (partial) | Cross-session rejection covered; **`RDEV` routing itself is not — multi-device is undesigned** |
| 15 — `OPKID = 0xFFFFFFFF` establishes without a one-time prekey | — | **No vector.** `004a` §5a rule; needs an X3DH-path test |
| 16 — reserved `FLAGS` bits refused | — | **No vector.** Parser-level; `004a` §5c |
| 17 — cursor advances past a version mismatch | — | Spot Me transport logic |
| **18 — differential vectors match a reference** | **01–09, 13** | **The whole package. This is the test the vectors exist for** |
| 19–22 — malformed length and truncation | — | **No vector.** Parser-level; derivable from §2a's fixed sizes |
| 23 — attachment key destroyed with its bytes | — | **No vector.** Spot Me lifecycle; `004a` §9a |
| 24 — crash between commit and cursor advance | — | **No vector.** Spot Me transactional order; `004a` §9a |

**Required-case coverage**, as named in the work order:

| Required case | Vector group |
|---|---|
| Normal chain advancement | **03** (send), **04** (receive) |
| DH ratchet advancement | **05** |
| Skipped keys | **06**, **07** |
| Persistence restoration | **09** |
| **Negative subtle-advancement** | **13** |

**Ten of the twenty-four compatibility tests have no vector, and all ten are
Spot Me logic rather than ratchet behaviour** — parser rules, transport
decisions, and lifecycle. That is the correct division: an oracle for the Signal
algorithm cannot supply expected values for decisions Signal never made. They
still need tests; they do not need vectors.

## Coverage against the required list

| Required | Vector |
|---|---|
| Initial X3DH / session establishment | 00, 01 |
| First encrypted message | 01, 02 |
| Normal send-chain advancement | 03 |
| Normal receive-chain advancement | 04 |
| Bidirectional ratchet step | 05 |
| Out-of-order messages | 06 |
| Skipped-message keys | 07 |
| Duplicate and replay rejection | 08 |
| State serialization and restoration | 09 |
| Associated-data mismatch | 10 |
| Tampered ciphertext | 11 |
| Wrong device/session routing | 12 |
| Negative — subtly wrong advancement | 13 |

## Limits — read before treating this as complete

1. **The oracle has no published audit.** `DoubleRatchet` (Syndace) is MIT and
   actively maintained, but no audit is stated. `004c` §2 records this as the
   selection's real weakness and proposes cross-checking spec-ambiguous
   behaviour against `2key-ratchet`.
2. **The generator's AEAD nonce is derived, not random**, so the vectors
   reproduce. **The shipping implementation must use a random IV.** Safe here
   only because each message key is used once — an invariant owned by the
   ratchet, not the AEAD. Flagged in the source at the point of use.
3. **These vectors do not cover multi-device fan-out**, because `004a` §9 does
   not specify it. `SDEV`/`RDEV` appear in the header and vector 12 shows
   cross-session rejection, but N-device fan-out is undesigned.
4. **They prove conformance to a correct ratchet, not that the design is
   right.** That is what ADR-004 and `004c` are for.
5. **The generator is not in `npm test`** and nothing in `web/` or `backend/`
   imports it. It runs on demand. Wiring it into CI only makes sense once a
   Spot Me implementation exists to compare against — at which point the
   comparison, not the generation, is the test.
