# Spot Me — Claude Code Configuration


## ⭐ Starting a session — READ FIRST (bootstrap protocol)

**The repository is the single source of truth.** Canonical project memory is
the **Engineering Handbook** at `spotme/docs/handbook/`. When the user says
**"recall previous session"**, "pick up from where you left off", "continue",
or `/pickup` — or on any new session — **run the bootstrap protocol before
writing any code**:

1. Read this file (`CLAUDE.md`).
2. Read the handbook entry point: `spotme/docs/handbook/README.md`.
3. Read the bootstrap protocol: `spotme/docs/handbook/00-BOOTSTRAP.md`.
4. Read the product authority (three pillars, the Create→Discover→Communicate
   loop, and the FIXED Discovery execution order — Smart Nearby Discovery Map →
   Live Nearby Events → Nearby Moments → AI Assistant & Personalization):
   `spotme/docs/handbook/product/README.md` and ADR-021
   (`spotme/docs/adr/021-spotme-unified-product-ecosystem.md`). Do not drift back
   to older roadmap priorities.
5. Read the current milestone and next approved mission:
   `spotme/docs/handbook/04-ROADMAP.md`.
6. Read the ADRs that govern the area you'll touch: `spotme/docs/adr/`.
7. **Verify repository state** (`git log origin/master`, open PRs, and
   `npm test && npm run lint && npm run build` in `spotme/web`) against
   `spotme/docs/handbook/03-IMPLEMENTATION-STATUS.md`.
8. **Report any mismatch before coding** — the handbook is a record; the
   repository is the truth. Never claim something works because a doc says so.
9. Then implement the approved milestone only, following
   `spotme/docs/handbook/05-GOVERNANCE.md` (G1–G9).

**Why this lives in the repo:** cloud/remote sessions run in a fresh clone.
Anything under `~/.claude/` (skills, memory notes) does NOT travel — only
committed files do. Keep the handbook current **in place** (Governance G9).

> **`.handoff/NEXT-SESSION.md` and `.handoff/SESSION-*.md` are RETIRED**
> (superseded by the handbook — see
> `spotme/docs/handbook/03-IMPLEMENTATION-STATUS.md` → Retired). They remain only
> as history; do not treat them as current.

## ⭐ Controlling engineering document — consult before ANY coding

**`spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md` is the engineering control
document for Spot Me. Read it (at minimum §2 rules, §5 priorities, §8
checklist, §10 instructions) before changing code, and check every change
against it.** The owner's instruction: refer to it each time you code.

- **V2 is APPROVED and controlling (owner directive, 2026-08-01).** The V1→V2
  mapping is `spotme/docs/14-ROADMAP-V1-TO-V2-MAPPING.md`; V1
  (`spotme/docs/MIGRATION-PLAN-V1.md`) is historical, and where V1 is stricter
  the stricter gate still holds (V2 Appendix B). The A1–A7 labels are retired
  wherever they conflict with V2. **Owner execution order (amended 2026-08-01
  — roadmap "Owner Amendment" section):** ① push notifications (Android+iOS,
  background/terminated/foreground, production-grade) → ② translation
  platform (provider abstraction over the existing multi-provider engine) →
  ③ live voice translation (flagship; dedicated architecture, NOT an
  extension of voice notes; MVP < 2.5 s end-to-end) → ④ adaptive
  communication layer (automatic transport switching incl. native Bluetooth
  offline; users never pick a transport) → ⑤ remaining Priority 1 crypto
  (X3DH → Double Ratchet → multi-device → completion evidence) — **still
  mandatory before Priority 1 is declared complete**. AI Communication ADRs
  may proceed as planning. New standing principle: every AI feature
  optimises accuracy + latency + privacy simultaneously; no provider may
  become a hard dependency — route/fall back on quality, availability, cost,
  response time.
- **V1/V2 priority numbers differ.** Owner blocks were issued against V1
  numbers — the mapping §1 restates them under V2 numbering. Never treat a
  renumbering as an unblock.
- The **ADR-008 §12 hard stop** (no signing-key generation/persistence/
  publication, prekeys, X3DH, ratchet, or multi-device until
  rollback-after-publication is executable or separately authorized) is
  unchanged by V2.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER add a `Co-Authored-By` trailer to user commits unless this project's `.claude/settings.json` has `attribution.commit` set (#2078). The Claude Code Bash tool may suggest one in its default commit-message template — ignore it. `Co-Authored-By` is semantic authorship attribution under git/GitHub convention; the tool is the facilitator, not a co-author.
- Keep files under 500 lines
- Validate input at system boundaries

## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

```bash
npm run build && npm test
```


## Repository layout note

**Unrelated projects share this repository** (ybot-assistant, ybot, cryptobot,
memebot, desk, jarvis, ysnap, obsidian-plugin, research). Spot Me lives under
`spotme/`; nothing outside it is part of the product. A proposal to split them
out is tracked in the owner decision sheet (`spotme/docs/handbook/DECISIONS.md`).

## Ruflo / claude-flow configuration

The Ruflo multi-agent configuration that used to live in this file moved,
content verbatim, to [RUFLO.md](RUFLO.md). It is tooling configuration, not
Spot Me product documentation.
