MISSION: G8 CRYPTO TRAIN — DARK MERGE MILESTONE (#39 → #41 → #42 → #43)

Repo: spotmemessenger-glitch/fable. Goal: bring the built, dark
forward-secrecy stack onto master IN ORDER, still dark, fences green at
every step — per DECISIONS.md item 3 and ADR-025. Activation is NOT part
of this mission.

This document is an operational runbook. Its presence in the repository
does not authorize execution. Every execution requires a separately
completed OWNER AUTHORIZATION block in the invoking session and follows
the EXECUTION MODEL.

═════ OWNER AUTHORIZATION — fill in; the mission STOPS without it ═════
I authorize the G8 dark-merge milestone for PRs #39 → #41 → #42 → #43.
Decisions 1–8 (DECISIONS.md): [approve all as recommended | exceptions: …]
ADR-025 (PR #68): [Accepted — I merged #68 with Status flipped to Accepted]
Multi-device safety-number question (ADR-008 §BLOCKING):
  [decided: <state the decision> | NOT DECIDED — stop before #43]
═══════════════════════════════════════════════════════════════════════

NOTE: the committed version of this document MUST retain this block as
an unfilled template — no placeholder is ever replaced in the
repository copy. Authorization exists only in the session that invokes
a phase.

HARD GATES — PHASE 0 (verify in the repository; if ANY fails, STOP, name it)
1. The authorization block is filled in — no bracketed placeholders remain.
2. The Engineering Handbook is on master (spotme/docs/handbook/
   00-BOOTSTRAP.md exists at origin/master HEAD) — i.e., #62–#65 merged.
3. ADR-025 is on master with Status: Accepted (i.e., #68 merged after the
   owner flipped Proposed → Accepted). Status still Proposed = STOP.
4. PRs #39/#41/#42/#43 are open with their fences/tests as documented in
   03-IMPLEMENTATION-STATUS. Record master HEAD.
5. Re-read ADR-008 §12 and confirm scope stays inside it: dark merges only —
   no key publication, no production key generation, no flag flips.
   SIGNING_PUBLICATION_ENABLED and the e2e_v3 flag remain false throughout;
   verify by fence test after every phase.

AUTHORITY AND LIMITS
- You MAY: merge origin/master INTO the train branches (merge commits),
  resolve conflicts, run suites, push those branches, convert #39 to draft,
  comment verification evidence on the train PRs, open ONE final docs PR.
- You MUST NOT: rebase or force-push anything; merge any PR (owner merges);
  mark any PR ready (owner does); flip any flag; touch #60/#61, camera, or
  docs branches; delete anything.
- The owner merges each layer after review.

EXECUTION MODEL — one phase per session. This document is the G8 playbook;
invoke it as separate owner-approved sessions: the filled header + "Execute
Phase A only", then after your merge, a fresh session with "Execute Phase B
only — verify #39 merged first", and so on. Each session files its own
final report.

CUMULATIVE FENCES: at the end of every phase, enumerate and re-run the
fences of ALL earlier layers by name — not just the current PR's — and
report each green individually. A later layer must never disturb an earlier
layer's dark guarantee.

PHASE A — #39 (signing-key publication + executable rollback)
1. #39 draft state, idempotent: if Ready for Review, convert to Draft and
   record it (decision 1 — its hold condition, ADR-025, is resolved). If
   already Draft, record "no action required."
2. Merge origin/master into feat/signing-key-publication (merge commit).
   Resolve conflicts minimally; list every conflicted file and resolution
   in a PR comment.
3. Run: backend suite (provision PostgreSQL if the environment allows;
   otherwise verify CI green and say so), web suite, lint, build, and the
   signing fences (signing-not-shipped + the #39 fence extension).
4. ROLLBACK REHEARSAL: execute #39's withdraw/rollback e2e spec end-to-end
   here if a backend can run; otherwise verify it green in CI and record
   "rehearsal against a real staging deploy remains an owner pre-activation
   step." §12 satisfaction is the owner's call, stated as such.
   ROLLBACK SUCCESS CRITERIA — the rehearsal passes only if ALL hold, each
   with evidence: withdraw executes end-to-end and afterwards no published
   signing key remains served; existing e2e_v2 behaviour unaffected (suite
   green); SIGNING_PUBLICATION_ENABLED and the e2e_v3 flag verified false
   before AND after; full CI green; no schema rollback required (additive
   tables only); exact commands/spec names recorded so the owner can repeat
   the rehearsal against staging.
5. Comment the evidence on #39. STOP: owner reviews, marks ready, merges.

PHASE B — #41 (X3DH + prekeys) — after #39 is merged
Confirm #41's base retargeted to master (retarget if not), merge
origin/master in, full suites + fences (X3DH dark; prekey endpoints
additive; OPK single-consumption test green), evidence comment, STOP for
owner merge.

PHASE C — #42 (Double Ratchet) — after #41 is merged
Same procedure, plus re-run the 004b oracle conformance vectors and state
the pass count. Evidence comment, STOP for owner merge.

PHASE D — #43 (multi-device) — ONLY if the authorization block records the
ADR-008 §BLOCKING decision. If NOT DECIDED: stop, report A–C complete, and
list exactly what the owner must decide. If decided: same procedure, plus
verify single-device accounts are behaviourally unchanged (cite the tests).
STOP for owner merge.

PHASE E — CLOSE THE LOOP (one draft docs PR from master:
docs/g8-crypto-train-close), per G9:
- 03-IMPLEMENTATION-STATUS: each landed layer → Implemented (Merged) with
  PR + merge SHA; e2e_v3 marked "merged DARK — activation pending a
  separate owner-authorised change".
- DECISIONS.md: record the owner's marks from the authorization block,
  dated.
- ADR index: add ADR-025 (now on master).
- ADR-008 §12 note: what the rehearsal covered; what remains before
  activation. Open as ONE draft PR. Do not merge.

FINAL REPORT (cumulative, per phase)
Master HEAD at start and after each owner merge; every conflict and its
resolution; every suite/fence result with counts; rollback-rehearsal
evidence; flags verified false after every phase; docs PR link; anything
noticed but not touched. Activation is explicitly NOT performed and NOT
scheduled by this mission.
FINAL REPORT additionally includes the cumulative matrix: rows = phases run
so far; columns = merged-in / backend / web / lint / build / fences (all
prior layers) / rollback / flags-false — ✓ or n/a per cell.
