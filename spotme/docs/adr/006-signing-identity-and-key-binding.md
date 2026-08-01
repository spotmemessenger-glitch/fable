# ADR-006 — A signing identity, and binding agreement keys to it

**Status:** Accepted (foundation). Key generation NOT authorised — see *Gating*.
**Date:** 2026-08-01
**Supersedes:** nothing. **Depends on:** ADR-001 (e2e_v2 agreement), ADR-003
(safety numbers), ADR-005 (pinning and trust state).

## Context

ADR-001 gave every device an X25519 agreement key and ADR-005 made the key a
peer publishes into a *pinned* trust anchor with a five-state machine. Between
them they close the substitution attack: a server that swaps a peer's key
produces a `Changed` record instead of a silent re-pin.

They leave one thing unsolved, and it is not a corner case.

**A verification is pinned to an agreement key, so any legitimate change to that
key destroys it.** New phone, reinstall, storage cleared by the OS, a switch
between the web build and the Android build — each one produces a new agreement
key, which ADR-005 correctly reports as `Changed`, which is correct and also
indistinguishable from an attack. The only recovery is for two people to meet
and read sixty digits at each other again.

That cost is not merely inconvenient; it is what makes an attack cheap. If
`Changed` is something users see routinely and clear routinely, then clearing it
becomes reflex, and the one time it matters is the one time it gets clicked
through. A5 cannot fail closed on a signal that fires every time somebody buys a
phone.

The missing capability is a way for a peer to **vouch for its own next
agreement key** using something a verifier already trusts. X25519 cannot do it:
it is a key-agreement key, it produces no transferable artefact, and the
agreement itself convinces only the two parties performing it, in the moment,
about nothing beyond "somebody holds the other half".

## Decision

Give each device a **second, longer-lived key that signs**, and define a
**binding**: a signed statement that a given agreement key belongs to a given
account on a given device.

### 1. A separate signing key, negotiated

`Ed25519` where the runtime has it, `ECDSA` over `P-256` otherwise. The fallback
is the same reasoning as ADR-001's curve negotiation and is not hypothetical:
Capacitor's Android System WebView updates independently of the app, and Ed25519
landed in Chromium considerably later than X25519, so a device perfectly capable
of v2 agreement may have no Ed25519 at all. The algorithm is therefore recorded
per identity rather than assumed.

Signing and agreement algorithms are **independent axes** — Ed25519 signing over
P-256 agreement is a real combination and is tested as one.

### 2. Public keys are never inferred, only declared

ADR-001 infers a peer's curve from the raw key length (32 = X25519, 65 = P-256).
That trick **cannot be reused here**, because the signing curves have the *same*
lengths: Ed25519 is 32 bytes and X25519 is 32 bytes; ECDSA P-256 and ECDH P-256
are both 65. Nothing about the bytes says which protocol a key belongs to, and
WebCrypto will import the same 32 bytes as either.

So `importSigningPublicKey` **requires** an explicit algorithm and refuses to
guess, and the algorithm is *also* bound into every signed transcript. Two
independent defences, because the failure — a signature checked against the
wrong key type — is silent.

### 3. Length-prefixed transcripts, not delimited ones

Every signature is over `uint32be(count) || (uint32be(len) || bytes)*`, under an
explicit domain string.

This is the single most consequential encoding decision in the design. A
delimiter-joined encoding makes distinct claims produce identical bytes the
moment a field can contain the delimiter — `["a|b"]` and `["a", "b"]` are one
string under `join('|')` — and a signature is only ever a signature over bytes.
Two claims with one encoding is two claims with one signature: sign the harmless
reading, present the other. ADR-001's `|`-joined HKDF info is safe only because
its inputs are base64 and an opaque id; bindings sign account and device
identifiers, so they cannot rely on that.

The per-field lengths carry the argument. The leading field count is redundant
given them and is kept only because it costs four bytes and makes a buffer
self-describing — mutation testing confirms no test can distinguish its absence,
and it is documented as such rather than cited as a defence.

### 4. Two proofs, because a signature is not possession

A binding carries **both**:

| Proof | By | Answers |
|---|---|---|
| Signature | the signing key | "this identity asserts the claim" |
| Proof of possession | the agreement key | "and the agreement key is live" |

The second is not belt-and-braces. **A signing key can sign a claim naming any
public key at all**, including one lifted from someone else's account — the
agreement key is public, the server hands it out. Nothing in the signature
contradicts it, because a signature attests to a statement, not to evidence for
it. Without the PoP, an attacker holds a cryptographically valid document
asserting she owns a key she has never possessed.

Because X25519 cannot sign, possession is proved by **agreeing**: the verifier
generates an ephemeral pair on the claimed curve and a 32-byte nonce; the
claimant does ECDH against it, derives an HMAC key via HKDF-SHA256, and MACs the
transcript; the verifier recomputes from the other half of the same agreement.
Only the holder of the private half can produce that MAC, and the
verifier-chosen nonce is what stops a captured one being replayed.

### 5. Relay is refused on the answering side

A challenge is just bytes and anyone can forward one. If a device answered any
challenge put to it, an attacker could build a claim naming **her** signing key
and **the victim's** agreement key, relay a verifier's challenge to the victim,
and have the victim complete her forgery.

So `answerPopChallenge` refuses any claim that does not name *both* of this
device's own public keys. Answering is asserting "this entire claim is mine"; a
device willing to assert that about a claim it did not make has given away the
thing the PoP was protecting. It is the one place in the protocol where the
security property is a device being unhelpful.

### 6. The two verification questions are named differently

`verifyBindingSignature` answers a **historical** question — did this identity
sign this claim — and is the right check for a binding already stored and
already verified. `verifyLiveBinding` answers whether a claim arriving **now** is
coherent, current and possessed.

They are deliberately not variants of one name. A signature is replayable by
anyone who has ever seen it, and an API where the weak check reads as a cheaper
spelling of the strong one is an API where the weak check gets used.

### 7. Bindings do not expire; nonces are what make them fresh

A binding is a long-lived assertion — that is its entire purpose — so there is no
maximum age. Freshness comes from the PoP nonce. Future-dating *is* refused
beyond ordinary clock skew (5 minutes), because a future-dated binding would
still look current after a revocation.

## Gating — no key is generated

**The owner has not authorised minting signing keys, and this change does not.**

Minting one is one-way. The moment a signing key is published it becomes the
anchor peers pin, and replacing it is a visible trust event for every
conversation it touched — not a silent upgrade. So the foundation ships
unreachable: nothing under `src/` imports either module, nothing calls
`generateSigningIdentity`, and no endpoint exists to publish one.

That is enforced by `test/signing-not-shipped.test.js`, which fails the build if
any app module imports the foundation, names the generator, or references a
signing-key field — and which *also* asserts the suite does exercise all of it,
because "not wired in" must not decay into "not looked at". Unexercised crypto
is worse than none: it looks finished.

Turning it on is therefore a deliberate change whose whole subject is that
authorisation. What the test prevents is the other route — an import added in
passing, nobody noticing, keys quietly existing in the field.

## Consequences

**What this buys, once authorised.** A peer verified once can vouch for its own
next agreement key, so routine key churn stops destroying verifications, so
`Changed` becomes rare enough for A5 to fail closed on it. That chain is the
reason A7 precedes A5 enforcement.

**Safety numbers will need a second construction.** The displayed number is
currently computed over the *agreement* key (ADR-003), which is exactly the key
that rotates. Once a signing identity exists the number should be computed over
it instead — the point of a long-lived identity is a long-lived fingerprint. The
two constructions must **coexist**: a device with a signing identity talking to
one without still has to display something both can compare, so the version
prefix selects the construction and `SAFETY_VERSION` is already bound into the QR
payload (`sv`) so a mismatch is refused rather than compared against numbers it
cannot equal. **Not implemented here** — it cannot be exercised until keys exist,
and shipping an unexercisable path is what this ADR's gating section rejects.

**Storage is not designed yet.** Where a device's signing key lives, how peer
bindings are persisted alongside pin records, and how a binding interacts with
the five-state machine in ADR-005 are open. The pure layer was built first
deliberately: it is testable on Node against real WebCrypto with no mocks, which
is where the security argument can actually be checked.

**Multi-device is outside the scope of this signing-foundation PR, but remains a
mandatory Priority 1 completion requirement.**

An earlier draft of this ADR said multi-device was "out of scope" without
qualification. That was wrong, and the correction matters more than the wording:
the migration plan lists *"Add Multi-device support"* among Priority 1's tasks,
and Priority 1 cannot be declared complete without it. An ADR is an
implementation record; it does not have standing to narrow the controlling
document, and a scope note in one PR must never read as a scope decision for the
programme.

What this PR does and does not do: signing keys here are **per-device**, exactly
like agreement keys, and the binding already carries a `deviceId` field — so the
format anticipates a device set even though nothing yet manages one.

### The minimum acceptable multi-device implementation for Priority 1

Normative. Anything less does not close the requirement:

1. Each device has its own identity/device keys.
2. A sender encrypts **separately for every active recipient device**.
3. New devices require an **authenticated linking or approval flow**.
4. Device removal stops future message delivery to that device.
5. Existing devices can detect newly added or removed devices.
6. Identity and safety-number behaviour accounts for device-set changes.
7. Ratchet state is maintained **per remote device**.
8. Offline devices can recover messages within documented limits.
9. The server never receives plaintext or private key material.

**Deferrable, if explicitly documented:** full account backup, unlimited device
history, and seamless restoration to a brand-new device. **Not deferrable:** the
core multi-device cryptographic flow above.

Note what item 6 implies for this ADR: once a user has a device *set*, a safety
number computed over one device's key is no longer a complete statement about
the person. That interacts with the safety-number construction discussed below
and is unresolved — recorded here so the multi-device work does not discover it
late.

**No forward secrecy is added or claimed.** A binding is an authentication
artefact. ADR-004's ratchet work is independent and still outstanding.

## Alternatives considered

**Reuse the agreement key as an identity key.** It cannot sign, which is the
whole problem, and it is the key that rotates — so it is unfit on both counts.

**Sign with a key derived from the agreement key.** Would tie the identity's
lifetime to the agreement key's again, reintroducing exactly the coupling this
removes.

**Have the server attest key changes.** The server is the adversary in ADR-001's
threat model and in ADR-005's. An attestation it issues proves nothing about a
substitution it performed.

**Skip the proof of possession and rely on the signature.** Rejected — section 4
is the reason, and `test/identity-binding.test.js` runs the resulting forgery end
to end rather than describing it.

**A second signature instead of a DH round trip.** Would require the agreement
key to be a signing key, which X25519 is not, or a third key, which adds a
lifetime to manage for no gain over agreeing with the key already in hand.

## Rollback

**Free and total, and this is the one point in the sequence where that is
literally true.** Nothing under `src/` imports either module, no key has been
generated, nothing has been published, and no bytes have been written to any
store. Reverting the commit removes two files and three test suites and changes
no runtime behaviour on any device, in any state.

There is nothing to purge, because nothing was persisted. There is no
compatibility window, because no peer has ever seen a binding. A device that ran
this build and a device that did not are indistinguishable.

That property is a consequence of the gating decision, not a coincidence: an
unreachable module cannot leave anything behind. It stops being true the moment
Step 2 is authorised, and the change that authorises it must carry its own
rollback plan covering published keys — at which point rollback means deciding
what happens to peers that have already pinned a signing identity, which is a
materially harder question and must not be inherited from this section.
