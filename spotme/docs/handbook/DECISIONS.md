# Owner Decision Sheet — 2026-08-03

> **Every item below is a RECOMMENDATION pending owner decision. Nothing here
> is a decision until the owner marks it.** Evidence is cited from the
> repository (or live PR metadata) for each item; where a source was not
> available in-session, that is stated rather than reconstructed.
> Ordered by urgency.

## 1. PR #39 — the only non-draft PR (the ADR-008 §12 unlock)

**Evidence.** #39 (`feat/signing-key-publication` → master, **not draft**) is
+1,197/−3 across 12 files: a backend published-signing-key lifecycle
(publish / supersede / **withdraw** — `signing-keys` controller/service +
`signing-transcript.ts`, 314-line e2e spec), a web publication client that is
**dark** (`SIGNING_PUBLICATION_ENABLED = false`,
`signing-key-publication.js:31`), gated on store health, with the
`signing-not-shipped` fence extended (+21 lines), plus an ADR-008 Phase 2B
appendix (+95). It is the executable **rollback-after-publication** that
ADR-008 §12 names as the unlock for the crypto chain #41 → #42 → #43.

**Recommendation: convert #39 to draft now; do not merge it next.**
Three reasons: (a) as the sole non-draft PR it is one accidental click from
merging crypto-lifecycle code while the owner's standing order still
sequences crypto last (master roadmap Owner Amendment, step ⑤); (b) the
docs/governance stack (#62–#65) that records how such merges are gated is
itself unmerged; (c) the crypto-train decision should follow a
**libsignal-evaluation ADR** (adopt vs. maintain the custom e2e_v3 ratchet)
— merging the publication lifecycle first would deepen investment in the
custom path before that evaluation. The code itself looks merge-ready and
dark; nothing is lost by holding it as the head of the train.

**And: yes, the crypto-train merge should wait** for the blueprint's
libsignal-evaluation ADR. #41–#43 implement a hand-rolled X3DH/Double-Ratchet
(pinned to the 004b vectors); that is exactly the artefact a
build-vs-adopt decision must precede.

## 2. Docs-stack merge order (#62 → #63 → #64 → #65)

**Evidence.** The stack is sequential by construction: #63 is based on #62's
branch, #64 on #63's, #65 on #64's (live PR metadata).

**Recommendation.** After review, merge in exactly that order, retargeting
each next PR to master as its base merges (#63's base → master after #62,
etc.). Do not merge out of order — a later PR contains the earlier branches'
commits. This session added commits to #62 (this file, CLAUDE/RUFLO split,
audit doc), #63 (roadmap-conflict section) and #65 (status page, ADR-024);
the same-content §31 addition was applied to both #63 and #65 so the
sequential merges resolve cleanly.

## 3. G8 integration milestone for the crypto train

**Recommendation.** Treat #39 → #41 → #42 → #43 as **one G8 activation
milestone**, not four merges: (1) libsignal-evaluation ADR decided; (2) the
four PRs rebased onto current master and merged **dark** in order, fences
green at every step; (3) a single owner-authorised activation change flips
the flags, with the ADR-008 §12 rollback rehearsed (withdraw executed against
staging) before any key publishes; (4) the multi-device safety-number
question (ADR-008 §BLOCKING) decided before #43 activates. No step 3 without
steps 1–2; no #43 without step 4.

## 4. Ratify Blueprint v1.0 — required pre-ratification edits

**The Scope Lock & Migration Blueprint v1.0 was not attached to this session**;
these are the edits it needs before ratification, based on repository state:

1. **Crypto timing** — reconcile "crypto at Phase 8" with master's Owner
   Amendment (crypto = step ⑤, "mandatory before Priority 1 is declared
   complete") and with ADR-008 §12.
2. **Three-roadmap reconciliation** — resolve the §31 conflict table added to
   the roadmap in #63 (see item below; OWNER RATIFICATION REQUIRED).
3. **Six-state vocabulary** — pick the handbook's six repo-level states or
   scope the blueprint's six as product-level (see the vocabulary note in
   the roadmap §31).
4. **P0 marked fixed** — the precise-GPS broadcast defect is FIXED on master
   (PR #66, merge `069905e`); the blueprint must not list it as open.
5. **Repo-level decisions added to §18** — the standing gates the repository
   already enforces (ADR-008 §12 hard stop; dark-shipping/fence discipline;
   camera-branch freeze; five-step Discovery order per ADR-022).

## 5. Consented location-share policy (from #66's sweep)

**Evidence.** Chat's explicit location share sends **precise** coordinates by
design: one-shot share (`chat.js:3309–3323`), live share
(`chat.js:3328` → `rooms.locup`), map link (`media.js:286`). These are
user-initiated, conversation-scoped, and separate from the (now coarse)
public discovery broadcast.

**Recommendation: keep precise coordinates, add an explicit consent notice.**
Precision is the feature's purpose (meeting someone); coarsening would break
it. But the share sheet should say what is sent and to whom — e.g. "Shares
your exact location with this conversation until you stop." One-line UI copy,
no protocol change. (Do not silently coarsen; do not leave it unlabelled.)

## 6. When to rebase PR #60 (not done in this mission)

**Recommendation.** Rebase `feat/discovery-v2-map-foundation` onto master
immediately **after** #67 (hygiene) and the docs stack merge, and before any
Discovery implementation resumes. The known conflict is small and one-sided:
`myAnnouncement()`/`acquirePosition()` and their comments changed in both #66
and #60 — resolve in favour of #60's `publicPositionFor` boundary (it
supersedes the interim `coarse()` call by design; ADR-024). #61 then rebases
onto the rebased #60.

## 7. Branch cleanup (delete nothing without owner sign-off)

Vs. master `069905e` (behind/ahead), verified 2026-08-03:

| Branch | Last | Behind/Ahead | Content on master? | PR | Recommendation |
|---|---|---|---|---|---|
| feature/centrifugo-transport | 07-31 | 49/14 | No — superseded by transport seam (#17) | none | **Delete** (abandoned; ADR-002 seam lives on master) |
| claude/enterprise-ai-engineer-pack-bu2k4l | 07-30 | 87/59 | No — unrelated experiment | none | **Delete** |
| claude/omniparser-verify-loop-ybot-dwbeyi | 07-29 | 87/63 | No — unrelated (ybot) | none | **Delete** |
| claude/start-aen86m | 07-26 | 87/57 | No — unrelated experiment | none | **Delete** |
| claude/next-session-b6ypc5 | 07-31 | 38/0 | Yes (0 ahead) | none | **Delete** |
| claude/next-session-yol4aj | 08-01 | 37/2 | Partially — 2 ybot commits | open #8 | **Keep until #8 decided** (or close #8 + delete) |
| claude/session-handoff-aug-2-7vv7pz | 08-01 | 2/0 | Yes (0 ahead) | none | **Delete** |
| claude/snap-camera-kit-repos-65c88r | 08-02 | 2/17 | No — research reports | open #53 | **Keep until #53 decided** |
| feat/safety-numbers | 08-01 | 29/0 | Yes — merged (#12) | merged | **Delete** |
| feat/verify-screen | 08-01 | 27/0 | Yes — merged (#14) | merged | **Delete** |
| feat/signing-key-storage | 08-01 | 4/1 | Yes — merged (#36, rebuilt; 1 stale commit) | merged | **Delete** |
| fix/dm-room-authorisation | 08-01 | 35/0 | Yes — merged (#10) | merged | **Delete** |
| fix/key-self-heal | 07-31 | 66/0 | Yes — merged (#4) | merged | **Delete** |
| fix/push-payload-handlers | 08-01 | 36/0 | Yes — merged (#9) | merged | **Delete** |
| fix/v19-e2ee-key-agreement | 07-31 | 68/0 | Yes — merged (#1) | merged | **Delete** |
| phase/a-transport-seam | 08-01 | 22/1 | Yes — merged (#17; 1 stale commit) | merged | **Delete** |
| phase/b-media-indexeddb | 08-01 | 21/1 | Yes — merged (#18; 1 stale) | merged | **Delete** |
| phase/c-storage-seam | 08-01 | 20/1 | Yes — merged (#19; 1 stale) | merged | **Delete** |
| chore/web-lint-gate | 08-01 | 18/2 | Yes — merged (#21; 2 stale) | merged | **Delete** |
| ci/real-checks | 08-01 | 23/1 | Yes — merged (#20; 1 stale) | merged | **Delete** |
| perf/idb-media-baseline | 08-01 | 17/4 | Yes — merged (#22; stale extras) | merged | **Delete** |
| test/s3-integration | 08-01 | 17/4 | Yes — merged (#23; stale extras) | merged | **Delete** |
| docs/priority-0-audit | 08-01 | 27/0 | Yes — merged (#13) | merged | **Delete** |
| docs/tech-stack-refresh | 08-01 | 36/0 | Yes — merged (#11) | merged | **Delete** |
| feat/media-core-contracts | 08-02 | 2/1 | No — media-core contracts, dark | **none** (anomaly A1) | **Open a draft PR** (or owner folds the branch) — a pushed branch with no PR is invisible to review |
| wip/ai-vision-docscan-unreviewed | 08-02 | 2/14 | No — unreviewed WIP | none | **Keep, renamed intent**: owner decides fold-into-#58 vs delete; do not delete unreviewed work silently |

## 8. Repository split + root package.json

**Recommendation: split.** ybot-assistant (231 of the repo's 299 markdown
files), ybot, cryptobot, memebot, jarvis, ysnap, desk, obsidian-plugin and
research are not Spot Me and dilute every audit, search, clone and CI run.
Move them to one or more separate repositories with `git filter-repo`
(history-preserving), then remove from this repo. Until the split, the
CLAUDE.md layout note marks them out-of-product.

**Root `package.json`: remove.** Its four dependencies (gsap, @gsap/react,
framer-motion, lenis) match `ysnap/package.json`'s frontend stack and no root
source uses them (2026-08-03 audit, §5/§14) — it appears to be a stray
install at the wrong directory level. Remove in the same change that splits
ysnap out (or immediately as a follow-up hygiene PR; not done in this
mission per its limits).
