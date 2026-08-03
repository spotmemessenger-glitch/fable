# ADR-017 — Provider-neutral adapter contracts

**Status:** Accepted (2026-08-03). Backfilled; owner-approved via PR #60 review.

## Context

Discovery, events, translation, routing and similar features integrate
third-party providers. If a vendor's shape, endpoints or credentials leak upward,
the whole subsystem becomes coupled to that vendor, and raw payloads (tracking
ids, attribution tokens, billing metadata, credential echoes) can propagate into
app state, logs and the wire. The owner principle: **no provider may become a
hard dependency.**

## Decision

Providers are **adapters** behind a **provider-neutral contract**. Adapters
normalise each vendor's response into a **stable Spot Me model** (place, event,
translation result, …); the rest of the subsystem sees only that model.
Normalisation copies **only whitelisted fields** into a fresh object — the raw
payload does not propagate. Credentials live in the adapter's closure or injected
config, **never** as enumerable object fields; `assertNoSecrets()` throws if an
adapter exposes a secret-shaped property. Swapping or adding a provider is an
adapter change, never a change to search/ranking/map. Ranking/selection route and
fall back on quality, availability, cost and response time.

## Consequences

- No vendor lock-in; providers are hot-swappable.
- No credential or tracking leakage past the boundary.
- AI/provider features keep accuracy + latency + privacy tradeable, per owner
  directive.

## Evidence

`web/src/lib/discovery-v2/contracts.js` (`normalizePlace`, `assertNoSecrets`),
`web/src/lib/live-events/contracts.js` (`normalizeEvent`), translation abstraction
draft PR #51. Owner approved the "provider-neutral Discovery V2 contracts".
