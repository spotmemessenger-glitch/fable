# Platform Phase 1 — Programme Playbook (staged, dark, additive)

**This document is the Platform Phase 1 programme playbook.** Execute **one item
group per branch and one draft PR per group**. Each PR starts from the latest
owner-approved `master` and **stops for review**. Never stack the entire
programme into one unreviewable PR.

Every group is **additive and dark**: no runtime change to `spotme/web`, no
Vercel/deploy change, nothing wired into the running product, and both crypto
flags (`SIGNING_PUBLICATION_ENABLED`, `spotme.e2e3`) stay false throughout. Each
group re-runs the **Phase 0 dark gate** at its start.

## Branch / PR sequence

| Group | Branch | Scope |
|---|---|---|
| **1A** | `feat/platform-phase-1a-runtime-spatial` | Compose dev stack (Postgres+PostGIS, Valkey; opt-in `search-benchmark` profile), additive PostGIS migration, health checks, CI compose validation |
| 1B | `feat/platform-phase-1b-contracts` | `@spotme/contracts` TS package (types only, declaration output, import-boundary tests), tsc in CI |
| 1C | `feat/platform-phase-1c-redis-queues` | Shared ioredis connection layer + BullMQ `{maintenance}` (dark, disabled without `REDIS_URL`); bounded retries/backoff; **sanitized** DLQ envelope (no secrets/raw payloads); manual smoke job only (no recurring worker); Valkey integration test |
| 1D | `feat/platform-phase-1d-search-benchmark` | Benchmark harness + **full reproducibility record** (resources, corpus, query set, warm-up, run count, cold-vs-warm, versions, config, index size, memory method); numbers only, no engine wired |
| 1E | `feat/platform-phase-1e-ai-and-adrs` | AI Gateway ports + deterministic baselines (fenced); realtime split-plane ADR + mobile-native ADR (Proposed) |
| 1F | `feat/platform-phase-1f-react-beachhead` | `spotme/web-next` inert React beachhead (verified outside the Vercel root; no legacy imports/routing/backend/auth) |
| 1G | `feat/platform-phase-1g-storage-observability` | Formalize StorageProvider port + media seam (characterization tests, no rewire); observability baseline (structured logging, optional Sentry/OTel, prom-client preserved independently) with **redaction tests** (tokens, auth headers, coordinates, message content, keys, `REDIS_URL`, DB URLs) |

## Standing constraints (all groups)

- **Redis** only via `REDIS_URL` (env) behind a shared ioredis layer; the
  Dragonfly Cloud URL/key is never committed, logged, or printed. Everything
  degrades to disabled without it.
- **PostGIS**: additive `CREATE EXTENSION` only; verify the production role can
  install it before relying on it; safe rollback is **leave installed** (never
  auto-drop once dependent objects exist).
- **Search engines** live behind the opt-in `search-benchmark` compose profile;
  the default stack is Postgres+PostGIS + Valkey only.
- **ADR numbers** are taken from the next free numbers on live `master` at the
  time the group lands; an already-Accepted ADR is never edited.
- No generated benchmark indexes or bulky result artifacts are committed.

## History

The original single-PR draft (`feat/platform-phase-1`, PR #71) proved the
architecture end-to-end but was too large to review or roll back safely. It is
superseded by this staged programme (owner decision, 2026-08-03) and split into
1A–1G above.
