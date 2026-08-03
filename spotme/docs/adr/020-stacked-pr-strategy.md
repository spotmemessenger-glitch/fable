# ADR-020 — Stacked draft-PR strategy

**Status:** Accepted (2026-08-03). Backfilled from repository practice.

## Context

Some foundations build directly on another unmerged foundation (e.g. Live Nearby
Events reuses the Discovery V2 contracts). Basing such work on `master` would
either duplicate the dependency or show a misleading diff; waiting for the base
to merge would serialise work the owner wants prepared in parallel — while every
foundation still stops for owner review before merge.

## Decision

A dependent foundation is developed on its own branch **based on the dependency's
branch**, and its draft PR uses that branch as a **temporary base** so the PR
diff shows only the dependent delta. Rules:

- The base PR's branch is **never modified** by the stacked work.
- The stacked PR is **re-targeted to `master`** once the base merges.
- Any change to shared files (e.g. extending a fence to allow a sibling dark
  foundation) lives on the **stacked** branch only, and is disclosed in the PR.
- Each PR remains an independent, owner-reviewed **draft** — stacking does not
  imply auto-merge or a merge train.

## Consequences

- Clean, reviewable diffs for dependent work; the dependency is reused, not
  copied.
- A housekeeping step (re-target to `master`) is owed after the base merges —
  tracked in [handbook/09-OWNER-DECISIONS](../handbook/09-OWNER-DECISIONS.md).
- Contributors must verify the base branch is untouched (`git merge-base`).

## Evidence

PR #61 (`feat/live-nearby-events`) stacked on PR #60
(`feat/discovery-v2-map-foundation`); the sibling-dark fence extension lives only
on #61's branch; #60's branch verified unchanged at `3e2c709`.
