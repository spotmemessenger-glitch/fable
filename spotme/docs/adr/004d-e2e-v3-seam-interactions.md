# e2e_v3 — interaction with the merged transport and storage seams

**Companion to `004a` (schema), `004b` (vectors) and `004c` (decisions).**

Checked against `master` at `b0423b2`, after phases A (transport seam), B (media
in IndexedDB) and C (storage seam) landed. Three interactions.

**The first is a design gap in `004a`, not a note**, and all three are now
REQUIRED parts of the design rather than observations — see `004c`, mandatory
design requirements.

**None of them changes anything already merged.** Phases A, B and C are correct
for `e2e_v1` and `e2e_v2`, which is what ships. They are recorded because the
first in particular would otherwise have surfaced during implementation, at the
point where it is most expensive to fix.

---

Checked against `master` at `b0423b2`, after phases A, B and C landed. Three
interactions, and the first is a **design gap in this document** rather than a
note.

### 1. Attachments have no v3 key, and the storage path assumes one exists

Phase C seals attachment bytes with:

```js
sealForRoom(roomId, bytes, password)  ->  roomKey(roomId, password)
```

A **long-lived, room-scoped** key. That is exactly what v2 provides and exactly
what **v3 does not have**: a ratchet has no stable room key, only per-message
keys that are *deleted after use*.

This matters because of the path phase C added. A storage-backed attachment is
fetched **lazily** — the envelope arrives, the bubble renders, and the bytes are
pulled from the bucket when the user taps, which may be days later and several
ratchet steps on. **A message key will not exist by then.**

So `sealForRoom`/`openForRoom` have no v3 meaning as currently written, and
nothing in this document said so.

**REQUIRED** (`004c`, mandatory design requirements):

- Generate a **random key per attachment**.
- Carry that key **inside the ratcheted message envelope** (`cm`).
- **Persist it with the decrypted message record**, so lazy retrieval does not
  depend on retaining a deleted message key. This is the part that makes the
  scheme work: the ratchet protects the *key*, and the long-lived object is
  encrypted under something allowed to be long-lived.
- **View-once deletion removes BOTH the bytes and the retained attachment-key
  material.** Deleting one and not the other is the failure mode — bytes without
  a key look deleted but are not, and a key without bytes is a live secret for an
  object the bucket may still hold. Phase B's `blobstore` deletion paths and
  phase C's `burnAttachment`/purge paths must both learn about the key record.

Consequences to carry: the envelope grows by 32 bytes for attachment messages;
**forward secrecy for attachment bytes is bounded by that key's lifetime, not
the ratchet's**, and that limitation is stated rather than glossed;
`FORBIDDEN_STORAGE_SURFACE` continues to hold, because the adapter still never
sees a key.

### 2. Replay is idempotent under v2 and is NOT under v3

`socket-transport.js` holds the replay cursor for a frame it could not open, so
that frame is **re-delivered and re-dispatched on the next join** — the
behaviour `replay-cursor-hold.test.js` exists to pin. Under v2 that is free: the
room key is stable, so decryption is idempotent and a retry either works or
fails the same way.

Under v3 a message key is **consumed on successful decrypt**. Retrying is
therefore not a neutral act, and the existing repairable-vs-unrepairable split
does not map cleanly:

- a frame that failed because the *session* was not yet established **is**
  repairable and must hold the cursor, as today
- a frame that decrypted and then failed *downstream* must **not** be retried,
  because its key is gone and the second attempt will fail permanently — which
  the current code would classify as unrepairable and skip, silently losing a
  message it had already successfully decrypted

**§5b's duplicate handling covers the wire case; this is the local one.**

**REQUIRED: decryption and durable cursor advancement have a defined
transactional order.** The order is:

1. decrypt
2. **durably commit** the plaintext, the attachment-key record if any, and the
   advanced ratchet state — as one unit
3. only then advance the replay cursor

A crash between 2 and 3 replays a message that is already stored; `store.add()`
dedupes by id and honours tombstones, so that is safe. A crash between 1 and 2
loses a decryption that had not been committed, and the frame is retried
normally — which is the correct outcome, and only correct in this order.

**Retrying an already-decrypted envelope must not: lose the message, advance the
ratchet twice, or regenerate an attachment record.**

### 3. `FORBIDDEN_KEY_SURFACE` does not yet know about ratchet state

Phase A's adapter guard bans `roomKey`, `deriveKey`, `setRoomKey`, `password`,
`secret`, `key`, `seal`, `open` and friends. Under v3 the **session state is key
material too** — root key, chain keys, skipped keys — and none of those names is
on the list.

The list should gain `ratchet`, `session`, `chainKey`, `rootKey` and `skipped`
before v3 ships. Small, but the guard's whole value is that it is asserted
rather than assumed, and an adapter holding a chain key would pass it today.

**REQUIRED, and broader than the adapter guard.** The following must never reach
logs, Redux/devtools, analytics, crash reports, URLs, ordinary `localStorage`,
or server payloads:

> ratchet state · chain keys · root keys · skipped-message keys · attachment
> keys · identity private keys · prekey private material

Phase A's `FORBIDDEN_KEY_SURFACE` covers **adapters only**. This rule covers
every egress an app has, and most of those are not adapters — a crash reporter
serialising session state is the realistic leak, not a rogue transport.

### 4. Nonce — production must not inherit the generator's

**REQUIRED: production encryption uses a random nonce/IV.** `004b`'s generator
derives its IV from the message key so that vectors reproduce byte for byte.
That is safe *there* only because each message key is used exactly once — an
invariant owned by the ratchet, not by the AEAD — and it must not be copied into
the implementation. The generator says so at the point of use; it is repeated
here because this is the file an implementer reads.

---

**None of these three changes anything already merged.** Phases A, B and C are
correct for v1 and v2, which is what ships. They are recorded here because the
first one in particular would have been discovered during implementation, at the
point where it is most expensive to fix.
