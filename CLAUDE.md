# Ruflo — Claude Code Configuration

## ⭐ Starting a session — READ FIRST (bootstrap protocol)

**The repository is the single source of truth.** Canonical project memory is
the **Engineering Handbook** at `spotme/docs/handbook/`. When the user says
**"recall previous session"**, "pick up from where you left off", "continue",
or `/pickup` — or on any new session — **run the bootstrap protocol before
writing any code**:

1. Read this file (`CLAUDE.md`).
2. Read the handbook entry point: `spotme/docs/handbook/README.md`.
3. Read the bootstrap protocol: `spotme/docs/handbook/00-BOOTSTRAP.md`.
4. Read the current milestone and next approved mission:
   `spotme/docs/handbook/04-ROADMAP.md`.
5. Read the ADRs that govern the area you'll touch: `spotme/docs/adr/`.
6. **Verify repository state** (`git log origin/master`, open PRs, and
   `npm test && npm run lint && npm run build` in `spotme/web`) against
   `spotme/docs/handbook/03-IMPLEMENTATION-STATUS.md`.
7. **Report any mismatch before coding** — the handbook is a record; the
   repository is the truth. Never claim something works because a doc says so.
8. Then implement the approved milestone only, following
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

## Agent Comms (SendMessage-First Coordination)

Named agents coordinate via `SendMessage`, not polling or shared state.

```
Lead (you) ←→ architect ←→ developer ←→ tester ←→ reviewer
              (named agents message each other directly)
```

### Spawning a Coordinated Team

```javascript
// ALL agents in ONE message, each knows WHO to message next
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

// Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

### Patterns

| Pattern | Flow | Use When |
|---------|------|----------|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

### Rules

- ALWAYS name agents — `name: "role"` makes them addressable
- ALWAYS include comms instructions in prompts — who to message, what to send
- Spawn ALL agents in ONE message with `run_in_background: true`
- After spawning: STOP, tell user what's running, wait for results
- NEVER poll status — agents message back or complete automatically

## Swarm & Routing

### Config
- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

### Agent Routing

| Task | Agents | Topology |
|------|--------|----------|
| Bug Fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

### When to Swarm
- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM, use Edit directly |
| 2 | Haiku | Simple tasks, low complexity |
| 3 | Sonnet/Opus | Architecture, security, complex reasoning |

## Memory & Learning

### Before Any Task
```bash
npx @claude-flow/cli@latest memory search --query "[task keywords]" --namespace patterns
npx @claude-flow/cli@latest hooks route --task "[task description]"
```

### After Success
```bash
npx @claude-flow/cli@latest memory store --namespace patterns --key "[name]" --value "[what worked]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true --store-results true
```

### MCP Tools (use `ToolSearch("keyword")` to discover)

| Category | Key Tools |
|----------|-----------|
| **Memory** | `memory_store`, `memory_search`, `memory_search_unified` |
| **Bridge** | `memory_import_claude`, `memory_bridge_status` |
| **Swarm** | `swarm_init`, `swarm_status`, `swarm_health` |
| **Agents** | `agent_spawn`, `agent_list`, `agent_status` |
| **Hooks** | `hooks_route`, `hooks_post-task`, `hooks_worker-dispatch` |
| **Security** | `aidefence_scan`, `aidefence_is_safe`, `aidefence_has_pii` |
| **Hive-Mind** | `hive-mind_init`, `hive-mind_consensus`, `hive-mind_spawn` |

### Background Workers

| Worker | When |
|--------|------|
| `audit` | After security changes |
| `optimize` | After performance work |
| `testgaps` | After adding features |
| `map` | Every 5+ file changes |
| `document` | After API changes |

```bash
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
```

## Agents

**Core**: `coder`, `reviewer`, `tester`, `planner`, `researcher`
**Architecture**: `system-architect`, `backend-dev`, `mobile-dev`
**Security**: `security-architect`, `security-auditor`
**Performance**: `performance-engineer`, `perf-analyzer`
**Coordination**: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
**GitHub**: `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

Any string works as a custom agent type.

## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

```bash
npm run build && npm test
```

## CLI Quick Reference

```bash
npx @claude-flow/cli@latest init --wizard           # Setup
npx @claude-flow/cli@latest swarm init --v3-mode     # Start swarm
npx @claude-flow/cli@latest memory search --query "" # Vector search
npx @claude-flow/cli@latest hooks route --task ""    # Route to agent
npx @claude-flow/cli@latest doctor --fix             # Diagnostics
npx @claude-flow/cli@latest security scan            # Security scan
npx @claude-flow/cli@latest performance benchmark    # Benchmarks
```

26 commands, 140+ subcommands. Use `--help` on any command for details.

## Setup

```bash
claude mcp add claude-flow -- npx -y ruflo@latest mcp start
npx ruflo@latest doctor --fix
```

> The background `daemon` is optional. It runs interval workers that each spawn
> a headless `claude` session, so it consumes tokens continuously. Start it only
> if you want those sweeps: `npx ruflo@latest daemon start` (self-stops after 12h
> by default; `--ttl 0` to disable, `daemon status --all` to audit running daemons).

**Agent tool** handles execution (agents, files, code, git). **MCP tools** handle coordination (swarm, memory, hooks). **CLI** is the same via Bash.
