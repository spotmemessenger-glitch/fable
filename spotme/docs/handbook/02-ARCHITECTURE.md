# 02 — Architecture

> Verified against `master` `31e1894` on 2026-08-03. Detailed subsystem docs
> live alongside this file in `spotme/docs/` (`02-SYSTEM-ARCHITECTURE.md`,
> `03-DATABASE-SCHEMA.md`, `04-API-DOCUMENTATION.md`, `09-TECH-STACK.md`).
> Where a surface is not yet built, this page says so with an **honest stub**
> rather than describing architecture that does not exist.

## Deployment shape (what is actually live)

| Tier | Technology | Host |
|---|---|---|
| Web app | Vanilla JS + Vite 8 (no UI framework) | Vercel |
| API + realtime gateway | NestJS 10 | Railway |
| Database | PostgreSQL + Prisma 5 | Railway Postgres |
| Android shell | Capacitor 8 (sideload, unpublished) | — |
| iOS | **does not exist** (no Xcode project) | — |

Source: `spotme/docs/09-TECH-STACK.md §1`. (Note: that document was written
against an older `master` and is stale on the web lint gate — see
[10-CONTRADICTIONS-AND-GAPS](10-CONTRADICTIONS-AND-GAPS.md).)

## Repository structure (Spot Me)

```
spotme/
  web/        Frontend — Vanilla JS ES modules + Vite. Trystero P2P + socket.io
              transport; IndexedDB media; WebCrypto. Tests: node --test.
    src/lib/      app logic (discovery.js, reach.js, rooms.js, crypto/, media*,
                  translate.js, transport/, push.js, …)
    src/views/    hand-written views (el() + hash routing; no framework)
    test/         node --test suites (the automated gate)
    api/          Vercel serverless funcs (vestigial; Railway serves the real ones)
    android/      Capacitor shell
  backend/    NestJS + Prisma + Postgres. Modules: auth, chat, chat-requests,
              groups, admin, audit, common, middleware.
    prisma/       schema + migrations
    test/         backend suite (needs Postgres; runs in CI)
  core/       Shared JS: identity.js, room.js, schema.js, translit.js, swarm.js
  e2e/        Playwright end-to-end (runs in CI)
  server/     Deploy/provision scripts + staged api
  app/        Expo/React-Native experiment (not the shipped client)
  docs/       Engineering documents (this handbook lives in docs/handbook/)
```

## Frontend (`spotme/web`)

- **No UI framework** — views are ES modules building DOM via a small `el()`
  helper, routed on the URL hash (`spotme/docs/09-TECH-STACK.md §2`).
- **Transport:** one authorisation seam for both transports (`src/lib/transport/`,
  merged in #17); Trystero P2P rooms + a socket.io server transport.
- **Discovery lobby:** `src/lib/discovery.js` — a single app-wide presence room.
- **Media:** lives in IndexedDB (`src/lib/blobstore.js`, #18), uploaded through a
  storage seam to an S3-compatible bucket (#19).
- **Crypto:** `src/lib/crypto/` — WebCrypto identity, safety numbers, signing
  identity (see [08-SECURITY-AND-PRIVACY](08-SECURITY-AND-PRIVACY.md)).
- **Automated gate:** the `node --test` suite (`web/test`) + ESLint (`npm run
  lint`, added #21) + `vite build`.

## Backend (`spotme/backend`)

- **NestJS 10 + Prisma 5 + PostgreSQL.** Modules present on master: `auth`,
  `chat`, `chat-requests`, `groups`, `admin`, `audit`, `common`, `middleware`.
- **Tested against a real Postgres in CI** (`.github/workflows/ci.yml`); the
  suite fails loudly (not vacuously) without a database or S3 endpoint.
- Detail: `spotme/docs/03-DATABASE-SCHEMA.md`, `04-API-DOCUMENTATION.md`.

## Subsystem status map

Each subsystem's *state* (Merged / Draft PR / Planned / …) with evidence is in
[03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md). Architecturally:

| Subsystem | Where it lives | Architectural note |
|---|---|---|
| **Messaging & identity** | `web/src/lib/crypto/`, `reach.js`, `rooms.js`; `backend/` | The mature core. Safety numbers, identity-trust state machine, dark signing-key storage. |
| **Discovery (v1)** | `web/src/lib/discovery.js` | Live on master. Presence lobby. **Note:** on master it still broadcasts precise GPS — the privacy fix is in **draft PR #60**, not merged. See [08-SECURITY-AND-PRIVACY](08-SECURITY-AND-PRIVACY.md). |
| **Discovery V2** | draft PR #60 (`web/src/lib/discovery-v2/`, `geo-approx.js`) | Provider-neutral, dark, flag-gated map foundation + the precise-GPS privacy fix. **Not on master.** |
| **Live Nearby Events** | draft PR #61 (`web/src/lib/live-events/`) | Dark, provider-neutral events foundation, reuses Discovery V2 contracts. **Not on master.** |
| **Camera / AI Vision / AR / Creative Studio** | draft PRs #56/#58/#59/#55 | Built behind disabled flags. **Not on master.** |
| **Media Platform** | draft PR (media-core contracts) | Contracts/types/safety only, dark. **Not on master.** |
| **Translation platform** | draft PRs #51 | Provider abstraction (routing/scoring/failover), dark. **Not on master.** |
| **Push notifications** | draft PRs #48/#52 | SDK packages + inert foundation. **Not on master.** |
| **Live voice translation** | draft PRs #49/#54 | Streaming scaffolding + interfaces. **Not on master.** |
| **Adaptive transport / Bluetooth mesh** | draft PR #50 | Supervisor + mesh scaffolding. **Not on master.** |
| **AI (application layer)** | interfaces only, in the above draft PRs | **Interface-only** — no LLM calls, no conversational assistant. This is a standing constraint. |

### Honest stubs (not yet built — do not describe as architecture)

- **Nearby Moments, Stories, Reels** — *Planned*, not designed in the repository.
  There is no module, contract, or ADR. Do not implement until the owner
  approves and an ADR exists.
- **iOS client** — does not exist.
- **Ticketing / reservations, business promotions, heat maps, personalization** —
  explicitly out of scope for current foundations; no code.

## Architectural decisions

The cross-cutting decisions that shape all of the above are recorded as ADRs in
[../adr/](../adr/README.md): compile-time feature flags, dark shipping,
provider-neutral adapters, the deterministic location grid, the Discovery V2
privacy model, repository-over-memory, and the stacked-PR strategy. Accepted
ADRs are immutable; a new architectural direction needs a new ADR.

## Platform specifications

Engineering blueprints for major platforms live under
`spotme/docs/architecture/`. The **Discovery Platform Architecture
Specification** ([../architecture/discovery-platform/](../architecture/discovery-platform/README.md))
defines the common services (location & privacy engine, Intent Graph & search
orchestration, ranking, provider abstraction, AI interfaces, notifications,
data & caching, offline sync, contracts, flags/config/observability,
scalability) that Smart Nearby Discovery Map, SpotMe Exchange, Live Nearby
Events and Nearby Moments all build on.
