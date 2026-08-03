# 05 — Governance (G1–G9)

The rules that apply before and during any change. These are binding for every
session; they exist to keep Spot Me honest and to prevent context loss.

## G1 — Canonical handbook

This handbook (`spotme/docs/handbook/`) is the canonical project memory. The
**repository is the single source of truth**; chat history and temporary handoff
files are not authoritative. If the handbook and the code disagree, the code
wins and the discrepancy is [reported](10-CONTRADICTIONS-AND-GAPS.md) and fixed.

## G2 — Six-state implementation model

Every feature is classified as exactly one of: **Implemented (Merged)**,
**Implemented (Draft PR)**, **In Progress**, **Planned**, **Deferred**,
**Retired** — each with **evidence** (a merged commit or an open PR/branch). See
[03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md). Never describe
draft-PR work as shipped.

## G3 — Repository-first documentation structure

Documentation lives in the repository, next to the code it describes. Anything a
future session needs must be committed — nothing important lives only in a chat,
a memory note, or `~/.claude/` (which does not travel to a fresh clone).

## G4 — Honest stubs

Where a surface is not built, documentation says so plainly (an "honest stub")
rather than describing architecture that does not exist. In code, unbuilt or
unproven capability ships **dark** (flag-gated, fenced) and is never presented as
working. The product never claims more than it can prove (the honesty pillar).

## G5 — Session bootstrap protocol

Every session runs [00-BOOTSTRAP](00-BOOTSTRAP.md) before coding: read
`CLAUDE.md` → handbook → current milestone → next mission → ADRs → **verify
repository state** → report mismatches → then implement. A session must be able
to answer, from the repository alone: what the product is, the current
milestone, the next approved mission, what is merged, what is draft-only, which
ADRs govern, and which rules apply. This is the **bootstrap test** and it is the
acceptance criterion for this handbook.

## G6 — Immutable ADRs

Architectural decisions are recorded as ADRs in [../adr/](../adr/README.md). An
**Accepted** ADR is immutable — it is not edited to reflect a new direction. A
new architectural decision requires a **new** ADR (which may supersede an older
one by reference). Backfilled ADRs record decisions already evidenced in the
repository.

## G7 — Stable documentation layout

The layout is stable so links do not rot:

```
spotme/docs/
  handbook/   00-BOOTSTRAP … 10-CONTRADICTIONS-AND-GAPS (this set)
  adr/        NNN-title.md (immutable decisions) + README index
  *.md        detailed subsystem docs + audits (numbered 01–14, roadmap V2)
```

New handbook pages get the next index number; new ADRs get the next ADR number.
Do not renumber existing files.

## G8 — Activation & merge milestone

Turning a dark foundation on is a **separate, owner-authorised change** whose
whole subject is that activation — never a side effect of another task. Sessions
do **not** merge, mark a draft ready, enable auto-merge, activate feature flags,
or wire an unfinished foundation into the app unless the owner explicitly
authorises it. Draft PRs stop for owner review.

## G9 — Handbook maintenance protocol

Keep the handbook current **in place**:

1. When a PR merges, move its features from *Draft PR* → *Merged* in
   [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md), with the merge SHA.
2. When an architectural decision is made, add an **ADR** (G6) and link it.
3. When the current milestone or next mission changes, update
   [04-ROADMAP](04-ROADMAP.md).
4. When the repository contradicts the handbook, fix the handbook (or the code)
   and record it in [10-CONTRADICTIONS-AND-GAPS](10-CONTRADICTIONS-AND-GAPS.md).
5. Update the "Verified against `master` `<sha>` on `<date>`" line on any page
   you re-verify.
6. Do this as part of the same change that alters reality — the handbook must
   never lag the repository across a merge.

---

### Relationship to `CLAUDE.md` and Roadmap V2

`CLAUDE.md` (repo root) is the always-loaded rule file and points here for
bootstrap. `spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md` remains the controlling
engineering roadmap (its §2 rules, §5 priorities, §8 checklist, §10 instructions
still apply). This governance model is the process layer around both; where the
roadmap is stricter, the stricter gate holds.
