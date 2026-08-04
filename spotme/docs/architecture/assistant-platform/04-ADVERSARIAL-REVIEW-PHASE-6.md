# Phase 6 — X11 Adversarial Review & Disposition (13 lenses)

> Conducted 2026-08-04 against the full 6A→6E chain (PRs #103–#107) under the
> X11 correction: the thirteen lenses enumerated exactly; CRITICALs, Highs,
> and bounded Mediums fixed with regression tests. Repairs were committed at
> their ORIGIN group (F2–F4 on 6B, F1 on 6C) and forward-merged 6B→6C→6D→6E
> with ordinary merge commits; 6E re-validated the complete chain.

## Findings & dispositions

| # | Lens | Severity | Finding | Disposition |
|---|---|---|---|---|
| F1 | (6) precise-location, (7) route honesty | **High** | The route boundary's exact-grid check falsely rejected ~1.6% of legitimate 3-decimal values (float representation, e.g. `32.331`) and — decisively — 100% of the client's canonical `coarsenForPublic` output, which carries per-identity jitter (±0.0009°). A raw device fix deviates ≤0.0005° from the grid (less than the jitter envelope), so server-side off-grid "precise" detection is numerically impossible. | **Fixed (6C `1336b90`).** The boundary QUANTIZES origin and destination to the public grid before anything downstream (events venue-coarsening precedent): nothing finer than cell resolution reaches an adapter or estimate by construction. Primary X6 enforcement remains the client branded type + device-local coarsening. `precise-route-origin` reserved in the closed registry for an activation-time origin-provenance model. Regressions: jittered coarse accepted; float-hostile grid values accepted; precise digits unrecoverable from every advice shape; 6E fence re-pointed at the quantizing guarantee. Docs corrected (02, programme, status). |
| F2 | (5) query privacy + sensitive | Medium | The service classified the sensitive category inside the try block and answered `'none'` on failure paths — a crisis query hitting an unconfigured provider lost its crisis notice. | **Fixed (6B `bd7150c`).** Category classified before the try and reused on both catch paths. Regression: a health query on the unavailable path keeps its category and notice. |
| F3 | (8) aggregation/confidence | Medium | Duplicated citation ids in one statement inflated the confidence `density` basis (level was safe — it keys on diversity — but the displayed basis was manipulable). | **Fixed (6B `bd7150c`).** Citation ids collapsed via Set in the composer AND records deduped by id in `confidenceFor` (defence in depth). Regression: quadruple-citing one record yields density 1. |
| F4 | (1) fabrication, (4) freshness, (10) payload containment | **High** | Current-state ASSERTIONS could arrive as free text inside a statement param — e.g. a review theme claiming "open right now" — riding a non-current-state category past the X4 category-based freshness gate. | **Fixed (6B `bd7150c` + 6C `1336b90`).** `CURRENT_STATE_LANGUAGE` guard: any rendered claim matching current-state language must be a current-state-category claim on fully current evidence, else the statement dies fail-closed — in the composer AND the review engine (reviews are never current-state). Regressions: sneaky review theme yields no claim; legitimate current hours claims survive (control). |

## Lens-by-lens conclusions (no further findings at fix-worthy severity)

1. **Fabrication** — no prose path (type-level + `never`-proof + null composition); closed template registry throws on unknown keys; F4 closes the free-text current-state hole. Params remain adapter-supplied DATA in fixed templates; sanitized, bounded.
2. **Citation integrity/spoofing** — in-envelope resolution, category match, frozen records (relabel throws), evidence-removal invalidation, no uncited source rides along — all invariant-tested. F3 closes density inflation.
3. **Licensing/no-scrape** — closed six-member class at type level AND mint-boundary throw by name; `scraped`/`unknown` unrepresentable; permitted-use + attribution mandatory; review port licensed-only; no fetch/HTTP client exists to scrape with (fence).
4. **Freshness/supersession** — `CurrentStateCategory` × freshness gate at validate AND compose; F4 extends to language; stale display-with-disclosure in the UI; worst-freshness degrades confidence.
5. **Query privacy + sensitive** — QueryHandle (serialization-proof, bounded lifetime), closed-code errors, random correlation ids, closed-field telemetry, closed metric labels (key-name + enum-membership), no storage/hash primitive in the subtree (fence); mutation batteries scan console/outbound/state for text markers. F2 closes the category-loss gap. Copy digit-free, [PROPOSED].
6. **Precise-location leakage** — device fix only inside `coarsenForPublic`; mutation battery proves outbound coordinate tokens are exactly the coarse values; F1 makes the server route boundary structurally cell-resolution.
7. **Route/ETA/hours honesty** — attributed passthrough, null-preserving; straight-line fixed label with no duration field (type + render + fence); hours under X4; F1 documented honestly.
8. **Aggregation/confidence manipulation** — diversity+freshness+density basis; same-source pile-ups stay medium (tested); F3 closes duplicate citations; conflicts stay visible (mixed), never averaged.
9. **Domain-darkness bypass** — live registry frozen all-dark; live answers `domain-not-active` for all five domains (fence-level re-proof); fixture activation construction-guarded to test env (tested by env flip).
10. **Provider-payload/prompt-injection containment** — forbidden fields refused by presence at mint; content is an opaque ref + digest; params sanitized and template-slotted; no field persists toward future model input; F4 closes the linguistic vector.
11. **A11y + citation comprehension** — labeled search form, honestly-disabled mic with AT-exposed reason, per-claim `aria-describedby` to citations, full-text citation labels from normalized records, role=status honest states, role=note sensitive notice — UI-tested.
12. **Import/dependency/artifact scans** — module unimported (backend + web-next entries scanned), no external reach into the subtree, no AI SDK/model/endpoint/env token, no network client, no domain-internal imports, no persistence/hash primitives, no new dependencies, built-artifact scan clean.
13. **Test vacuity + doc honesty** — source-scan fences tamper-checked (planted `OPENAI_API_KEY` + `fetch()` failed exactly the 2 expected fences; restored green); behavioral tests assert positive controls alongside negatives; doc claims corrected where the review falsified them (F1 throw→quantize) and evidence counts refreshed.

## Post-repair validation (6E head)

Backend **146** green (assistant 99 incl. regressions + prior-phase dark
fences 47); typecheck clean. Contracts boundary fence **6/6** + typecheck +
declaration build. Web-next **105** green + isolation fence **6/6** + build.
`AppModule` and `App.tsx` untouched across the chain.
