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
- [x] **P3 web UI** — DONE, verified in a real browser against the local
      backend (not mocks). `lib/groups-api.js` (16 routes, token reused from
      socket-transport so there is one auth cache, not two),
      `lib/group-perms.js` (pure gates, 11 tests),
      `views/group-new.js` (3-step wizard: name → members → visibility, with
      live @handle availability), `views/group-manage.js` (roles, mute, ban,
      remove, transfer, owner-only permission toggles, delete), and
      `views/groups.js` rewritten to merge the server roster with local convos.
      Route `#/group/<id>` added, full-screen like a thread.

      **Verified live:** create via wizard → group on server with 3 members and
      OWNER role → local convo holds the key; promote to ADMIN; toggle
      membersCanMedia off (persisted); ban → row dims and marks; lift ban →
      fully restored. Web suite 11/11 new + existing; backend 26/26.

      **Three bugs this build exposed, all fixed:**
      1. `ui.js el()` wrote `disabled="false"` for a boolean `false`, and HTML
         reads any present `disabled` as disabled — so the wizard's Create
         button was dead from first paint. Two older call sites had already
         worked around it (`disabled: fn ? undefined : ''`). Fixed in `el()`
         itself: a boolean `false` now omits the attribute. Attributes that
         want the word pass the string `'false'` and are unaffected.
      2. **Un-banning was impossible.** `setBan` stamps `leftAt` as well as
         `bannedAt`, `memberInclude` filtered on `leftAt: null`, and
         `requireTarget` rejected anyone with `leftAt` — so banned members
         vanished from every payload AND the unban route 404'd. Both now check
         ban before leftAt, matching what `requireMember` already did.
      3. Lifting a ban cleared only `bannedAt`, leaving `leftAt` set and the
         `RoomMember` row deleted — un-banned into invisibility, still
         receiving nothing. It now clears both and restores the room row.
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
- **`nest build` can exit 0 and emit NOTHING.** `nest-cli.json` sets
  `deleteOutDir: true` while `tsconfig` sets `incremental: true`, so tsc reads
  a stale `tsconfig.build.tsbuildinfo`, decides there is nothing to emit, and
  leaves `dist/` empty after it was just wiped. `node dist/main.js` then fails
  with MODULE_NOT_FOUND, and — worse — if an OLD server is still holding :4000
  you get a running backend serving code from hours ago. Delete
  `tsconfig.build.tsbuildinfo` before building, and check the route you just
  added actually answers (404 on a new route means a stale process).
- **Vercel was 404 because the project had no Root Directory.** The project is
  git-linked to the repo root, so every push built `/` — no app there, empty
  output, 1s "success" — and that empty deployment then took the production
  alias from the good CLI deploy. Root Directory is now `spotme/web`. If the
  site 404s again, check that setting before anything else.
- The web app's groups.js today says "no admin, no server". That copy and the
  whole no-roles assumption are being replaced.
