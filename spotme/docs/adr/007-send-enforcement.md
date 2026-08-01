# ADR-007 — Enforcement: when Spot Me refuses to send (A5)

**Status:** Accepted, and **switched off**. `ENFORCING` defaults to `false`.
**Amends:** ADR-005 §7 (see *The reversal*). **Depends on:** ADR-005 (trust
state), ADR-006 (signing identity, for the cost argument).

## Context

A1–A4 built a trust record; A6a added a second axis for what the server says.
Nothing has ever *stopped* anything. `rooms.js` has carried the note "Advisory
in this step — A5 turns this into a block" since A2 landed.

Detection without enforcement is worth something — a user who checks the verify
screen learns the truth — but it puts the entire burden on someone noticing. The
substitution attack ADR-005 describes succeeds against anybody who doesn't look.

## Decision

### 1. The verdict is always computed; the flag only decides whether it bites

`sendDecision()` runs on every send regardless of the flag. With enforcement
off, a blocking verdict is returned with `advisory: true` and `allowed: true` —
reported, not enforced.

This is the whole shape of the change. A flag that *skips* the code it gates
buys nothing but the illusion of caution: the enforcement path would first run
in anger on the day it is switched on, which is the worst possible day to
discover it is wrong. Here it runs on every message from the moment this lands,
and switching the flag changes one boolean rather than activating untrodden code.

The tests assert the **verdict** with the flag off, not just `allowed`, so a
future short-circuit fails the build.

### 2. Two axes, trust read first

`Changed` and `Revoked` block on the trust axis; `ServerDisabled` and
`Unreachable` block on the availability axis (ADR-006's separation). Trust is
read **first**: a peer who is both revoked and unreachable is told about the
revocation, because that is the cryptographic fact, it is the one the user acted
on, and "can't reach the server" would send them to fix a network that is not
the problem.

### 3. Every block names the action that clears it

`NEEDS` is a required field on every blocking verdict. A block with no next step
is an outage with extra words. Making it structural means a new blocking verdict
cannot be added without someone deciding what it asks of the person holding the
phone.

The three resolutions for `Changed`, per the migration plan:

| Action | Result | What it claims |
|---|---|---|
| Verify (scan or compare) | `Verified` | someone actually checked |
| Accept | `Pinned` | "I know why it changed" — pins the new key **without** claiming anyone checked it |
| Reject | prior state restored | the old key stays trusted |

There is deliberately **no "dismiss"**. A warning that can be waved away without
choosing is one users learn to wave away, and then enforcement is gating a
signal nobody reads.

### 4. The gate is at the choke point

`rooms.sendMessage` and `rooms.sendAttachment`. `views/chat.js` calls the first
from a dozen places — text, location, reactions, partials, timers — so a gate at
each caller is a gate the thirteenth forgets. A photo to a peer whose key changed
is the same decision as a message to them, hence both.

The verdict cache is **synchronous and keyed by room**, because the send path is
synchronous and holds a room id. Making the send path async would ripple through
every caller and put IndexedDB between a keypress and a bubble — the same
objection that made `identityStatus()` synchronous in `identity-store.js`.

### 5. A proposal blocks immediately, not after a store read

`onPeerKeyProposed` already knows a differing key exists. Waiting for the trust
record to be re-read would leave a window in which the substituted key is known
and sending is still allowed — precisely the window an attacker provoking a
decrypt failure is operating in.

## The reversal

**ADR-005 §7 said A5 is where an unreachable pin store becomes a fail-closed
condition. That was wrong, and this ADR reverses it.**

The A5 matrix (PR #30) established the premise was false. With the pin store
down, `roomKeyForConvo` still derives against the **local** `convo.peerKey` and
still merely *proposes* a differing key. Messages remain encrypted to the pinned
key; the substitution is still refused. An unavailable store hides the
**warning** — it does not enable the attack.

Failing closed there would take every private-browsing user offline in exchange
for nothing. So a missing record is `Allowed`.

**The one case this does not cover** is a conversation whose *first* pin was
taken during an outage: there is no local key to seed from, so whoever is
serving keys when the store returns chooses the pin, and no `Changed` can be
raised because there is nothing to compare against. At this layer that is
indistinguishable from any other first pin. Closing it needs an out-of-band
anchor, which is what ADR-006 builds. Recorded rather than papered over.

## Why it ships off

Turning it on is a **product** decision, not a security one, and the cost is
concrete: every *legitimate* key rotation — new phone, reinstall, storage
cleared by the OS — stops a conversation until two people do something about it.

That cost is what makes A5 unsafe to enable casually. If `Changed` fires every
time somebody buys a phone, clearing it becomes reflex, and the one time it
matters is the one time it gets clicked through. ADR-006's signing identity is
what makes rotation cheap enough for enforcement to be reasonable, by letting a
peer verified once vouch for its own next key.

Enabling therefore waits on two things: the manual device matrix (the rows PR
#30 could not automate — real camera scanning, genuine multi-device, real local
key loss), and a decision about whether to accept the interim UX cost or wait
for A7's remaining work.

## Consequences

**Nothing changes for users today.** The flag is false, every verdict is
advisory, and the only visible difference is that a `Changed` peer now gets
Accept / Keep-the-old-one buttons on the verify screen.

**The verify screen's closing copy now reads the flag** rather than asserting
either answer. That paragraph has been wrong twice by being a fixed sentence
about behaviour that later changed.

**The verdict cache is cleared on wipe.** Left behind, the next account on the
device inherits the last one's blocks — and, worse, its allows.

**The gate itself is not integration-tested.** `test/identity-enforcement.test.js`
covers the decision exhaustively and mutation-tests it; the gate in `rooms.js` is
covered by a **source-level tripwire** that catches deletion or a new ungated
send path, and cannot catch a gate that is present and wrong. That is on the
manual matrix, and the test says so in its own comment.

## Alternatives considered

**Enforce on receive as well as send.** Rejected for now: refusing to *display* a
message from a changed key hides evidence the user may need, and the message is
already decrypted-or-not by the pinned key regardless.

**A user-facing setting for enforcement.** Rejected: this is not a preference,
it is a rollout stage. A setting would also let an attacker's social engineering
target one toggle.

**Block on `Unverified`.** Rejected outright — first contact is not an attack,
and blocking it would make the app unusable for its actual purpose.

## Rollback

**With the flag off — the state this ships in — reverting changes nothing
observable.** No message is being refused, so removing the code that would
refuse them alters no behaviour. The verdict cache is in memory only and dies
with the tab; nothing it holds is persisted, so there is no data to migrate or
purge.

Two things survive a revert, and both are safe:

- **Records written by the Accept / Keep-the-old-one buttons.** Those are
  ordinary `ACCEPT` and `REJECT` events in the A1 state machine, which predates
  this change and continues to read them. A user who accepted a key change on
  this build has a correctly pinned record on a build without it.
- **Nothing else.** This change adds no schema, no field, and no database.

**If enforcement had been switched on first,** reverting is a *reduction in
protection*, not a data loss: a `Changed` peer stops being blocked and goes back
to being merely flagged. That is the same framing ADR-005 §6 uses for A2–A5, and
it is recoverable by re-applying. It is stated here rather than inherited,
because ADR-005 asks each of these changes to state it for itself.

**Reverting is not the way to disable enforcement.** Flip `ENFORCING` to false —
one boolean, no diff to the decision logic, and the verdicts keep being computed
so the next attempt has evidence. Reverting to turn it off would also remove the
review UI, leaving a user with a `Changed` peer and no way to resolve it.
