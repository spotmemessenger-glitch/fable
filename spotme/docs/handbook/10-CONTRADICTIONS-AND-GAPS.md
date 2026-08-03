# 10 — Contradictions & Honest Gaps

Where the repository disagrees with itself, and what is genuinely undocumented.
Recorded honestly (G4). Each item says what was verified and, where relevant, a
recommended fix — **this handbook does not silently change other files to
resolve them**; it surfaces them for owner decision.

> Verified 2026-08-03 against `master` `31e1894`.

## Contradictions (verified)

| # | Contradiction | Evidence | Recommendation |
|---|---|---|---|
| C1 | `09-TECH-STACK.md §2` states web has **"no ESLint config and no typecheck script"**, but a lint gate was merged (#21) and **`spotme/web/eslint.config.mjs` exists** with an `npm run lint` script. | `git ls-tree master spotme/web/eslint.config.mjs`; `web/package.json` `lint` script | Update `09-TECH-STACK.md §2`; it was written against older `master` `0316275` (pre-#21). |
| C2 | Discovery "location honesty" is described as fully approximate, but on `master` the v1 lobby **still broadcasts precise GPS**; the approximate-only model exists only in **draft PR #60**. | `web/src/lib/discovery.js` on master vs PR #60 | Do not claim the defect is fixed until #60 merges. Tracked in [08-SECURITY-AND-PRIVACY](08-SECURITY-AND-PRIVACY.md). |
| C3 | Prior project memory lived in `.handoff/NEXT-SESSION.md` (chat-derived), which G1/G3 supersede. The file can drift from the repository. | `.handoff/NEXT-SESSION.md` | **Retired** by this handbook (banner added); use [00-BOOTSTRAP](00-BOOTSTRAP.md). |
| C4 | **ADR-021 records a four-step** Discovery sequence; **Product Roadmap v2.0 records five** (SpotMe Exchange inserted at step 2, owner decision 2026-08-03). | `../adr/021-*.md` vs `product/SPOT-ME-PRODUCT-ROADMAP-V2.md §12` | ADR-021 is immutable (G6) and **not** edited; roadmap v2.0 is authoritative for the sequence. **Ratify via new ADR-022** superseding the sequence. Both preserved. |

## Anomalies (verified)

| # | Anomaly | Evidence | Recommendation |
|---|---|---|---|
| A1 | **Media-core contracts** branch `feat/media-core-contracts` is pushed but has **no open PR** (all-state PR query for that head returns empty), although a "draft PR for media-core" was recorded as done. | PR list query 2026-08-03 | Owner: open a PR for the branch, or fold/close it. Tracked in [09-OWNER-DECISIONS](09-OWNER-DECISIONS.md). |
| A2 | Accidental/garbage tracked files exist: **`spotme/'`**, **`spotme/created`**, **`spotme/openBundle(original.vaultKey`** (shell-mangled filenames committed by mistake). | `git ls-tree master spotme/` | Remove in a dedicated cleanup change (not this docs PR). |
| A3 | ADR numbers **009–013 are reserved by in-flight draft PRs** (#40 → 009–012; #43 → 013) that are **not on master**. Backfilled ADRs therefore start at **014** to avoid collision. | PRs #40, #43; `spotme/docs/adr/` has 001–008 on master | If #40/#43 merge, keep 009–013 as-is; this handbook's ADRs are 014+. |
| A4 | Two owner product-authority sources are referenced but **not committed verbatim**: **Spot_Me_Product_Scope_and_Execution_Roadmap** and the canonical architecture doc **SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY**. `SPOTME_NEW_PRODUCT_SCOPE_2026-08-02` **is** committed verbatim. | `handbook/product/` | Owner: provide the two docs to commit beside the scope doc; their execution decisions are already reflected in `product/DISCOVERY-PROGRAMME.md` and roadmap v2.0. |
| A5 | The **approved SpotMe Exchange specification** (a flagship capability) was **not present** in any available source. Roadmap v2.0 §14 is a **reconstruction** from the owner's named components + established principles, **pending ratification**. | `product/SPOT-ME-PRODUCT-ROADMAP-V2.md §14` | Owner: provide the verbatim Exchange spec; reconcile §14 against it. Do not treat §14 as final approved detail until then. |

## Honest gaps (genuinely undocumented / not built)

- **Nearby Moments / Stories / Reels** — *Planned*; no module, contract, or ADR
  in the repository. A data/privacy-model ADR is required before any code.
- **iOS client** — does not exist (no Xcode project).
- **Realtime scale detail** — the messaging realtime path is single-node on
  master; scale-out (Priority 3) is documented in Roadmap V2 as future, not
  built. Treat any "complete" wording as **single-node** unless proven otherwise.
- **Media-core / Media Platform architecture** — only contracts/types/safety
  exist on a branch (A1); the broader media platform is *Planned*.
- **Provider selection** for Discovery/Events — no authorized-source adapter is
  chosen; the foundations resolve to `unavailable` until one is added.

## How to use this page

When bootstrapping, cross-check any surprising status line against these
findings. When a contradiction is resolved (a doc corrected, a branch closed, a
foundation merged), **remove the item here in the same change** (G9) so this page
stays a live list, not a graveyard.
