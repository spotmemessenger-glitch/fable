# StorageProvider port — S3-compatible, swappable by config

**Status:** the port already exists on `master`; this document formalizes it and
records the future media-processing seam. No runtime change.

## The port

`spotme/backend/src/storage/storage.interface.ts` defines **`IStorageAdapter`** —
the StorageProvider port. Four methods, deliberately narrow (the same discipline
as the transport adapters, ADR-002):

```
getUploadUrl(objectKey, contentType) → presigned PUT URL
getDownloadUrl(objectKey)            → presigned GET URL
deleteObject(objectKey)              → idempotent delete
deleteRoomObjects(roomId)            → prefix sweep for a room
```

Selection is by config: **`STORAGE_PROVIDER=local|s3`** (default `local`),
resolved in `storage.module.ts` behind the `STORAGE_ADAPTER` DI token. Consumers
(`media.controller.ts`, `storage-cleanup.service.ts`) depend only on the
interface, never on a concrete store.

## Swappable by config — S3 / R2 / Backblaze / MinIO

`s3-storage.adapter.ts` is **S3-compatible**: the same adapter serves AWS S3,
Cloudflare R2, Backblaze B2, and a local MinIO. Only environment changes (see
`.env.example`):

| Target | `S3_ENDPOINT` | `S3_REGION` | path-style |
|---|---|---|---|
| AWS S3 | *(empty)* | real region | off |
| Cloudflare R2 | `https://<acct>.r2.cloudflarestorage.com` | `auto` | on (auto) |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | region | on (auto) |
| MinIO (dev/CI) | `http://localhost:9000` | any | on |

`forcePathStyle` turns on automatically when `S3_ENDPOINT` is set (R2/MinIO/B2
require it; real S3 ignores it). CI already exercises the S3 adapter against
MinIO (`.github/workflows/ci.yml`), which verifies request signatures.

## The E2EE boundary — non-negotiable

The adapter **never sees plaintext and never holds a key**. Attachment bytes are
sealed on the client; the adapter allocates a key-shaped string, hands back a
URL, and deletes bytes. `FORBIDDEN_STORAGE_SURFACE` and `test/storage.spec.ts`
assert it cannot grow `decrypt`, `thumbnail`, or `transcode` — server-side
thumbnailing would require plaintext and would silently end E2EE.

## Future media-processing seam — FFmpeg / libvips via BullMQ

Media transforms (transcode, thumbnail, resumable-upload assembly, malware
scan) belong on an **asynchronous worker**, not on the request path and not
inside the StorageProvider. The seam:

- A **`{media}` BullMQ queue** (same ioredis/Dragonfly runtime and hash-tag
  convention as `{maintenance}`, item 4) runs **FFmpeg** (video) and **libvips**
  (images) jobs off the hot path, with retries + DLQ.
- **It operates only on media the server is permitted to read** — non-E2EE or
  explicitly client-authorized-plaintext assets (e.g. public Discovery/Exchange
  imagery). It **never** touches E2EE room-attachment ciphertext; that path
  stays sealed and the StorageProvider prohibition above still holds.
- Outputs are written back through the **same StorageProvider port** as new
  objects — the worker is just another client of `getUploadUrl`, so a media
  variant lands wherever the configured store is (S3/R2/B2/MinIO) with no new
  storage code.

This keeps three concerns cleanly separated: **storage** (this port),
**processing** (a future `{media}` worker), and **encryption** (client-side,
untouched).
