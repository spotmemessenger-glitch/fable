# External Code References

**Reference material for future app building. Not connected to any current
work.** None of these is a dependency, none is vendored, and no product code
was changed to produce this register.

A survey of third-party codebases: what each actually is once you look inside,
what its licence permits, and whether it is worth anyone's time. Useful when
picking a starting point or a library for a new app.

**Written:** 2026-08-02, in a remote session container. Claims are tagged
MEASURED (executed on that date) or UNVERIFIED.

### The two lessons worth carrying forward

1. **No licence file means all rights reserved.** Public visibility on GitHub
   grants the right to view and fork in place — never the right to copy code
   into your own project. Three of the four entries below have no licence at
   all. For those, the permitted use is reading to understand an approach and
   then writing your own.
2. **Verify the advertised feature exists before trusting the description.**
   Two of the four advertise real-time messaging and neither implements it —
   one ships a 0-byte route file and never imports `socket`, the other calls a
   cache-revalidation helper and calls it realtime. Check the dependency list,
   not just a grep: `isSelected` and `isSendingMessage` contain the substrings
   `sse` and `socket`, which is enough to fake a positive.

Some entries compare a candidate against an end-to-end-encrypted messenger,
because that was the context these were reviewed in. Read those passages as a
worked example of the right questions — what leaves the device, to whom, and
whether it is user content — rather than as a statement about any current
project.

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

---

## 4. `pingdotgg/uploadthing` — good library, wrong shape for Spot Me

<https://github.com/pingdotgg/uploadthing> — <https://uploadthing.com>

File uploads for TypeScript web apps. **MIT**, 5,183 stars, 428 forks,
maintained by Ping Labs, last pushed 2026-07-07. A well-structured monorepo
built on Effect-TS with first-party adapters for React, Vue, Svelte, Solid,
Nuxt and **Expo**, published as `uploadthing@7.7.4` and
`@uploadthing/react@7.3.3`. MEASURED.

This is the highest-quality repository in this register. The problem is not
quality.

### It is a hosted service, not a library you point at your own bucket

MEASURED, from the source rather than the marketing:

- It requires `UPLOADTHING_TOKEN` — a base64 JSON object of
  `{ apiKey, appId, regions }`. Without it the SDK refuses to start
  (`packages/uploadthing/src/_internal/config.ts`).
- The API base defaults to `https://api.uploadthing.com`, requests carry an
  `x-uploadthing-api-key` header, and files are served from
  `https://uploadthing.com/f/`.
- **No self-host path, no bring-your-own-bucket, no custom storage endpoint**
  appears anywhere in any package's source.

So uploaded files transit and reside on UploadThing's infrastructure. The MIT
licence covers the client SDK; the storage service behind it does not come with
it.

### It has no content encryption

The only cryptography in the codebase is **HMAC-SHA-256 signing** —
`signPayload`, `verifySignature`, `generateSignedURL`, `generateKey`,
`verifyKey` in `packages/shared/src/crypto.ts`. There is **no AES, and no
`encrypt`/`decrypt`, GCM or CBC call anywhere in any package**. MEASURED.

That is entirely reasonable for its intended use, and disqualifying for ours:
media would leave the device in the clear to a third party. For an E2EE
messenger this is a harder conflict than Camera Kit's telemetry was, because
the payload is the user's actual content rather than usage data.

### The decision it would displace is already made and partly built

Roadmap §7 lists **Cloudflare R2 / S3** as the media storage target, currently
"partially validated", with MinIO already running in CI and an `r2-smoke.yml`
workflow already in this repository. Adopting UploadThing would replace a
chosen, partially-implemented, self-controlled path with a hosted one that
cannot satisfy the encryption requirement.

There is also no adapter for `spotme/web`, which is Vite + vanilla JS. The
Expo adapter would fit `spotme/app`, but that does not rescue the two points
above.

### What is genuinely worth borrowing

The **design**, not the service — and MIT permits it:

- The type-safe "file router" pattern: declaring upload endpoints with their
  permitted file types, size limits and middleware in one typed place.
- The presigned-URL upload flow, and how progress, retries and completion
  callbacks are modelled around it.

Both are directly applicable to building Spot Me's own R2 upload path, where
the client would encrypt before the PUT.

### Verdict

**Do not adopt; read for design.** Excellent engineering, and a sound choice
for a project without an E2EE requirement — including anything in this monorepo
that is not Spot Me. For Spot Me it is disqualified by hosted storage plus no
content encryption, against a roadmap that already selected R2.

---

## 5. Three short-video / feed repositories — NONE OF THE URLS EXIST

Checked 2026-08-02. All three paths below were supplied with confident
descriptions. **Not one of them resolves to a real repository.** Recorded
because the descriptions are plausible and someone will otherwise re-check
them.

| Supplied URL | Supplied description | Reality |
|---|---|---|
| `videodb/tiktok-clone-react` | "Full-Stack TikTok / Short-Video Clone" | **No such repo.** The org is `video-db` (hyphenated), an AI video-infrastructure company — `Director`, `StreamRAG`, `videodb-python`, `bloom`, `skills`. It publishes no TikTok clone. |
| `lalithnarayan/tiktok-clone` | "Open-Source Short Video Feed & Creator Platform" | **No such repo.** The user exists and has exactly 7 public repos — `ossdocumentaion`, `yirla`, `microfrontend-finacPlus`, `r360`, `zoneManagerReactApp`, `shipper`, `shield_assignment`. None is a TikTok clone. |
| `GetStream/Stream-Feeds-JS-React` | "Scalable Social Media Feed Engine" | **No such repo.** The org has 13 feeds repos; the real JS one is `GetStream/stream-feeds-js`. See below — and the description is wrong about it too. |

### `GetStream/stream-feeds-js` — the real repo, and it is not what was described

TypeScript monorepo (`feeds-client`, `react-sdk`, `react-native-sdk`), 22
stars, last pushed 2026-07-16, published as `@stream-io/feeds-client@2.6.0`.
Two facts contradict "Open-Source … Feed Engine". MEASURED:

- **It is not open source.** `LICENSE` opens *"SOURCE CODE LICENSE AGREEMENT —
  IMPORTANT, READ THIS CAREFULLY BEFORE DOWNLOADING, INSTALLING, USING OR
  ELECTRONICALLY ACCESSING THIS PROPRIETARY PRODUCT."* npm reports the licence
  as `See license in LICENSE`, not an SPDX identifier.
- **It is not an engine you can run.** It is a client for Stream's hosted paid
  API: it requires an `apiKey` and defaults to
  `https://feeds.stream-io-api.com`. `base_url` is overridable, but that
  selects a Stream endpoint — there is no server component in the repository
  to self-host.

So the relationship graph and comment nesting live on Stream's servers, not in
anything you deploy. Same shape as UploadThing in §4: a good hosted product,
sold as though it were infrastructure you own.

Other real GetStream feeds repos, if that product is ever wanted:
`stream-feeds-react-tutorial`, `stream-feeds-react-native-tutorial`,
`stream-feeds-swift`, `stream-feeds-android`, `stream-feeds-flutter`.

### Two method notes from this round

1. **`git ls-remote` is not a valid existence test in this container.** It
   fails with `could not read Password for 'http://local_proxy@127.0.0.1'`
   for every URL, real or not, because the agent proxy prompts for
   credentials non-interactively. Use the GitHub API.
2. **A `repo:owner/name` search returning HTTP 422 is suggestive, not
   conclusive** — it also fires when the *owner* name is wrong, as with
   `videodb` vs `video-db`. Confirm by listing the owner's repositories or
   searching the name globally.

If short-video feed references are wanted, ~175 real `tiktok-clone*` React
repos exist — e.g. `Marlon-Paulo-da-Silva/TikTok-Clone-ReactNative` (78★) and
`christranv/react-native-tiktok-clone`. **None has been vetted here**; on this
register's record, assume the advertised features need checking before trust.
