# ADR-001 — Eliminating V-19: real key agreement for direct messages

**Status:** Accepted · **Date:** 2026-07-31 · **Supersedes:** nothing · **Phase:** 1

## Context

`web/src/lib/reach.js:90-97` derives a DM room secret like this:

```js
const [a, b] = [idA, idB].sort()
const key = `${a}:${b}`
secret: stableHash(`spotme-dm-secret-v1:${key}`) + stableHash(`spotme-dm-secret-v2:${key}`)
```

`stableHash` (`reach.js:69-80`) is **cyrb53**, a non-cryptographic hash whose own
docstring says it is "never to protect anything". Its output is the PBKDF2
password for the room's AES-GCM key.

Concatenating the v1 and v2 hashes yields 32 hex characters — **128 bits of
output and zero bits of entropy.** Both halves are deterministic functions of
the same `key`, and `key` is nothing but two user ids the server already stores
in the `User` table. The algorithm ships in the public bundle.

**Therefore the server can recompute the key for any direct message and decrypt
the entire history.** Four independent audit agents ranked this the top finding
on 2026-07-31 and none of them touched it, because changing the derivation
makes every existing conversation permanently unreadable.

Meanwhile the product claims otherwise, in two places:
- `main.js:353` — "no server reading your messages"
- `chat.js:2767` — "Messages are end-to-end encrypted between your devices. No server can read them."

Both are false for DMs today.

### What already exists (verified, not assumed)

- **`User.publicKey` is already in `schema.prisma`**, commented as an X25519
  public key, and `auth.service.ts:157,172` already persists it on guest
  signup/update. **No client has ever sent one**, so the column is NULL for
  every user in production. The groundwork exists; nothing populates it.
- There is **no** key-fetch endpoint and **no** `/api/v2` controller.
- **`Conversation` is irrelevant to web DMs.** Rows are created only by
  `chat-requests.service.ts:107` (the mobile/backend track). The web app's rooms
  are `roomId` keys into `RoomEvent`/`RoomMember`, with the convo record held in
  client `localStorage`.

## Decision

### 1. Versioned derivation, never a wipe

Every conversation carries an explicit `e2eVersion`:

| Version | Derivation | Applies to |
|---|---|---|
| `e2e_v1` | cyrb53 pair, as today | every room that exists on 2026-07-31 |
| `e2e_v2` | X25519 ECDH → HKDF-SHA256 | every room created after this ships |

A room's version is **decided at creation and never migrated**. v1 rooms keep
working and keep their history; they are marked in the UI as legacy rather than
silently presented as secure.

**The version marker lives in the client convo record and in the knock payload**,
not in the `Conversation` table — because web DMs never create a `Conversation`
row. A `keyVersion` column is still added to `Conversation` for the mobile
track's benefit and for schema symmetry, but **it is not the source of truth for
the web app** and must not be treated as such.

### 2. X25519, with a P-256 fallback

Measured in the real runtime (Chrome 148) before choosing:

| Primitive | Result |
|---|---|
| `X25519` generateKey/deriveBits | works — 32-byte raw public key, 256-bit shared secret |
| `ECDH` P-256 | works — 65-byte raw public key, 256-bit shared secret |
| `HKDF` SHA-256 → AES-GCM | works, yields `extractable: false` |
| Non-exportable `CryptoKey` through IndexedDB | round-trips with `extractable === false` preserved |

X25519 is primary. **A P-256 fallback is retained** because Capacitor's Android
System WebView is updated independently of the app and can lag the X25519 ship
date; a user on an old WebView must degrade to a still-strong curve rather than
fail to chat. The curve in use is recorded per room so the peer can match it.

**libsignal is explicitly rejected.** It is **AGPL-3.0**; linking it would
oblige Spot Me to publish its own source. WebCrypto is already a dependency-free
primitive available in every target runtime.

### 3. Identity keys are non-exportable and never leave the device

`crypto.subtle.generateKey({name:'X25519'}, false, ['deriveBits'])` — the
`false` is the whole point. The private key is a handle the page can use but
cannot serialise, stored in IndexedDB as a live `CryptoKey`. Not localStorage,
which only holds strings and would require an extractable key.

The **public** half is uploaded to `User.publicKey`. That is safe by
construction — it is public.

### 4. What this does and does not achieve

**Achieved:** the server no longer possesses the inputs needed to derive a v2
room key. It sees two public keys and ciphertext. Recomputation becomes a
discrete-log problem instead of a hash it can evaluate.

**NOT achieved, and must not be claimed:**
- **No forward secrecy.** A static ECDH pair means one compromised device key
  decrypts that pair's entire v2 history. Real ratcheting is out of scope here.
- **No authentication of the public key.** The server hands out
  `User.publicKey`; a malicious server could substitute its own and MITM a new
  conversation. Mitigating that needs a safety-number/fingerprint the two users
  compare out of band — **deliberately deferred to Phase 2**, and until it
  exists the copy must not promise protection against the server itself.
- **v1 rooms are not retroactively fixed.** They cannot be.

### 5. Copy is corrected now, not when the crypto lands

The false claims are fixed in this phase independently of the derivation work,
because they are false *today*. New copy states what is true per room version
and does not claim protection the implementation does not provide.

## Consequences

- Users on two devices cannot share a v2 conversation until multi-device key
  sync exists; a second device generates a different identity key. This is a
  known regression versus v1's "derive it anywhere" behaviour and is the price
  of the key being secret. Flagged for Phase 2.
- A peer with no `publicKey` (every existing user, until they next open the app)
  cannot start a v2 room. `reach()` falls back to v1 in that case and marks the
  room accordingly, so chat never breaks — it degrades visibly.
- `window.__reach` (`reach.js:227`) is removed in this phase; leaving a live
  handle to room objects on `window` would undo the work.

## Alternatives rejected

| Option | Why not |
|---|---|
| Wipe history, single scheme | Destroys user data; the owner explicitly rejected it |
| libsignal / Double Ratchet | AGPL-3.0 contagion; also far larger than the problem |
| Keep cyrb53, add a server-held salt | The server holds the salt — this changes nothing |
| Password-derived room keys | Requires users to share a secret out of band; unusable |
| Extractable keys in localStorage | Any XSS exfiltrates the identity key permanently |
