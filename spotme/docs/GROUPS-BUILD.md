# Groups v2 — build progress

Living checklist for the Group Creation & Management build. Update in place.

## Decisions (from the user, 2026-07-30)

1. **Public groups use a server-held room key** → instant join by `@username`.
   The server CAN decrypt public-group messages. This is deliberate.
   **Private groups keep strict E2E** — the key travels only in the invite-URL
   fragment, which never reaches the server.
2. **Unify onto one model.** The room-based group system is the single source
   of truth; the old `/api/groups` REST stack (Conversation +
   ConversationParticipant) is ported onto it, not kept in parallel.

## Architecture

A group = a `Group` row keyed by `roomId`, riding the existing room transport
(`RoomEvent` ciphertext + `RoomMember`). Roles and permissions are enforced
server-side and never require the server to read message content.

Username namespace is **shared with users**: `usernameCheck` must consult both
`User.username` and `Group.username`, or a group could shadow a person.

## Phases

- [x] **P1 schema** — DONE. Migration `20260730120000_groups_v2_roles_permissions`
      applied locally; hand-written because the required `roomId` needed a
      backfill. It also ports legacy `ConversationParticipant` rows into
      `GroupMember` and seeds `RoomMember`, so migrated groups stay reachable.
      Verified: the one legacy group got a 32-hex room, OWNER+MEMBER rows and
      2 RoomMember rows.
- [x] **P2 backend** — DONE, 17 tests passing (26 across the suite).
      `groups.service.ts` (roles, granular grants, ban/mute, transfer,
      soft delete + purge sweep), 16 REST routes, and — the part that matters —
      **enforcement in `rooms.gateway.ts`**, since the gateway previously
      authorised nothing and a ban would have been decorative.
      `auth.service.usernameCheck` now spans both namespaces.

      Bug caught by the tests: `setBan` stamps `leftAt` as well as `bannedAt`,
      and `requireMember` tested `leftAt` first — so a banned user was told
      "not a member". Ban now takes precedence.

      **Known limit — delete permission.** The id of the message being deleted
      lives inside the ciphertext, so the server cannot tell whose message it
      is. Clients must send the original sender as cleartext `meta.owner` (the
      same routing-only channel attachments use); when it is absent the delete
      is allowed, so older clients keep working. Until the web client sends it,
      "delete others' messages" is enforced client-side only.
- [ ] **P3 web UI** — 3-step creation wizard, roles/permissions management,
      chat-list integration, animations 150-250ms.
- [ ] **P4 port** — move the Expo mobile app + admin dashboard off
      `/api/groups` onto the unified model, then delete the old stack.
- [ ] **P5 verify** — backend tests + two-browser E2E.

## Traps

- `npm run deploy` in `spotme/backend`, never plain `railway up` (it skips
  staging `web/api` and every `/api/*` route 404s).
- **The staging directory must never be gitignored.** It was `.deploy/`, which
  `.gitignore` excluded, and `railway up` skips gitignored paths — so the files
  never reached the build context, the Dockerfile's assert failed the build,
  and Railway silently kept serving the PREVIOUS container. That is why a full
  day of translate/Sarvam work looked deployed but production never changed.
  A `.railwayignore` does NOT fix it (it only adds exclusions). Staging is now
  `deploy-api/`: untracked, but not ignored, so it uploads.
  Fixed 2026-07-30; production now reports
  `{"engine":"sarvam+azure/openai","confirmed":true}`.
- Web payloads must stay base64 text end-to-end — Buffers break socket.io
  framing (see the 2026-07-30 morning fix, commit `8e1853c`).
- The web app's groups.js today says "no admin, no server". That copy and the
  whole no-roles assumption are being replaced.
