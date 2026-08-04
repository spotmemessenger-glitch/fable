# AI Interactive Map — Operations & Activation (Phase 6E)

> **Status: Implemented (Draft PR — DARK).** Nothing here is live. The
> instrumentation is dark (no call sites; Phase 1G gates), the runbooks are
> pre-positioned, and the activation checklist is a list of OWNER decisions —
> none is taken by this phase.

## 1. Closed metrics (X9)

`backend/src/assistant/assistant.observability.ts` — names + closed label
sets on the SHARED Phase 1G registry, registered only under
`METRICS_ENABLED=true`, with NO call sites this phase.

| Metric | Labels (closed enums) |
|---|---|
| `assistant_queries_total` | `outcome` (answer kinds + invalid), `domain` (5 + none) |
| `assistant_answer_duration_seconds` | `outcome` |
| `assistant_sensitive_queries_total` | `category` (closed sensitive set) |
| `assistant_evidence_minted_total` | `license` (the six-member class) |
| `assistant_integrity_failures_total` | `code` (closed AssistantError set) |

Hard rule (fence-tested): a query/text-shaped label KEY is refused by name;
every label VALUE must be an enum member — query text, source names,
coordinates, and decimals can never become labels.

## 2. Runbooks

### RB-A1 — Provider outage (evidence/review/route source down)
Symptoms: `unavailable` answers spike (`outcome=unavailable`). Actions:
1. Confirm which adapter degrades (provider label in its own subsystem — the
   assistant carries no provider names in labels).
2. The assistant degrades HONESTLY by design: `unavailable` and
   `insufficient-evidence` are answers, not errors — do NOT bypass the mint
   boundary or relax freshness gates to "restore" answers.
3. If a provider will be down long-term, flip its domain to `unavailable` in
   the darkness registry (config change, owner-approved) so intent routing
   answers honestly up front.

### RB-A2 — Evidence-integrity incident (bad/poisoned/unlicensed evidence)
Symptoms: `assistant_integrity_failures_total` spikes (`code=
unlicensed-evidence|forbidden-evidence-field|citation-*`), or a report of a
wrong answer. Actions:
1. Integrity throws already fail closed — affected statements produced NO
   claims. Capture the failing source id (never content) from the adapter.
2. Quarantine the source: remove/disable its adapter binding; dependent
   claims invalidate automatically (envelope law — removing evidence
   invalidates claims; re-proven in `assistant-citation-observability`).
3. If content DID display: it was cited — use the citation to identify every
   affected record via `contentRef`/`integrityDigest`, purge the records, and
   document the disclosure.
4. Never relabel license classes post-ingestion — records are frozen;
   re-ingest through the mint boundary or not at all.

### RB-A3 — Privacy incident (query text or precise location observed)
1. Treat as SEV-high. The design invariant is that no such sink exists
   (QueryHandle, closed-code errors, closed metrics, mutation batteries) — an
   observation means a fence was bypassed; find the code path, do not just
   delete the data.
2. Stop the leak (disable the surface — it is one module import / one mount).
3. Purge the sink (logs/traces/analytics), document scope and duration.
4. Add the failing case to the X9 battery BEFORE re-enabling.

### RB-A4 — Dark rollback
The assistant is two lines away from nonexistence: the `AssistantModule`
import in `AppModule` (backend) and the `AssistantShell` mount in `App`
(web-next). Rollback = revert those lines. No migration, no data, no queue,
no cache exists for this module — there is nothing else to unwind.

## 3. Activation checklist (ALL owner-gated; none satisfied this phase)

1. **Provider licensing + spend** — signed licenses for every evidence/
   review/route source; license class per source recorded; spend ceiling
   approved. D11a stands: authorized/licensed sources only, no scraping.
2. **The LLM-provider decision** — any model-backed intent/summary adapter
   goes THROUGH the Phase 1E AI Gateway ports with the deterministic baseline
   as mandatory fallback; provider choice, routing policy (accuracy/latency/
   privacy/cost — no hard dependency), and spend are owner decisions. Until
   then the deterministic composer defines correctness.
3. **Sensitive-query copy ratification** — the [PROPOSED] notices; local
   emergency information requires a separately authorized verified source.
4. **Domain activation order** — flipping any domain to `activated` in the
   darkness registry is per-domain owner approval, AFTER that domain's own
   module activates (the assistant must never lead a domain out of darkness).
5. **Module wiring** — the `AssistantModule` import and the web-next mount
   (RB-A4 in reverse), each its own reviewed change.
6. **Observability** — `METRICS_ENABLED` rollout with the closed registry;
   the X9 label fences stay in CI.
7. **A11y re-audit on the live surface** — citation comprehension included.

## 4. Verification (6E)

- X10 fence battery: `backend/test/assistant-dark-fences.spec.ts` — 16
  assertions across module darkness, source-tree scans (AI SDK/model/env/
  HTTP-client/domain-internals/persistence/hash/rating), build-artifact scan,
  and behavioral re-proofs. Tamper-checked non-vacuous (adding an
  `OPENAI_API_KEY` read + `fetch` to the subtree fails 2 fences).
- Citation invariants + metrics fence:
  `backend/test/assistant-citation-observability.spec.ts`.
- Full assistant suite: 91 backend tests + 21 web-next tests green at 6E.
