# External Code References

A register of third-party codebases examined for Spot Me: what each is
genuinely useful for, and what its licence permits. None of these is a
dependency. Nothing here is vendored into this repository.

> **Standing owner instruction (2026-08-02): do not touch Spot Me.** These
> checks are reference only. Nothing in `spotme/` may be modified as a result
> of anything in this register — no dependency, no config, no code. That is why
> this file lives in `research/`. Evaluate, measure, record; change nothing.

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

---

## 2. `TowhidKashem/snapchat-clone`

<https://github.com/TowhidKashem/snapchat-clone> — live demo at
<https://towhidkashem.github.io/snapchat-clone/>

A Snapchat UI clone. TypeScript, React 16 + Redux Toolkit, SASS, tested with
Cypress + Jest + Enzyme, Storybook, ESLint + Prettier. Frontend only — there is
no backend, no auth and no real messaging. 62 MB checked out, 1,134 stars, last
pushed 2026-03-12. MEASURED.

**Licence: MIT**, real `LICENSE` file, © 2020–present Towhid Kashem. The first
entry in this register that we may actually borrow code from, subject to
retaining the copyright notice.

### Is it genuine?

Yes. Real named author with a live hosted demo, a coherent commit history, a
component library under `src/components`, real test infrastructure and
Storybook. Nothing obfuscated, no suspicious network calls, no committed
secrets. It is a well-executed portfolio project, not a content farm or a
malware vector.

### Would I build on it? No — the stack is five years stale

Recent commit dates are misleading; the *dependencies* are 2020-era and were
never refreshed:

| Dependency | Pinned | Problem |
|---|---|---|
| `react` | 16.13.1 | three majors behind |
| `react-scripts` | 3.4.1 | Create React App, deprecated |
| `react-router-dom` | 5.1.2 | two majors behind |
| `@reduxjs/toolkit` | 1.4.0 | one major behind |
| `enzyme` + `enzyme-adapter-react-16` | — | Enzyme is effectively dead; no official adapter past React 16 |
| `node-sass` | — | deprecated; breaks on modern Node |
| `mapbox-gl` | 1.11.1 | v2+ changed licensing/token terms |

None of this matches either JS host here: `spotme/web` is Vite + vanilla JS,
`ysnap` is Next 15 / React 19.

### Two things to know before running `npm install`

1. **It auto-clones a second repository over SSH on postinstall.**
   `install-filter-deps` runs `git clone git@github.com:jeeliz/jeelizFaceFilter.git`,
   resets to pinned commit `bd3cdcd0`, then runs `gulp`. Pinning is good
   practice, but this is an automatic external fetch during install and it
   **requires configured SSH keys** — it will fail in a container or CI without
   them. MEASURED (read from `package.json`).
2. **It depends on third-party demo services**, not just its own code:
   `api.allorigins.win` (a public CORS proxy), `geolocation-db.com`,
   `metaweather.com`, `picsum.photos`, `randomuser.me`. Demo-grade
   dependencies, not production patterns. Their current liveness is
   **UNVERIFIED** — this container's proxy blocks them, and a failed connection
   here is not evidence a service is down.

### The actually valuable find: `jeeliz/jeelizFaceFilter`

<https://github.com/jeeliz/jeelizFaceFilter> — **Apache-2.0**, 2,922 stars, 546
forks, maintained by the Jeeliz organisation, last pushed 2025-11-14. A
lightweight WebGL + JS library for real-time multi-face detection, tracking and
AR face filters, with integrations for Three.js, Babylon.js, Canvas2D and
CSS3D.

This matters because it is a **client-side** face-filter path with a permissive
licence — potentially the AR capability Camera Kit was wanted for, without a
vendor SDK phoning home to Snap's backend, which is the objection that got
Camera Kit backed out (see `ar-platform-reference.md` §3 and §7). `ysnap`
already carries `three`, `@react-three/fiber` and `drei`, so its Three.js
integration path would drop in naturally.

**UNVERIFIED and required before anyone acts on this:** whether the library is
genuinely offline-only (model weights bundled, no runtime callbacks), its
bundle and model size, and whether Apache-2.0 covers the pretrained neural
network weights as well as the source. Do not treat "no vendor backend" as
established — it is a hypothesis worth one session of checking.

### Verdict

**Genuine, and useful — but as a reading reference and a lead, not a base.**
Take from it: Snapchat-style UI and interaction patterns, and the pointer to
jeelizFaceFilter. Do not take: the dependency stack, the build tooling, or any
architectural cue for Spot Me, which is P2P and end-to-end encrypted where this
is a stateless UI shell over public demo APIs.

---

## 3. `Sai-Kumar-Kanuri/Snapchat-Clone` — REJECTED

<https://github.com/Sai-Kumar-Kanuri/Snapchat-Clone>

Next.js 14 App Router, TypeScript, MongoDB/Mongoose, Tailwind + Radix
(shadcn/ui), NextAuth v5 beta, Cloudinary. **2,010 lines** of TS/TSX total.
Created and last pushed on the same day, 2024-01-29, about 85 minutes apart.
1 star. **No licence file** — all rights reserved. MEASURED.

### Its headline claim is not accurate

The repository describes itself as a *"Real-time messaging app."* **There is no
real-time mechanism in it.** MEASURED, three ways:

- No realtime library is declared in `package.json` — no Socket.IO, Pusher,
  Ably, Supabase, Firebase, PartyKit or `ws`.
- No `WebSocket`, `EventSource`/SSE, or polling (`setInterval`,
  `refetchInterval`) anywhere in `app/`, `lib/` or `components/`.
- The actual send path in `lib/action.ts` is a server action that writes the
  message to MongoDB and then calls `revalidatePath()`.

`revalidatePath` invalidates the Next.js cache, which refreshes **the sender's
own** view on their next render. The receiver sees nothing until they reload
the page. That is request-response CRUD, not realtime — and it is worth
knowing that an earlier grep appeared to find realtime code only because
`isSelected` and `isSendingMessage` contain the substrings `sse` and `socket`.

### Nothing here transfers to Spot Me

| This repo | Spot Me |
|---|---|
| `content: String` stored plaintext in MongoDB, server-readable | P2P, end-to-end encrypted; the server must not be able to read content |
| MongoDB + Mongoose | PostgreSQL + Prisma (roadmap §7) |
| Cloudinary | Cloudflare R2 / S3 (roadmap §7) |
| No realtime at all | A real Socket.IO integration already shipped |
| NextAuth v5 **beta** | not a production auth reference |

Its one genuinely Snapchat-ish idea, a `opened: boolean` on the message model
for view-once semantics, is a concept Spot Me already implements and tests
(`spotme/web/test/viewonce.test.js`).

### Hygiene note

No secrets are committed. Credentials are read from `process.env`
(`MONGODB_URI`, `AUTH_SECRET`, `CLOUDINARY_*`) and no `.env` file is in the
tree. Clean. MEASURED.

### Verdict

**Rejected — do not spend time here.** A small single-sitting portfolio
project, unlicensed, whose headline feature does not exist. It is behind Spot
Me on every axis that matters. Logged so it is not re-examined.
