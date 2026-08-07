# PR #139 rebased onto post-#143 master; slice 1 amended to Exchange

**Date:** 2026-08-07 · **Branch:** `feat/slice-0-frontend-migration` · **Base:** `master` `e304d27` (Merge #143)
**Head after rebase:** `59ddba4` · **PR #139 — still draft, not merged**

Docs + rebase only. No deploy, no Vercel change, no merge, slice 1 not started.

---

## 1. Rebase · PASS

#143 changed **18** files under `spotme/web`, not 10 as the mission stated
(6 of them new). All 18 carried into `spotme/apps/web`; **0** tracked files
remain under `spotme/web`.

Git flagged 6 as `CONFLICT (file location)` — files #143 *added* into a
directory this branch renames. Git had already placed them correctly at
`spotme/apps/web/…`; resolving was accepting that placement, not re-authoring
content.

### Proof nothing was dropped

**17 of 18 files are byte-identical blobs** to master's `spotme/web/<path>`
(`git rev-parse` on committed blobs, so CRLF in the working tree is not
mistaken for a difference).

The **one** difference is `package.json`, and it is intended: this branch's
`prebuild` fix. Diffed in isolation, the only changed line is `prebuild` —
`../core` → `../../core` plus the fatal-on-missing guard. **#143's own
`package.json` change survived intact**: all three new suites it registered
(`video-sound-reattach`, `moments-upload-progress`, `storage-degrade`) are
present in the rebased test script.

#143's four named changes, all present after the move:

| Change | Evidence |
|---|---|
| audience (A4) | 3 `audience` references in `src/views/moments.js` |
| storage | `src/lib/storage-health.js` + `src/lib/media-precheck.js` present; `blobstore.js` references storage-health |
| B1 | `src/lib/burst.js`, `src/views/moments.css:411`, `src/views/moments.js:713/731/755` |
| B6 | `src/views/chat.js:1384` |

### Test counts — the mission's baseline was stale

| | Suites | Assertions | Exit |
|---|---|---|---|
| Mission's stated baseline (pre-#143) | 57 | 1,085 | — |
| **master `e304d27`** (measured in a clean worktree) | **60** | **1,125** | 0 |
| **Rebased branch** | **60** | **1,125** | 0 |

The branch matches master exactly. 1,085/57 was correct before #143 and is not
the right target after it — #143 added three suites and 40 assertions. Holding
the branch to the old number would have meant *losing* #143's tests.

Also green after rebase: `apps/web` lint 0 · build 0 · backend dark fences
**65/65** · `packages/ui` **105 passed / 4 skipped** · ui boundary fence 6/6.

Pushed with `--force-with-lease`.

---

## 2. Slice 1 → Exchange · DONE (docs only)

ADR-035 §(e) rewritten; the superseded Discovery-first text is retained in a
collapsed block rather than deleted.

**Rationale recorded:** no vanilla Exchange screen exists anywhere in the web
app — no `views/exchange.js`, no `ROUTES` entry, no nav item — so slice 1 is
**greenfield**. No legacy path to keep alive (DoD #2 has nothing to preserve),
no flag-off fallback (the surface is simply absent, as today), no
persisted-shape risk, no rewrite risk. It still proves the island host, the
flag, the package boundary, the DoD and the rollback drill — on a surface
where a mistake costs nothing a user can see.

**Discovery → slice 5**, recorded as a *known and separately accepted* risk:
a working screen with zero view-level coverage carrying the ADR-024 P0
coarse-broadcast fence. Its requirements are unchanged — live endpoints only,
no Phase 2 backend, no Typesense (**P7 still no**), legacy intact with the flag
off, and the P0 fence passing against **both** implementations in one CI job.

Also recorded: the original ordering conflated **product priority** (ADR-022)
with **migration risk**. They are independent axes.

**Unchanged, as instructed:** the per-slice definition of done (§(f), nine
items) and the rollback rule (§(g), three tiers with the persisted-shape rule
load-bearing).

Updated: `docs/adr/035-frontend-migration-plan.md` (§(e), status line, P7 row,
one cross-reference) · `docs/handbook/DECISIONS.md` (new section) ·
`docs/reports/2026-08-07-migration-phase-0.md` (§3 table row, §4 marked
superseded).

---

## 3. Island host — noted, not built

Recorded in ADR §(e) as landing with slice 1, behind `spotme.ui.exchange`
(default off). The slice-0 deferral reason is preserved: with `packages/ui`
dark, a mount point has nothing to mount, and `liveEntryDarkPackageImports()`
fails the moment `apps/web/src/main.js` imports `@spotme/ui` — building it
early would have weakened a fence slice 0 had just strengthened.

Not built this run.

---

## 4. Owner-only blockers — restated in the #139 body

1. **`.github/workflows/ci.yml` still references `spotme/web`.** Reverted on
   this branch because the pushing token lacks `workflow` scope
   (`refusing to allow an OAuth App to create or update workflow … without
   'workflow' scope`). Four lines — `working-directory` ×2,
   `cache-dependency-path`, one comment — must change to `spotme/apps/web`.
   Patch: `scratchpad/ci.patch`. Until applied, every web CI job fails.
2. **Both Vercel Root Directories must move to `spotme/apps/web` in the same
   window as the merge.** Root Directory is project-level, not per-branch, so
   it cannot be pre-set — doing so breaks `master` today, which still holds
   `spotme/web`. Merging without it breaks both projects' builds, including
   the live production promotion on `spotme-messenger`.

---

## 5. Hard stops honoured

No merge · no Railway or Vercel deploy · no Vercel settings change · slice 1
not started · `spotme/app` and `spotme/mobile` untouched (P5/P6 pending) · no
Tailwind (P4) · no persisted-shape change · translit import intact
(`vite build` exit 0 after rebase) · env **names** only.
