# e2e_v3 — decision package

**Companion to ADR-004 and `004a-e2e-v3-envelope-schema.md`. Design only; no
production code. PR #15 stays unmerged until these decisions are made.**

Every licence and maintenance claim in §2 was checked against upstream while
writing this, not recalled. Where a fact could not be confirmed it says so.

---

## 1. The five open questions

Recorded verbatim from the PR #15 comment, with options, a recommendation, and
what each choice costs.

---

### Q1 — Which reference implementation should the ratchet vectors come from?

*"§10's ratchet vectors do not exist. Which reference implementation should they
be generated from? This blocks test 18, and test 18 is the one that would catch
a subtly wrong ratchet."*

**Options**

| | Option | Consequence |
|---|---|---|
| A | `DoubleRatchet` + `X3DH` (Syndace), MIT, Python | Independent, maintained, offline; not our language, so it can never become production by accident |
| B | `2key-ratchet` (PeculiarVentures), MIT, TypeScript + WebCrypto | Same primitives as ours; **archived April 2026**, self-described as suitable "for experimentation" |
| C | `vodozemac` (matrix-org), Apache-2.0, Rust | Audited by Least Authority; Rust toolchain, and Olm's ratchet is not Signal's |
| D | No reference — self-test only | The failure this whole exercise exists to prevent |

**Recommendation: A, with B as an optional second opinion.** Full reasoning in
§2. **Not D under any circumstances** — a ratchet tested against itself is
tested against its own misunderstanding.

**Trade-offs.** *Security:* an independent oracle is the only thing that catches
a self-consistent error. *Compatibility:* none — the oracle never ships.
*Operational:* one Python dev-dependency, run manually, not in `npm test`.
*Migration:* none.

**Rejected and why.** B as the *primary* oracle: archived, and its own README
declines to vouch for its security properties. C: the Olm ratchet differs from
Signal's, so agreement would prove less than it appears to, and the Rust
toolchain is a large addition for a vector-generation job. D: see above.

**Reversibility: easy.** The oracle is a dev tool. Swapping it later costs a
regeneration and a diff.

---

### Q2 — Is +33 bytes per message steady-state, +105 on the first, acceptable?

**Options**

| | Option | Consequence |
|---|---|---|
| A | Accept as specified (73-byte header) | ~25% overhead on a short text; 0.02% on a 128 KB slice |
| B | Drop `SDEV`/`RDEV` (−32 bytes) | Header falls to 41 bytes; **multi-device needs a format change later** |
| C | Shorten device ids to 8 bytes (−16) | Halves the device-id space; collision risk across a user's own devices only |

**Recommendation: A.** The overhead is real but concentrated where it matters
least. Attachments dominate Spot Me's byte volume and are already chunked at
128 KB; text messages are small in absolute terms, so 33 bytes on a 130-byte
frame is a percentage that sounds worse than it costs.

**Trade-offs.** *Security:* B and C weaken nothing cryptographically. *Operational:*
B is the cheapest wire but forces a version bump the day multi-device ships.
*Migration:* A costs nothing now; B costs a v4 later.

**Rejected and why.** B trades a permanent format constraint for 32 bytes.
C saves 16 bytes for a smaller identifier space and no other benefit.

**Reversibility: HARD — this is a wire format.** Once a v3 message exists on a
peer's device, the header layout cannot change without a new version. **This is
one of the two decisions on this page that is expensive to revisit.**

---

### Q3 — Are `MAX_SKIP_PER_CHAIN = 1000` and the 7-day expiry the right numbers?

These are **message-loss policies**, not tuning knobs. Crossing either loses
messages permanently.

**Options**

| | Option | Consequence |
|---|---|---|
| A | 1000 / 2000 / 7 days as specified | A peer may send 1000 messages unseen before loss begins |
| B | Lower (e.g. 200 / 500 / 48h) | Less client memory and a smaller DoS ceiling; more real loss for a long-absent device |
| C | Higher (e.g. 5000 / 10000 / 30 days) | Fewer lost messages; a forged header can make the client derive 5000 keys |
| D | Unbounded | **Remote DoS.** A single forged header with `n = 2^32-1` |

**Recommendation: A**, with the caveat that these numbers are **not measured**.
They are Signal-shaped defaults, and Spot Me has no telemetry on how far behind
a real device gets. The right long-term answer is to instrument the skipped-key
counter and revisit.

**Trade-offs.** *Security:* the bound exists for DoS, so lower is safer; the
expiry is a forward-secrecy property, so shorter is stronger. *Operational:*
each limit is a user-visible failure when crossed, so the UI must say "this
message can no longer be decrypted" rather than fail silently.

**Rejected and why.** D is a trivially exploitable DoS. B and C are defensible
but arbitrary in the same way A is; A at least matches a widely deployed
precedent.

**Reversibility: easy for the bounds, HARD for the expiry.** Raising a bound is
a client-side change. Shortening the expiry retroactively destroys keys that
existing clients are holding.

---

### Q4 — Should TOFU key pinning (R2) land before v3, rather than after?

**Options**

| | Option | Consequence |
|---|---|---|
| A | Pinning first, then v3 | v3 arrives on an authenticated foundation |
| B | v3 first, pinning after | Forward secrecy sooner, on unauthenticated keys |
| C | Together | One larger change, one review |

**Recommendation: A, and I think this is the most consequential answer on the
page.**

The reason is in `004a` §8 and it is not a nicety. v3's downgrade protection
ultimately rests on the signed-prekey signature, which binds `SPK` to `IK` —
**and that is only as strong as `IK`'s authenticity.** Today nothing pins `IK`:
the server hands out public keys, and a substituted one is indistinguishable
from a reinstall. A ratchet started from a substituted identity **ratchets the
attacker's session forward perfectly happily.**

So v3 without pinning buys forward secrecy against a *stolen device* while
leaving the *malicious server* — the adversary in Spot Me's own threat model —
exactly where it was. It also makes the gap worse in one specific way: v3
sessions are long-lived and stateful, so a substitution that succeeds once
persists rather than being re-attempted per message.

**Trade-offs.** *Security:* A strictly dominates. *Operational:* pinning is
small — store "verified at key X", warn on change — and completes ADR-003's
work, which already shipped the primitive and the screen. *Migration:* pinning
is additive and touches no wire format.

**Rejected and why.** B ships the more impressive feature on a foundation that
does not hold. C bundles an easy change with a hard one and makes both wait.

**Reversibility: easy.** Ordering only.

---

### Q5 — Own a ratchet, or defer forward secrecy and close Priority 1 at ADR-003?

The original ADR-004 question, unchanged. **This document does not answer it**
— it specifies the format either way and makes the cost visible.

**Options**

| | Option | Consequence |
|---|---|---|
| A | Build it, narrowly scoped, 1:1 only | Forward secrecy and break-in recovery; we own ratchet correctness forever |
| B | Defer; close Priority 1 at ADR-003 | No forward secrecy; nothing shipped that we cannot maintain |
| C | Accept AGPL and use libsignal | Best assurance; **obliges publishing Spot Me's source** |
| D | Wait for a maintained permissive WASM binding | Indefinite, with no committed timeline |

**Recommendation: A *only if* Q4 is answered A first, and only with the §3
mitigations.** Otherwise **B**.

I want to be plain about the discomfort, because it has not changed: **hand-rolled
ratchets are how projects ship crypto that looks correct and is not.** What
makes A defensible here is narrow: no group ratchet, no async multi-device, the
primitives are all native WebCrypto so we write a state machine rather than
maths, and — now — an independent oracle exists (§2) so correctness is testable
rather than asserted. Remove any one of those and B is the better answer.

**B is a real option, not a rhetorical one.** Forward secrecy done wrong is
worse than forward secrecy deferred, because it is claimed.

**Trade-offs.** *Security:* A adds forward secrecy and break-in recovery, and
adds the risk of a subtly wrong implementation. *Compatibility:* A is additive;
v1/v2 rooms are untouched either way. *Operational:* A is a permanent
maintenance obligation. *Migration:* v3 is decided at room creation and never
migrated, so B leaves nothing stranded.

**Rejected and why.** C conflicts with a stated constraint. D has no end date.

**Reversibility: the HARDEST on this page.** Before rollout, A is deletable.
**After a single v3 room exists, it cannot be downgraded — its history would be
unreadable — so removing v3 code strands those conversations permanently.** The
flag is the rollback; code removal is not.

---

## 2. Reference implementation selection

Verified against upstream, 2026-08-01.

| | Licence | Maintained | Platform | Audit | X3DH | Ratchet |
|---|---|---|---|---|---|---|
| **`DoubleRatchet` + `X3DH` (Syndace)** | **MIT** ✅ | **Active** — "feature-complete, documented and tested" | Python | None stated ⚠️ | separate pkg ✅ | ✅ Signal |
| `2key-ratchet` (PeculiarVentures) | MIT ✅ | **Archived 2026-04-01** ❌ | **TypeScript + WebCrypto** ✅ | "several independent reviews", but says treat as experimental ⚠️ | ✅ | ✅ Signal |
| `vodozemac` crate (matrix-org) | Apache-2.0 ✅ | Active ✅ | Rust | **Least Authority, no significant findings** ✅ | Olm-style | Olm/Megolm ⚠️ |
| `vodozemac-bindings` (JS/WASM) | Apache-2.0 | **Unmaintained** ❌ — *"no longer actively maintained… you will need to extract and update them on your own"* | JS/WASM | inherits crate | — | — |
| `libsignal` (signalapp) | **AGPL-3.0** ❌ | Active | Rust → Java/Swift/TypeScript; **no browser/WASM target** | reference implementation ✅ | ✅ | ✅ |

**Selected: `DoubleRatchet 1.3.0` + `X3DH 1.3.0` (Syndace), MIT.**

- **Protocol compatibility:** implements the Signal Double Ratchet
  specification. `X3DH` supports Curve25519 (and Ed25519 identity keys); it does
  **not** support Curve448, which we do not need.
- **Platforms:** Python 3. Deliberately *not* our runtime — see the risk note.
- **Maintenance:** actively maintained; low commit rate because it is
  feature-complete, which is the healthy version of quiet.
- **Audit history: none stated.** This is the selection's real weakness and it
  should be recorded as such. Mitigated by cross-checking against `2key-ratchet`
  where a second opinion matters (§3).
- **Multi-device suitability:** not applicable — it is a 1:1 ratchet, which
  matches `004a` §9's scope.
- **Persistence and skipped keys:** both supported. `DoubleRatchetModel` /
  `.json` round-trips full session state including skipped keys;
  `max_num_skipped_message_keys` and `dos_protection_threshold` map directly onto
  `MAX_SKIPPED_STORED` and `MAX_SKIP_PER_CHAIN`. Skipped keys are evicted FIFO
  when the maximum is reached — **a policy `004a` §5 must state explicitly rather
  than inherit.**
- **Vector generation only. Never production.** It is Python; Spot Me's client is
  browser JavaScript. That mismatch is a *feature* of this choice: there is no
  path by which it accidentally becomes the shipping implementation.

### The risk you named: implementation-specific behaviour becoming part of `e2e_v3`

This is the sharpest objection to using any reference, and the generator is
built to answer it structurally rather than by good intentions.

**If the vectors were "whatever the library emits by default", `e2e_v3` would
silently inherit its arbitrary choices** — HKDF info strings, header encoding,
skipped-key eviction order — and those would become Spot Me's wire format by
accident. So every Spot-Me-specific value is **injected**, not taken:

| Injected by us | Where |
|---|---|
| KDF info strings (`spotme/e2e_v3/*`) | `SpotMeRootKDF` / `SpotMeMessageKDF` |
| Associated data construction | `SpotMeDoubleRatchet._build_associated_data` |
| AEAD and payload framing | `SpotMeAEAD` |
| Skip bounds | `dos_protection_threshold`, `max_num_skipped_message_keys` |

What the library supplies is **only the algorithm**: when to step the DH
ratchet, how chains advance, how skipped keys are stored and retrieved. That is
precisely the part we want an independent opinion on and are not inventing.

**The standing rule:** where the two disagree and the Signal specification is
silent, write the decision into `004a` and make both sides follow it. Never
"match the library" — that is exactly how an implementation detail becomes a
protocol.

Two behaviours already identified as *ours to decide, not to inherit*:

1. **Skipped-key eviction order.** The library evicts FIFO. `004a` §5 must state
   FIFO explicitly, or a Spot Me implementation evicting LRU would diverge while
   both look correct.
2. **AEAD nonce.** The generator derives its IV from the message key so the
   vectors are reproducible. **The shipping implementation must use a random
   IV.** A derived nonce is safe only because each message key is used once, and
   that invariant belongs to the ratchet, not the AEAD. This is called out in
   the generator's source at the point of use.

---

## 3. Mitigations, if Q5 is answered "build it"

Unchanged from ADR-004 and still non-negotiable, with two additions:

- Differential vectors from the selected reference — **now delivered**, see
  `004b`
- Ordering fuzz: drop, reorder, duplicate, gap
- A hard bound on skipped keys with a documented drop policy
- `e2e_v3` behind a flag defaulting off
- **No group ratchet**
- **New:** cross-check the handful of spec-ambiguous behaviours against
  `2key-ratchet` as a second, WebCrypto-based opinion — archived, so read-only,
  but two oracles disagreeing is more informative than one
- **New:** TOFU pinning lands first (Q4)

---

## 4. What this package does not settle

- **Q5 is unanswered by design.** It is the owner's call.
- **The selected reference has no published audit.** Recorded, not hidden.
- **No implementation exists**, and none should until Q1–Q5 are answered.
- The vectors in `004b` prove an implementation *conforms to a correct ratchet*.
  They cannot prove the *design* is right — that is what ADR-004 §3 and this
  document are for.
