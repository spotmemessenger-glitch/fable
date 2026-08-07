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

---

## Owner marks recorded — 2026-08-03 (G8 crypto train)

The owner authorised the G8 dark-merge milestone across three execution
sessions and recorded the following marks. Recorded here per Governance G9;
this section is the decision, the items above remain the recommendations they
resolve.

- **Decisions 1–8 (this sheet):** **approved as recommended.**
- **ADR-025 (libsignal vs custom e2e_v3):** **Accepted** — merged as PR #68
  (Status flipped Proposed → Accepted before merge). Added to the ADR index.
- **Multi-device safety-number question (ADR-008 §BLOCKING):** **NOT DECIDED.**
  Consequently **PR #43 (multi-device) is SKIPPED** and remains unmerged;
  Phase D of the crypto train does not run until the owner picks a
  `SAFETY_VERSION` construction (ADR-008 §BLOCKING options 1–4).
- **G8 crypto train — merged DARK, in order, fences green at every step:**
  - **PR #39** (signing-key publication + executable rollback) — merged, master `67bc221`.
  - **PR #41** (X3DH + prekeys) — merged, master `f9fe579`.
  - **PR #42** (Double Ratchet, 004b-oracle conformant) — merged, master `288b8ca`.
  - Every layer landed **DARK**: `SIGNING_PUBLICATION_ENABLED = false` and the
    `spotme.e2e3` rollout flag unread by any app module, verified by fence
    tests after every merge. **Activation is out of scope and unscheduled** —
    it requires a separate owner-authorised change. No flag was flipped.

---

## Owner delegation — 2026-08-03 (Platform Phase 1 landing)

The owner **delegated engineering approval** for the Platform Phase 1 landing
mission. Recorded here per Governance G9. The delegation authorized exactly:

- **Merging the verified Platform Phase 1 stack** (PRs #72–#78, merge commits
  only — never squash/rebase/force-push).
- **Selecting the Phase 2 search target** (decision recorded below and in
  `../09-TECH-STACK.md`).
- **Accepting ADR-026** (realtime split-plane) and **ADR-027** (mobile-native
  boundary) — statuses flipped Proposed → Accepted, dated.

The owner **explicitly retained authority** over — none of which this mission
touches:

- any feature activation; any feature-flag changes;
- PR #43 (multi-device), PR #60 (Discovery V2), PR #61 (Live Nearby Events),
  the Camera programme PRs (#55/#56/#58/#59);
- decision-sheet items D5, D6, D11, D14, D15, D16;
- repository split; deleting branches or files;
- any user-visible behavioural change.

**Everything landed DARK.** Both crypto flags verified false throughout;
nothing activated, deployed, or wired into the running product.

### Search-engine selection (delegated decision)

**Typesense is the selected Phase 2 search target**, chosen from the committed
reproducible benchmark (`spotme/packages/search-bench`, recorded run
2026-08-03): ~12× faster warm p50/p95 (3.60/5.05 ms vs 44.02/44.59 ms) at an
acceptable memory trade-off (223 MB vs 66 MB RSS on the 20k-doc corpus).
**Meilisearch remains the documented fallback.** The engine is **NOT wired
into the application and NOT active**. **Mandatory revisit:** rerun the
committed benchmark on production hardware with a production-scale corpus
before wiring search into the application; if the numbers differ materially,
reopen the decision.

### Phase 2 delegated dark-build decisions — 2026-08-03 (appended under the same delegation)

- **D9 (friend-request accept gate): APPROVED FOR DARK BUILD** under the
  delegated engineering authority; **activation retained by the owner.**
  Definition (verbatim): the nearby-people flow becomes tap → profile →
  friend request → ACCEPT → chat; the current no-accept-gate knock remains
  the live behavior until activation.
- **D10 (username search): APPROVED FOR DARK BUILD** under the delegated
  engineering authority; **activation retained by the owner.** Definition
  (verbatim): optional, user-chosen public handles on the existing identity
  model, searchable Telegram-style (search → request → accept → chat);
  handles are opt-in, unique, and carry no other profile data into the index.
- **D6/D7 (age policy; gender/age filters) remain OPEN and owner-retained.**
  Phase 2 ships NO gender or age filter anywhere; no age or gender field is
  added to any schema, index, contract, or UI (mission amendment A3). The
  Phase 2 filter sheet is distance band, category, and open-now only.

## Owner delegation — 2026-08-04 (Phase 2 landing + Phase 3B–3E dark build)

The owner delegated engineering authority to **land the verified Platform
Phase 2 chain into master** (merge commits #80→#85, in order) and to **build
Platform Phase 3B–3E as dark draft PRs**. Recorded here per the mission.

- **Landed under delegation:** Phase 2A–2F merged to master via ordinary merge
  commits (SHAs in `03-IMPLEMENTATION-STATUS.md`). Everything landed DARK —
  both crypto flags remain false, `DiscoveryModule` is not imported by
  `AppModule`, no route, no flag flip, no deploy, no user-visible change.
- **Delegated for this mission:** merges of the verified Phase 2 chain; all
  engineering decisions for Phase 3B–3E; continuing between steps without
  pausing.
- **RETAINED by the owner (NOT delegated):** any activation or feature-flag
  flip; deployment; production configuration; touching PR #43/#60/#61 or the
  camera branches; gender/age anywhere (A3); payments/escrow/advertising/
  sponsored ranking; and approval of the open policy items **A5** (Exchange
  PRD ratification), **D4** (business participation — dark seam only, v1 stays
  individuals-only), **D6/D7** (age/gender policy). Those remain config seams
  with documented defaults, never approved product decisions.
- **Phase 3 does NOT merge this mission** — 3A (#86) and 3B–3E stay draft;
  Phase 3 landing is a later owner mission.

## D6 — Age policy: 18+ at launch, account-level — DECIDED 2026-08-05

**Owner decision (Wave 1B mission): Spot Me is 18+ at launch, enforced at the
ACCOUNT level.** No minor holds an account, therefore no minor can ever be
discoverable, matchable, or messageable — the gate does not need per-surface
carve-outs because there is no under-18 cohort to carve around.

- **Enforcement:** server-side at every account-creation path (signup + guest
  create — refusal creates NO row), declare-on-login for accounts predating the
  gate (B2; existing chat keeps working), and a second independent check at
  Discovery's door (`DomainGate(…, { requireAdult: true })`) so even a future
  activation mistake cannot expose an ungated account (B3).
- **What is stored:** self-declared birth YEAR-MONTH only (never a full DOB —
  data minimization), plus declaration timestamp and policy-text version.
  Immutable once recorded; corrections are a support path, not an API.
- **Decision rule:** conservative UTC month rule — eligible only once the
  18th-birthday month has fully passed; "turns 18 this month" is refused by
  design, which erases timezone and leap-day edges.
- **Full rationale:** ADR-029; enforcement evidence:
  `docs/reports/wave-1b-final.md`.

### D6 addendum — under-18 EXISTING accounts are FROZEN, not deleted — DECIDED 2026-08-05 (Wave 1C)

**Owner decision (Wave 1C mission):** an account that predates the gate and then
declares under-18 is **FROZEN**, not deleted. Data is retained; the only reversal
is the support path.

- **Explicit status, never a side-effect.** `User.accountStatus` is `active` |
  `frozen_minor` (additive migration `20260805180000_account_status`, default
  `active`). Freeze is assigned only by the two existing-account under-18
  declaration paths (declare-on-login re-auth; `POST /users/me/age`); it is a
  first-class status, not inferred from the age fields.
- **A frozen account CAN:** read its existing conversations and message history,
  and receive the policy notice (surfaced via `SELF_USER.accountStatus` and an
  `accountFrozen`/notice payload on re-auth).
- **A frozen account CANNOT:** start new conversations, be messaged anew (initiate
  *toward* a frozen account returns the byte-identical block shape — non-enumerable),
  send in existing rooms, reach Discovery or any new surface (`DomainGate` checks
  `accountStatus` explicitly — refused even if `ageVerified` were true),
  self-unfreeze / re-declare, or escape via a new client, re-auth, or direct API.
- **Data retained** (row intact, `deletedAt` null); reversal is the documented
  support path only.
- **Enforcement evidence:** `test/account-freeze.spec.ts` (16 tests, real PG);
  Stage-A report `docs/reports/wave-1c-stage-a.md` (C2).

## D7 — Moments public availability is GATED on child-safety infrastructure — DECIDED 2026-08-05

**Owner decision (Wave 1D mission, accepting the M5 moderation reality check):
Moments must NOT become publicly reachable — no open signup into it — until
image hash-matching and a real NCMEC reporting path exist.** Private testing
with people the owner knows is explicitly fine.

**Why this is a launch gate and not a backlog item.** What is active today:

- **Report path — real, but nothing consumes it.** A report writes a row, moves
  the target `visible → reported` through a guarded state machine, and appends
  an audit event. It also enqueues a `{moderation}` job into a FIXTURE
  recorder. No human or automated reviewer ever sees it; content stays visible
  unless someone changes state directly.
- **Automated image screening — none.** No classifier, no perceptual or
  cryptographic hash matching, no CSAM detection anywhere in the pipeline.
  Uploads are EXIF-stripped and stored, and that is the whole of it.
- **NCMEC seam — absent.** No credentials, no reporting client, no
  preservation/retention path. Open since Wave 0.

The 18+ gate (D6) reduces but does not remove this exposure: adults upload
illegal material too, and an account-level age policy is not a content control.

**What a PUBLIC launch requires, at minimum:** (1) image hash-matching against
a known-CSAM list at ingest, before an object is durably stored or served;
(2) a real NCMEC reporting path with credentials, preservation and retention;
(3) a moderation queue an actual reviewer consumes, with a documented response
time. Until all three exist, Moments stays invite-only behind the domain gate.

**Enforcement today:** `DomainGate('moments')` — production keeps the
RuntimeFlag row absent and the allowlist empty, so every route 404s
(`test/moments-gate-runtime.spec.ts` proves the posture against real HTTP).

## Frontend migration — ADR-035 decisions P1–P8 — DECIDED 2026-08-07

Eight decisions ADR-035 raised were answered. **ADR-035 flips PROPOSED →
ACCEPTED** for the *plan*; it activates nothing.

> **CORRECTION, same day — P5, P6 and the canonical-host pick are PENDING, not
> decided.** The answers arrived as a *recommendation table* ("my
> recommendation", "My read", "If you agree") and were written up here as an
> owner decision. That over-states what was given. For P1–P4, P7 and P8 it does
> no harm — they set direction or **restrict** action. For **P5 and P6 it does**:
> both authorize a **deletion**, which is owner-retained under this very sheet.
> A decision arriving is not consent being given. Neither may be executed until
> the owner states approval directly.

| # | Item | Decision |
|---|---|---|
| P1 | Adopt the migration plan | **YES** |
| P2 | React 19 for `web-next` (from 18.3.1) | **YES** — 18.3 would fork the React major against `spotme/app`'s pinned 19.2.3 |
| P3 | Monorepo move + Vercel Root Directory change | **YES in principle** — move/restructure unblocked; the **Root Directory repoint waits on P10** |
| P4 | Tailwind v4 | **DEFERRED** — slices 0–1 ship on plain CSS + the #132 tokens |
| P5 | Retire `spotme/app` | **PENDING EXPLICIT CONFIRMATION** — deletion; do not execute. Hard constraint below applies regardless |
| P6 | Untracked `spotme/mobile` | **PENDING EXPLICIT CONFIRMATION** — deletion with **no git safety net** (0 tracked files; `rm` is unrecoverable); do not execute |
| P7 | Phase 2 Discovery activation (Typesense) | **NO, not now** — spend + activation |
| P8 | Flag flips to real users | **NOT YET** — nothing flips until a slice passes all nine DoD items |

### Canonical Vercel project — CURRENCY settled, AUDIENCE open (P10)

Two claims were being run together; they separate cleanly.

**CURRENCY — settled.** `spotme-messenger` is git-wired `master` → production
and current. Ratified as a **standing directive** in `CLAUDE.md` → "Production
hosts" (PR #138, `d4b15a4`): treat `spotme-messenger` as production, not
`spotme-web-v2`. **That directive is followed.**

**AUDIENCE — OPEN (P10).** Which project real testers open is a different
question, and git-wiring proves currency, not audience. A current project
nobody visits and a stale one people do are both possible at the same time.

**Two errors in the previous version of this entry, both recorded rather than
quietly fixed.**

1. **Circular closure.** P10 was marked CLOSED by CLAUDE.md. But CLAUDE.md's
   standing line cites the same promotion chain, the same `target: null`, and
   the same manual-`--prod` finding as the Vercel API analysis it was written
   from — it restates that analysis rather than independently confirming it. A
   two-source conflict was resolved by counting one source twice, immediately
   after this same sheet warned that repeated agreement is not corroboration
   when the sources share an author.
2. **The "error trail" claim is RETRACTED.** The eight `spotme-web-v2`
   references across five reports were described as sessions misreading a green
   check. Checking the reports refutes it — three name the project as an
   **assigned mission target**: `2026-08-07-deploy-drive.md` ("Mission: deploy
   `api` (Railway) and `spotme-web-v2` (Vercel) from `master`"),
   `2026-08-06-land-deploy-drive.md` (task 4), and
   `2026-08-06-land-and-iphone.md` (task 4a). Those sessions were *directed*
   there. That is evidence about where work was pointed, and it supports the
   audience-is-`web-v2` reading rather than undermining it.

**Nothing available can settle it.** Vercel Web Analytics is **disabled on both
projects** (`web_analytics_not_enabled`, checked 2026-08-07) and neither has a
custom domain. No repository fact and no platform fact closes P10 — owner only.

**Consequence:** slice 0's Root Directory repoint waits on P10. The fence
rewrites and package restructure do not.

Both Spot Me projects are repo-connected and both build on every master push
(one commit → two builds). Verified against the Vercel API 2026-08-07: merges
of #134 (`17654da`), #135 (`772a92a`), #136 (`097bc78`) and `356eb62` each
produced a **production** deployment on `spotme-messenger` and only a
**preview** (`target: null`) on `spotme-web-v2`. The latter reached production
solely through manual agent CLI pushes (`actor: claude-code_2-1-224_agent`).

The duplicate is not merely redundant: `spotme-web-v2` carries `NODE_ENV` in
its Vercel environment, which omits devDependencies, loses `vite`, and fails
the build at exit 127 — fixed only by putting `--include=dev` into the
**shared** `spotme/web/vercel.json`. One repository file is bent to serve one
duplicate project.

Neither project has a custom domain, which is why deployment metadata — not a
URL someone remembers — is the thing to read. CLAUDE.md's table separates a
git-triggered promotion (`githubCommitRef: master`, `githubDeployment: 1`, no
`actor`) from a manual CLI `--prod` run (branch ref or `HEAD`, no
`githubDeployment`, `actor: claude-code_..._agent`).

### P5 constraint — retiring `spotme/app` must not touch `spotme/core`

`spotme/app/package.json` declares `"spotme-core": "file:.."`, resolving to
`spotme/` itself (`spotme/package.json` is *named* `spotme-core`). Separately
`spotme/web` declares `"spotme-core": "file:vendor/spotme-core"` and its
`prebuild` copies `../core` into `vendor/spotme-core/core`. **`web/src/app.js:10`
and `web/src/views/chat.js:20` import `spotme-core/core/translit.js`** — the
Indic transliteration engine on the composer's critical path.

**Deleting the parent alongside the app removes transliteration from the live
product.** `spotme/core`, `spotme/package.json` and
`spotme/web/vendor/spotme-core/` are out of scope for P5.

### Open after P1–P8

| # | Item |
|---|---|
| P5b | Prune `spotme/core` to `translit.js` and drop the vendored P2P copy. `web/src` imports one file from spotme-core; the other five (`swarm.js` Hyperswarm, `room.js` Autobase/Hypercore, `identity.js`, `schema.js`, `index.js`) are ADR-033 residue, committed twice. Touches the live build — separate PR. |
| P9 | Retire `spotme-web-v2` — the CLAUDE.md direction, but **should wait on P10**: if the audience is there, retiring it deletes the surface people use, and the direction needs revisiting rather than executing. Owner-retained regardless. |
| P10 | **OPEN — blocks the Root Directory repoint.** Which project do real testers open? Currency settled; audience not. Web Analytics disabled on both, no custom domains, and CLAUDE.md restates the pipeline read rather than corroborating it. Owner-only fact. |
| P11 | Appetite for characterization tests before each rewrite — no view-level coverage exists anywhere (ADR-035 §A.1). |

### Assigned, no longer unowned

The **five backend `*-dark-fences.spec.ts` rewrites are slice 0's first task**,
gated before the monorepo move and tamper-checked. They assert web-next's
isolation; dissolving it removes the only thing keeping Phase 2–6 dark.

### P4 revisit trigger

After slice 1 ships, count the spacing, colour and type values in its React CSS
**not** drawn from a `tokens.css` custom property. Small ⇒ plain CSS held and
Tailwind stays unadopted. Large ⇒ measured drift, and Tailwind gets its own PR
on that evidence.
