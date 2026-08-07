# Moments video upload — diagnosis

**Date:** 2026-08-07 · **Commit under test:** `6f5ff9f` (web) / api `buildId 1963ad89dc892400`
**Mission:** diagnose only. **No fix was applied.**

---

## Verdict

**The client refuses the file before any request is made.** `MAX_VIDEO_BYTES` in
`spotme/web/src/views/moments.js` is **50 MB**. A real iPhone 4K clip of 30–60 s
is **150–400 MB**. The composer's `change` handler returns early, `picked` is
never assigned, no preview is drawn, and `POST /api/v1/moments/media` is
**never issued**.

That is exactly the reported symptom — "the server appears never to receive the
video" — and it is literally true: there is no request to receive.

The reason it reads as a **hang** rather than a refusal is separate and is the
more damaging half:

1. the refusal text is written to `.mo-substatus`, the **last element in a
   scrolling sheet**, below the Post button — off-screen at 390×844; and
2. because `picked` stays null, **no preview appears either**, so picking a
   video looks identical to the picker having done nothing at all.

Press Post and it says *"Add a photo, a video, or something to say."* — also
below the fold. Nothing anywhere says "too big" where the reader is looking.

**Size is the whole story. Type is not.** A 39.9 MB QuickTime `.mov` uploads,
transcodes, stores and posts correctly.

---

## 1. Every network request the composer makes, in order

There is **no presign and no PUT to storage** in the Moments path. That flow
exists for chat media (`/api/v2/media/*`); Moments posts the raw bytes to the
API, and the API writes to R2 itself. `createUploadSlot()` — which returns a
presigned upload URL — **exists in `MomentMediaService` but no controller route
exposes it.** (See the fix proposal; this is the seam the mission expected.)

### D — `under50.mov`, 39.92 MB, 30 s, QuickTime → **WORKS**

```
 24493ms  --   PICKING under50.mov (39.92 MB)
 24515ms  ->   POST /api/v1/moments/media
 24546ms  ==   status: "Uploading… 0%"
 25955ms  ==   status: "Uploading… 76%"
 26659ms  ==   status: "Uploading… 99%"
 34653ms  <-   POST /api/v1/moments/media  201  (10138ms)
 35106ms  ==   status: "Ready"
 35108ms  --   PRESSING POST
 41137ms  ->   POST /api/v1/moments
 43732ms  <-   POST /api/v1/moments  201  (2595ms)
 46290ms  ==   status: "(composer closed)"
```

### A — `iphone4k.mov`, 209.21 MB, 3840×2160, 35 s → **FAILS**

```
 24639ms  --   PICKING iphone4k.mov (209.21 MB)
 24666ms  ==   status: "That file is 209.2 MB — the limit is 50 MB."
 64794ms  --   PRESSING POST
 64813ms  ==   status: "Add a photo, a video, or something to say."
```

`grep -c "moments/media"` over the whole capture: **0**. No presign, no PUT,
no `POST /media`, no `/edit`, no `POST /moments`. **Nothing is sent.**

### B — `photo.jpg`, 0.35 MB → WORKS (`/media` 201 in 2351 ms, `/moments` 201)
### C — `small.mp4`, 0.05 MB, 3 s → WORKS (`/media` 201 in 2715 ms, `/moments` 201)

No `/edit` call in any run: the trim bar was never dragged, so the composer
correctly sends no edit.

## 2. Full response body of the first failing request

**There is no failing request.** The failure is client-side, before the network.

The nearest thing to a failing request is the secondary MIME case (§7b), whose
body is verbatim:

```json
{"error":"media_refused","reason":"bad-mime"}
```

## 3. Browser console errors, including CORS

**No CORS error of any kind, in any run.** No preflight failure; `OPTIONS
/api/auth/guest → 204` appears in the Railway HTTP log, so preflight works.

The only console errors were repeated:

```
WebSocket connection to 'ws://…/socket.io/?EIO=4&transport=websocket' failed:
Error during WebSocket handshake: Unexpected response code: 400
```

**This is a harness artefact, not a finding** — the localhost relay below does
not implement HTTP upgrade. Flagged so nobody chases it.

## 4. Does the storage object exist afterwards?

**Yes, for uploads that are actually sent.** After posting `under50.mov`:

| | |
|---|---|
| `POST /api/v1/moments/media` | `201`, `mediaId` returned |
| `POST /api/v1/moments` | `201` |
| `GET /media/:id/url` | `200`, absolute presigned R2 URL |
| `GET` the object itself | **`200`, 41,859,918 bytes, `video/mp4`** |

Stored as `video/mp4` though uploaded as `video/quicktime` — the ingest
transcode ran and the bytes are intact. Storage, transcoding and the R2 path
are all healthy.

For the 209 MB file no object exists, because nothing was ever uploaded.

## 5. Does `/api/v1/moments/media` log a request at all?

**No — confirmed server-side.** Railway HTTP logs across the 4K browser run
(15:14:54–15:15:10Z) contain **zero** `/api/v1/moments/media` entries from
`HeadlessChrome`. The only entries in that log window are from `curl/8.5.0`
— my own later probes:

```
15:15:55  POST /api/v1/moments/media   201  5334ms   curl/8.5.0
15:16:03  POST /api/v1/moments/media   400   569ms   curl/8.5.0   (the bad-mime probe)
```

The bytes never leave the phone. Independent confirmation of §1.

## 6. Does the raw body parser still apply to the upload route after `8ea8311`?

**Yes — the mount point still parses raw, and only the mount point.** Both
halves verified:

- **Still applies at `/api/v1/moments/media`**: the 39.92 MB `.mov` returned
  `201` and the stored object is 41,859,918 bytes of valid `video/mp4`. Bytes
  arrived whole. If `onlyAtMountPoint` had over-matched, this would have
  returned `expected raw media bytes`.
- **No longer applies to children**: `POST /media/:id/edit` with `coverAtMs:-1`
  now returns `400`, where before `8ea8311` it returned `201` with nulls.

`8ea8311` is not implicated in this bug.

## 7. Does size or type matter?

**Size, decisively. Type, not at all.**

| File | Size | Container | `POST /media` | Result |
|---|---|---|---|---|
| `photo.jpg` | 0.35 MB | JPEG | `201` | posts |
| `small.mp4` | 0.05 MB | MP4 | `201` | posts |
| `under50.mov` | 39.92 MB | **QuickTime** | `201` (10.1 s) | posts |
| `iphone4k.mov` | **209.21 MB** | QuickTime | **never sent** | **fails** |

The cliff is the 50 MB cap, not the container. `video/quicktime` is accepted and
transcoded (`ACCEPTED_INPUT_MIME` in `moment-media/normalize.ts`).

### 7b. A second, independent failure mode: empty `file.type`

The iOS Files picker can hand back a `File` with `type === ''`. The client then
sends `application/octet-stream`, and the server refuses:

```
POST /api/v1/moments/media  (Content-Type: application/octet-stream)
-> HTTP 400  {"error":"media_refused","reason":"bad-mime"}
```

Two consequences: the file is refused even when it is a perfectly good `.mov`;
and `isVideo` is false, so it is measured against `MAX_IMAGE_BYTES`. Both caps
are currently 50 MB so the size outcome is unchanged today, but they are
separate constants and will drift.

---

## Where the numbers live

| | |
|---|---|
| `MAX_VIDEO_BYTES` / `MAX_IMAGE_BYTES` | `spotme/web/src/views/moments.js:106-107` — 50 MB each |
| `MAX_UPLOAD_BYTES` | `spotme/backend/src/moment-media/media.service.ts:28` — 50 MB, marked `[PROPOSED] ceiling` |
| express raw limit | `spotme/backend/src/main.ts:218` — `'50mb'` |

All three agree at 50 MB, so raising one alone changes nothing.

---

## Method, and its limits

Chromium in this container has **no outbound egress**, so the browser was
pointed at two local streaming relays — `:8080 → spotme-messenger.vercel.app`,
`:8081 → api-production-0a4ca…`. Two ports, not one, deliberately: the
mechanisms that could swallow a request before it is sent (CORS preflight, a
streamed `File` body) only exist when page and API are on different origins,
which is the deployed topology. Bodies are piped, never buffered, so the relay
is not itself the memory ceiling under test. The only content rewritten is the
build-time API base inside the bundle.

**What this does not prove.** It is Chromium on Linux, not Safari on iOS.
Timings include an extra local hop and are not phone numbers. iOS-specific
behaviour — HEVC handling, `File` streaming from the Photos library, Safari's
own request limits — is untested here. The 50 MB refusal is independent of all
of that: it is a size comparison in JavaScript that runs before any platform
behaviour is reached, and it is the same code the phone runs.

Test files were generated with ffmpeg to iPhone-like parameters (4K30, ~50 Mbps
H.264 + AAC in a QuickTime container). All probe accounts created against
production were deleted.

---

## Proposed fix — NOT APPLIED

Three layers. The first is a one-line-class change that turns a silent hang into
an honest refusal; the third is the real answer.

### Layer 1 — stop it reading as a hang (do this regardless)

The refusal already exists and is already correct; it is simply invisible.

- Surface it through `ctx.toast()` as well as `.mo-substatus`, so it appears
  over the sheet rather than under it.
- State the limit **before** the pick, next to "Choose photo or video".
- Keep the sheet scrolled to the status line when it changes.

This alone converts "videos don't load and Post never posts" into "that video is
too big", which is a different bug report and a much cheaper one.

### Layer 2 — fix the empty-MIME case

When `file.type` is `''`, infer from the filename extension before choosing a
cap or a `Content-Type`; and/or have the server sniff the container rather than
trusting the header. Today a good `.mov` from the Files picker is refused with
`bad-mime` for no reason the reader can act on.

### Layer 3 — make large video actually work

50 MB cannot hold the video an iPhone produces. The cap is low because
**the whole body is buffered in the Node process** by `express.raw` before the
service sees it; raising the number alone raises memory per concurrent upload
in direct proportion.

The seam for the right fix **already exists and is unused**:
`MomentMediaService.createUploadSlot()` returns a presigned storage URL, and
`IStorageAdapter.getUploadUrl()` is implemented. No controller route calls it.

Recommended shape:

1. Expose a presign route for Moments — client asks for a slot, `PUT`s the bytes
   **directly to R2** (multipart for large files), then calls a small "commit"
   endpoint with the `mediaId`. Bytes never transit the Node process, so the
   ceiling becomes a storage and transcode question rather than a heap question.
2. Raise `MAX_VIDEO_BYTES` / `MAX_UPLOAD_BYTES` together to something that fits
   real footage (≥ 300 MB), and keep the express raw limit only for the small
   photo path if the direct-PUT route supersedes it.
3. Server-side transcode already normalises `.mov → .mp4`; with direct PUT it
   moves off the request path, which also removes the 10 s inline transcode seen
   on the 39.9 MB clip.
4. Optionally, client-side downscale before upload for very large clips. Worth
   noting that iOS Safari's WebCodecs support is uneven, so this should be an
   optimisation on top of (1), never the mechanism that makes posting work.

**Sequencing:** Layer 1 is safe to ship immediately and independently. Layer 3
is an architectural change and wants its own plan and review — it touches the
storage seam, adds routes, and changes where transcode happens.
