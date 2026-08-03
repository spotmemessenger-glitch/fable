# Platform Phase 1 — Migration Foundations (dark, additive)

**Branch:** `feat/platform-phase-1` · **PR:** draft to `master` · **Started:** 2026-08-03

This is the live ledger for the platform-migration foundation work. Every item
is **additive and dark**: no runtime change to `spotme/web`, no Vercel/deploy
change, nothing wired into the running product. Each item lands with its code,
tests and docs in the same commit, per Governance G9.

> **Dark gate held at start:** master `4acaae6`; `SIGNING_PUBLICATION_ENABLED = false`;
> no app module reads `spotme.e2e3`; `signing-not-shipped` 20/20 and
> `e2e-v3-not-shipped` 9/9 green. Crypto flags stay false throughout.

## Runtime note — Dragonfly / Redis

The managed cache + queue + broker runtime (Dragonfly Cloud in production,
Valkey in dev/CI) is reached **only** through `REDIS_URL` (env) via ioredis.
The URL/key is never committed, logged, or printed. Everything that depends on
it degrades to **disabled** when `REDIS_URL` is absent.

## Item ledger

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `docker-compose.dev.yml` — Postgres+PostGIS, Valkey, Meilisearch, Typesense (dev/CI only) | ✅ done | `spotme/docker-compose.dev.yml`; `docker compose config` valid |
| 2 | PostGIS via additive Prisma migration (CREATE EXTENSION only) | ✅ done | `prisma/migrations/20260803120000_enable_postgis/`; verified applied (postgis 3.4.2) + reversible (`DROP EXTENSION`) on a real PG16 |
| 3 | `packages/contracts` — shared TS domain types; tsc in CI | ✅ done | `spotme/packages/contracts` (location + Exchange types); `tsc --noEmit` exit 0; CI job `contracts` added |
| 4 | BullMQ on ioredis; `{maintenance}` queue; retries+DLQ; heartbeat; Valkey integration test | ✅ done | `backend/src/queue/`; `queue.e2e-spec.ts` 4/4 (disabled path, heartbeat loop, DLQ routing, hash-tag); Valkey service added to backend CI |
| 5 | AI Gateway skeleton — Intent/Summary/Voice ports + deterministic baselines; fence test | ✅ done | `web/src/lib/ai/`; baselines 15/15, fence `ai-gateway-not-shipped` 11/11 (nothing imports it, no keys/network); web suite 1017/1017 |
| 6 | Search benchmark harness — Meilisearch vs Typesense; numbers only | ✅ done | `packages/search-bench`; ran live (20k docs): Meili 28.3k docs/s idx, p50 44ms, 58MB · Typesense 11.6k docs/s, p50 4.6ms, 167MB; both 100% typo. Owner picks engine |
| 7 | ADR (Proposed) — realtime split-plane ownership | ✅ done | `spotme/docs/adr/026-realtime-split-plane.md` (Status: Proposed); indexed |
| 8 | React strangler beachhead `spotme/web-next` (inert, not deployed) | ⏳ | |
| 9 | `StorageProvider` port — S3 behind a swappable interface | ⏳ | |
| 10 | Observability baseline — Sentry/JSON logs/OTel, all no-op without env | ⏳ | |
| 11 | ADR (Proposed) — mobile-native boundary | ⏳ | |

## Owner decisions gated behind this phase

- **Search engine choice** — from the item-6 benchmark numbers.
- **Acceptance of ADR-026** (realtime split-plane) and **ADR-027** (mobile-native boundary).
