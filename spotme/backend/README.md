# Spot Me — backend (server-tier rewrite)

The client-server companion to `spotme/web` (P2P) and `spotme/server` (P2P relay
peer). This is the NestJS + Postgres backend from the migration blueprint —
auth, chat relay, nearby accept/reject, moderation, and the admin dashboard API.

## Design constraints (do not relax these without re-reading the compliance memo)

- **The server never stores message plaintext or holds a decryption key.**
  `Message.cipherText` is opaque; clients encrypt/decrypt. The only path
  content ever reaches a human is a user-filed `Report`, which carries
  reporter-supplied plaintext — see `moderation.service.ts`.
- **No per-user location history.** `Presence` is one row per user, overwritten
  in place. There is no location log table, on purpose.
- **Nearby-only accept/reject gate.** `chat-requests.service.ts`: `NEARBY`
  requests are `PENDING` until the recipient responds; every other source
  (`USERNAME`, `LINK`, `CONTACT`, `BLUETOOTH`) opens a conversation immediately.
- **CSAM reporting is a real legal obligation, not a feature toggle.**
  `ncmec.service.ts` fails loudly (not silently) until `NCMEC_API_KEY` is
  provisioned — do not stub it into a fake success response.

## Local setup

```bash
cp .env.example .env
# fill in DATABASE_URL (a free Neon project works), JWT secrets

npm install
npm run prisma:migrate      # creates tables from prisma/schema.prisma
npm run start:dev           # http://localhost:4000/api

# first login for the dashboard:
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_NAME="You" SEED_ADMIN_PASSWORD='change-me' \
  npm run build && npm run seed:employee
```

## Deploying

Railway or Fly.io both build straight from the included `Dockerfile`. Point
`DATABASE_URL` at Neon, keep `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` in the
host's secret manager (never in the repo), same pattern `spotme/web`'s
`PUSH.md` already documents for its own secrets.

## What still needs wiring before this is production-ready

- OTP email delivery (`RESEND_API_KEY` — currently returns the code directly
  in non-production so you can test without an email provider)
- NCMEC CyberTipline API credentials (`NCMEC_API_KEY`) — required before any
  real user-generated media ships
- FCM/APNs push credentials
- R2 bucket + upload signing for media (`mediaKey` field is ready for it)
- Age-verification vendor for the Nearby/Discovery 18+ gate

See `spotme-server-blueprint` artifact from this session for the full
architecture, cost breakdown, and legal-compliance research behind these choices.

## Session handoff (2026-07-26)

**Verified working**: `npm install && npm run prisma:migrate && npm run start:dev`
against a local Docker Postgres (`docker run --name spotme-postgres -e
POSTGRES_PASSWORD=spotme_dev_pw -e POSTGRES_DB=spotme -p 5433:5432
postgres:16-alpine`), seeded one admin employee, logged into
`spotme/admin-dashboard` successfully. A real DI bug was found and fixed by
actually running it: `ModerationModule`/`AdminModule` used `AuditService`
without importing `AuditModule` — TypeScript compiled fine, NestJS's runtime
DI graph didn't. Re-run the full boot sequence after any module-wiring change,
don't trust `tsc` alone.

**Also added since the base build**: `GET /api/users/lookup?username=` (public-safe
fields only) via `UsersLookupController` in `users.controller.ts` — the mobile
app's Discovery tab uses this to start a chat.

**Not yet done, still real gaps**: OTP email, NCMEC credentials, FCM/APNs, R2,
age-verification vendor (all listed above) — plus the local dev DB is a
throwaway Docker container, not the planned Neon instance.

## Session handoff (2026-07-27)

Added **Groups** (`src/groups/`) and **Stories** (`src/stories/`) modules,
migrated (`20260726185609_groups_and_stories`), and verified live end-to-end
against the local Docker Postgres (create/list/membership/authorization for
groups; create/feed/view/authorization/delete for stories — see
`spotme/mobile/README.md`'s matching handoff for the client-side proof).

- **Group is a metadata layer on a `kind:"group"` Conversation** — membership
  is just `ConversationParticipant` rows on that conversation, so the existing
  `/chat/*` REST endpoints and Socket.IO gateway (which already fan a message
  out to every participant, not just two) needed zero changes to support group
  messaging.
- **Story is text-only for now** — photo stories need the R2 upload pipeline,
  which isn't wired (see the gap list above), so `kind: 'photo'` isn't accepted
  rather than faking a media path with no storage behind it. 24h expiry,
  contacts-only visibility (anyone sharing a conversation with the viewer).
