# ADR-014 — Repository over memory (canonical handbook)

**Status:** Accepted (2026-08-03). Backfilled by Engineering Handbook v1.0.

## Context

Project memory lived in chat history and in `.handoff/NEXT-SESSION.md` /
`.handoff/SESSION-*.md`. Cloud/remote Claude Code sessions run in a **fresh
clone**: anything under `~/.claude/` (skills, notes) and anything in a prior
chat does **not** travel. Only committed files do. The handoff files also drift
from reality — they are a record, not a live check — and a session that trusts
them can act on stale state.

## Decision

The **repository is the single source of truth.** Canonical project memory is a
committed **Engineering Handbook** (`spotme/docs/handbook/`) with a six-state
implementation map (evidence required), a bootstrap protocol, and immutable
ADRs. Every session bootstraps from the repository and **verifies state before
trusting any status line**. The `.handoff/NEXT-SESSION.md` mechanism is
**Retired**.

## Consequences

- No important context lives only in chat or `~/.claude/`.
- Status claims carry evidence (a merged commit or an open PR) and are
  falsifiable by `git`/PR queries.
- The handbook must be maintained **in the same change** that alters reality
  (Governance G9), or it lags and the problem returns.
- Contradictions between docs and code are surfaced, not silently reconciled
  (handbook §10).

## Evidence

`spotme/docs/handbook/` (this handbook); `CLAUDE.md` bootstrap pointer; the
RETIRED banner on `.handoff/NEXT-SESSION.md`.
