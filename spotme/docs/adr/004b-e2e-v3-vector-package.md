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
