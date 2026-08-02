# Threat model — Push Notification Platform foundation (Priority 2, PR A)

Scope: the additive `backend/src/notifications/` foundation as built (content-less
floor; encrypted envelope is a seam only). Frame: **the server is the adversary
for content; the push providers (Apple/Google/Mozilla) are the adversary for
everything in the payload; the notification log is an adversary for anything
persisted** (design §4, `17-CRYPTO-IMPLEMENTATION-GUIDE.md` §0).

## Adversaries and what they can see

| Adversary | Sees (as built) | Cannot see | Control |
|---|---|---|---|
| **Push provider** (FCM/APNs) | device token, an opaque collapse id, generic title/body ("Alice", "New message"), priority/TTL, metadata `data` (`class`, `count`, opaque notif id) | message content, room id, route, cross-user/-device correlation of collapse ids | content-less builder; opaque `SHA-256` collapse id replaces cleartext `tag:roomId`; per-recipient collapse salt |
| **Web Push endpoint** | encrypted body already (RFC 8291), TTL/urgency | body plaintext (protocol-blind) | reuse existing `p256dh/auth`; no new key |
| **Notification log (DB)** | recipientId, roomId, class, timing, status, provider code | message content (no content column exists), any key material | schema has **no** content column; `lastError` stores provider codes only |
| **Spot Me server** | routing metadata (its job), mute/DND prefs | message plaintext (E2E boundary untouched) | no envelope decryption capability; no notification private key held |

## Invariants preserved (design §4.4, ADR-008 §12)

- **No message content in any payload or table, ever** — enforced by type (no
  content field) and by the `no-content` assertions in `isolation.spec`.
- **No notification key generated or persisted** — `EncryptedEnvelopeBuilder`
  throws; the key-generation fence (`isolation.spec`) scans the whole module for
  `generateKeyPair`/`subtle.generateKey`/`createPrivateKey`/`notifPriv` and
  asserts none. ADR-008 §12 hard stop is **not engaged**: no signing key,
  prekey, X3DH, or ratchet is created, published, or read.
- **No coupling to Priority-1 crypto** — the module imports nothing from
  signing/ratchet/x3dh/prekey/e2e/`web/src` (build-breaking fence).
- **Deep links carry routing, never authorisation** — a route only opens a
  screen the recipient is already entitled to; `join` re-authorises (design
  §10.3). (Producer/route wiring is P10; the invariant is recorded here.)
- **Preferences are policy, not secrets** — per-user rows keyed by JWT subject;
  no cross-user disclosure; no key material (design §9.4).

## Residual risks (documented, not silently accepted)

- **Provider learns which pushes collapse together** — the opaque collapse id is
  stable per (recipient, room) so the provider sees an *anonymised* per-device
  activity cluster (never the room, never cross-user). This is the minimum for
  provider-side collapse to function; the alternative is a buzz per message
  (design §18.6). The full **per-device keyed** pseudonym (needs a registered
  `collapsePub`) is the gated seam and is not shipped.
- **Server holds mute/DND schedules** — new server-side metadata it could
  partially infer from activity anyway; a posture change to confirm (design
  §18.4). No content, no keys.
- **Mentions still need a cleartext "mentions @X" routing signal** — the
  envelope hides it from the provider but the server needs it to route a mention
  as a mention; unresolved owner decision, so `mention` stays OFF (design §18.1).
- **Rich native content requires an on-device decrypt key** — deferred to the
  gated encrypted seam + P10 native services; until then the content-less floor
  is the guaranteed (never-worse-than-today) behaviour.

## Abuse surfaces

- **Receipts endpoint** — content-free; idempotent on `(outboxId, deviceId,
  event)`; unknown/expired `notifId` counted, never detailed; must be
  rate-limited per device before it is mounted (design §5.6).
- **Preference writes** — full-resource PUTs keyed by JWT subject; production
  must assert `RoomMember` before storing a per-conversation pref (noted in the
  controller; the membership gate is wired at mount time).
- **Forged enqueue** — impossible: enqueue is an internal producer call, not an
  HTTP route; recipients cannot be addressed by a sender (the shipped `notify`
  no-op documents exactly this).
