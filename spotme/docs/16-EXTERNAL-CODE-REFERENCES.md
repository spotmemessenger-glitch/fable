# External Code References

A register of third-party codebases examined for Spot Me: what each is
genuinely useful for, and what its licence permits. None of these is a
dependency. Nothing here is vendored into this repository.

**Written:** 2026-08-02. Claims are tagged MEASURED (checked in the session
container on that date) or UNVERIFIED.

## The rule that governs this file

**No licence file means all rights reserved.** Public visibility on GitHub
grants the right to view and fork in place; it grants **no** right to copy code
into this repository. For any entry below marked *no licence*, the permitted
use is **reading it to understand an approach, then writing our own**. Do not
paste, adapt line-by-line, or vendor. When in doubt, ask the owner before
borrowing anything more specific than an idea.

---

## 1. `kumarharsh13/instagram-clone-fullstack`

<https://github.com/kumarharsh13/instagram-clone-fullstack>

A full-stack Instagram-style social app. Two packages in one repo:
`chhavi-anvaya-backend` (Express + Sequelize + PostgreSQL) and
`chhavi-anvaya-frontend` (React 18 on Create React App). 40 MB at `--depth 1`,
6 stars, last pushed 2026-06-07. MEASURED.

**Licence: NONE.** No `LICENSE` or `COPYING` anywhere in the tree, and GitHub
detects none. Read-only under the rule above. MEASURED.

### What is actually implemented

| Area | State |
|---|---|
| Auth | Real — JWT + `bcryptjs`, with integration tests |
| Social graph | Real — `user`, `post`, `like`, `comment`, `follow`, `notification` models, each with a migration |
| Media upload | Real — `multer` to local `images/` |
| HTTP hardening | Real — `helmet`, `express-rate-limit`, `compression`, `cors`, `morgan`, `cookie-parser` |
| Tests | 5 Jest files — 3 integration (auth, protected, users), 2 unit (auth, post controllers) |
| Indexing | A dated `add-indexes` migration — someone thought about query performance |
| **Chat / realtime** | **Absent.** See below |

### The trap: there is no chat

The repo advertises chat, and both `socket.io` and `socket.io-client` are
declared dependencies — but **`routes/chatRoutes.js` is 0 bytes, and `socket`
is never imported anywhere in the source.** There is no message model and no
message migration; the only `message` field in the schema is a `STRING` on
`notification`. The realtime feature does not exist. MEASURED.

Do not come here looking for Socket.IO patterns. Spot Me's own
`spotme/web` + backend already carry a real Socket.IO integration.

### What it is worth to Spot Me, honestly

Narrow but non-zero, and only for **Priority 7 (Communities, Channels and
Social Features)**: the follow/like/comment/notification schema is a reasonable
shape reference for a social graph, and the index migration shows which columns
that access pattern actually needs.

Weigh that against four mismatches:

1. **Opposite architecture.** This is a server-centric plaintext app whose
   backend reads all user content. Spot Me is P2P and end-to-end encrypted, and
   its server explicitly must not. Nothing about its data flow transfers.
2. **Wrong ORM.** It uses Sequelize; Spot Me uses Prisma (roadmap §7). Models
   and migrations are not portable, only their shape.
3. **Its `notification` model is not push.** It is an in-app DB row. Spot Me's
   top priority is real push delivery via FCM/APNs to backgrounded and
   terminated apps — a different problem entirely. This is no help there.
4. **Deprecated frontend tooling.** Create React App / `react-scripts` 5;
   Spot Me web is Vite.

**Verdict:** a competent portfolio-grade CRUD app. Useful as a schema shape
reference for Priority 7 and nothing else. It is not a reference for chat,
realtime, push, media at scale, or anything security-related.

### Hygiene note

No real secrets are committed — only `.env.sample` files with obvious
placeholders (`your_jwt_secret_key`, `postgres://postgres:password@localhost`).
Clean on that front. MEASURED.
