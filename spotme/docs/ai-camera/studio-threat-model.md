# Creative Studio — threat model (CAM-4)

Scope: `web/src/lib/studio/**`, `web/api/studio-ai.js`, the
`spotme-studio-drafts` database, and the one `db.js` wipe line. Companion to
`adr/014d-creative-studio.md` §3. Everything below holds in the SHIPPED
state (all flags false) unless a row says "at activation".

## Assets

1. User photos/clips being edited (plaintext pixels, on device).
2. Edit history (op-docs): masks reveal *what* the user hid, text/captions,
   which photos were touched and when.
3. The owner's provider credit (server keys behind /api/studio-ai).
4. The privacy PROMISE itself: "editing is local" must be true, not vibes.

## Trust boundaries

```
photo → [studio CPU/GL, on device] → export blob        (no boundary crossed)
photo → drafts (IndexedDB, this device)                 (at-rest boundary)
photo → cloud adapter → /api/studio-ai → provider       (D1 boundary — DARK)
```

## Findings and dispositions

### T1 — Drafts at rest
Op-docs persist in IndexedDB: masks, text, source refs. **Mitigations:**
never pixels (a doc without its source media renders nothing); the DB joins
`wipeDevice()` (tested — a blocked delete is REPORTED, per db.js's existing
honesty rules); TTL — a draft created from a disappearing-message chat must
be saved with that chat's `msgTtl`, so the edit history dies no later than
the message it edits (the API takes `ttlMs`; the integration checklist in
studio-activation.md makes wiring it a launch gate); LRU keeps the corpus
bounded; corrupt rows are deleted, not resurrected. **Residual:** IndexedDB
is not encrypted at rest beyond OS/browser protections — same posture as
`spotme-media` (blobstore), explicitly accepted at the platform level.

### T2 — Cloud-leg plaintext boundary (owner decision D1)
Any cloud op sends the image plaintext to OpenAI/Google/Azure. **This is off
by DEFAULT and off THREE ways:** client flag (`STUDIO_CLOUD_AI_ENABLED`,
false, parent-gated), server env flag (`STUDIO_AI_ENABLED` absent ⇒ 501
before the body is even parsed), daily budget. The client adapter rejects
BEFORE serializing — the dark state has zero egress, and the test observes
the fetch fake uncalled rather than assuming. At activation: the UI must
label cloud ops as leaving the device (same "cloud" labeling grammar
translate.js established), per-op consent is a product requirement recorded
in studio-activation.md, and provider DPAs/retention are owner homework
before D1 is ratified.

### T3 — EXIF / metadata hygiene on export
A photo's EXIF block carries GPS, device serials, timestamps. **Mitigation
by construction:** the studio reads EXIF for orientation ONLY (bounds-checked
parser, hostile input answers "upright"); every export re-encodes through
canvas, which emits a fresh file with no metadata container at all — GPS is
stripped by default because it is never copied. The threat "metadata
survives an edit" is structurally impossible on this path. **Residual:**
sharing an ORIGINAL (unedited) file bypasses the studio entirely — that path
belongs to media.js and is out of scope here.

### T4 — Hostile documents and masks (parser abuse)
Drafts and (future) shared templates are attacker-shaped JSON. **Mitigations:**
strict schema/kind/version refusal; op registry validation before any pixel
work (a doc failing at op 7 renders nothing, not a half-edit); JSON-purity
and depth caps on params; RLE masks must cover exactly, with run-count caps
so an adversarial noise mask cannot balloon a document; document/op/asset
count and byte caps; timeline fold-over rejection. Corrupt drafts are
skipped, counted, deleted — one poisoned row cannot brick the picker.

### T5 — The endpoint as an open proxy (the translate.js audit, reapplied)
/api/studio-ai spends real money per call and handles user photos.
**Mitigations:** same `_auth.js` gate as every vendor proxy (HS256 pinned,
CORS allow-list, per-user per-minute buckets), image-op limits stricter than
text (6/min), the 501 env gate ahead of body parsing, byte + dimension +
allow-list validation, upstream errors never relayed (they name vendors and
tiers), and a per-user DAILY budget (D5) so a quiet loop cannot run a bill.
**Residual (documented in code):** in-memory buckets are per-instance on
serverless — Redis before any scaled activation; keys are absent from this
repo by policy.

### T6 — Image bytes in logs
The proxy handles photos; a stack trace with a data URL is an exfiltration.
**Mitigation:** error paths log op name + byte COUNT only; the suite drives
a provider failure with a marker payload and asserts the marker never
reaches console output, and the client answer carries no upstream text.

### T7 — Cross-user reference confusion in drafts
Drafts store *refs* (blobstore keys). A forged ref cannot fetch foreign
bytes: blobstore keys are room-scoped on this device and drafts never leave
the device; restoring a draft whose source was deleted renders nothing.

### T8 — Wipe completeness
A wipe that misses the studio leaves edit history behind. **Mitigation:** the
`dropDatabase('spotme-studio-drafts')` line inherits db.js's semantics —
blocked/erroring deletes are reported failures, never silent successes; while
dark the DB never exists and the drop is a no-op success (tested both in this
module's suite and untouched in wipe-device.test.js).

### T9 — Supply chain
Zero new npm dependencies; all algorithms first-principles in-repo; no AGPL.
The one named future dependency (@mediapipe/tasks-vision, Apache-2.0, with
SELF-HOSTED model assets — no runtime CDN) is an owner decision, not code.

## Non-goals (explicitly out of scope here)
E2E encryption of exported media in transit (owned by the messaging crypto
stack); moderation/content policy for templates (owner policy decision,
listed in studio-activation.md); native-app storage encryption.
