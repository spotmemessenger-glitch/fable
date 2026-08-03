# 00 — Session Bootstrap Protocol (G5)

**Every session — human or Claude Code — runs this before writing code.** Its
purpose is to prevent context loss: the repository, not chat history, tells you
where things stand.

## The protocol

1. **Read `CLAUDE.md`** (repo root) — the standing rules and the pointer here.
2. **Read this handbook's entry point** — [README](README.md).
2a. **Read the product authority** — [product/README](product/README.md) (the
   three pillars, the loop, and the fixed Discovery execution order) and
   **[ADR-021](../adr/021-spotme-unified-product-ecosystem.md)**. This is what
   keeps sessions from drifting back to older roadmap priorities.
3. **Read the current milestone** — [04-ROADMAP §Current milestone](04-ROADMAP.md).
4. **Read the next approved mission** — [04-ROADMAP §Next approved mission](04-ROADMAP.md).
5. **Read the ADRs that govern the area you will touch** — [../adr/](../adr/README.md).
6. **Verify repository state before trusting any status line**, using the checks
   below. A status line is a *record*; the repository is the *truth*.
7. **Report mismatches before coding.** If what you find contradicts what the
   handbook says, say so first and stop for owner direction — do not silently
   proceed on either version.
8. **Only then begin implementation**, of the approved milestone only, following
   [05-GOVERNANCE](05-GOVERNANCE.md).

## Verification checklist (step 6)

Run these and compare against [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md):

```bash
# Where is master, and what is the latest merged work?
git fetch origin master && git log origin/master --oneline -15

# What is open (draft foundations live here, not on master)?
#   via the GitHub MCP tools: list_pull_requests state=open

# Does a foundation actually ship dark? (fence tests are the proof)
cd spotme/web && npm test        # node --test suites; must be green
npm run lint && npm run build     # lint clean, build succeeds
```

- **Merged** work is on `origin/master` (a commit you can `git show`).
- **Draft-PR** work is on a `feat/*` branch with an **open** PR — it is *not* on
  master. Do not describe it as shipped.
- A **dark** foundation has a `*-not-shipped.test.js` fence proving it is
  flag-gated, not wired in, and tree-shaken from `dist`. If the fence is green,
  the feature is built but inert.

## What a fresh session must be able to answer after bootstrapping

From the repository alone (this is the [bootstrap test](05-GOVERNANCE.md#g5)):

| Question | Where the answer is |
|---|---|
| What product is this? | [01-PRODUCT-VISION](01-PRODUCT-VISION.md) |
| What is the current milestone? | [04-ROADMAP](04-ROADMAP.md) |
| What is the next approved mission? | [04-ROADMAP](04-ROADMAP.md) |
| Which work is merged? | [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md) — *Implemented (Merged)* |
| Which work exists only in draft PRs? | [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md) — *Implemented (Draft PR)* |
| Which ADRs govern the architecture? | [../adr/](../adr/README.md) |
| Which governance rules apply before coding? | [05-GOVERNANCE](05-GOVERNANCE.md) |

## Standing prohibitions (unless the owner explicitly authorises otherwise)

- Do not merge, mark a draft ready, or enable auto-merge.
- Do not activate feature flags or wire an unfinished foundation into the app.
- Do not change runtime behaviour as a side effect of a documentation or
  foundation task.
- Respect the ADR-008 §12 hard stop on signing-key generation/publication (see
  [../adr/](../adr/README.md) and `spotme/docs/adr/008-signing-key-storage.md`).
