# Enterprise AI Engineer Pack

A "super brain" for enterprise engineering work in Claude Code: a **verified**
catalog of public repositories, a **deterministic router** that turns any task
into specialists + reference code + a pipeline, and **20 specialist agents**
covering the major vendor stacks and cross-cutting disciplines.

## The one honest constraint

No company's internal, proprietary, or confidential engineering knowledge is
public, and none is in this pack. Everything here is built from **public**
sources — official SDKs, reference architectures, open standards, open source,
and published engineering practice. That is how real enterprise AI teams build
internal assistants, and it is enough to do excellent work. Claims of inside
knowledge are not made here, and the agents are instructed never to imply them.

## What's in it

| Piece | Where | Count |
|---|---|---|
| Verified repo catalog | `catalog/*.txt` | 1,260 unique repos, 16 domains |
| Router + validator (stdlib only) | `src/superbrain/`, `scripts/sb` | — |
| Specialist agents | `agents/*.md` | 20 + 1 master |
| Skills | `skills/*/SKILL.md` | router, knowledge-extraction |
| Company skill maps (public-only) | `company-maps/` | 15+ orgs |
| Master install prompt | `INSTALL-PROMPT.md` | — |
| Tests | `tests/test_superbrain.py` | 12, all green |

Every catalogued repository was resolved with `git ls-remote` (no API token, no
rate limit); the record lives in `catalog/verified.json` and the tests fail if
any entry is unverified.

## Quick start

```bash
cd enterprise-pack
scripts/sb stats                         # what's in the pack + verification state
scripts/sb route "harden our REST API"   # specialists, skills, repos, pipeline
scripts/sb brief "migrate a COBOL batch to a service"   # paste-ready brief
scripts/sb search "kafka change data capture"           # rank reference repos
scripts/sb doctor                        # structural integrity
scripts/sb verify --only-failed          # re-resolve anything that failed
python3 tests/test_superbrain.py         # prove the router works here
```

No install step and no dependencies — it runs on a bare Python 3 interpreter, by
design, so a fresh remote clone works immediately.

## How routing works

1. **Classify the shape** from the verbs (bugfix / feature / refactor /
   performance / security / migration / research) → picks the pipeline.
2. **Score agents and repos** against the task. Repo scoring is IDF-weighted, so
   a rare specific term ("cdc") outranks a common one ("pipeline").
3. **Lead with the classified owner**, so the agent list agrees with the
   pipeline shown beside it.

The router is deterministic and every score is traceable — see
`skills/superbrain-router/SKILL.md`.

## The specialists

Vendor: `microsoft-enterprise-engineer`, `google-cloud-android-engineer`,
`apple-platform-engineer`, `oracle-database-engineer`, `sap-enterprise-engineer`,
`nvidia-cuda-engineer`, `ibm-mainframe-engineer`.

Cross-cutting: `security-engineer`, `data-engineer`, `devops-sre-engineer`,
`qa-automation-engineer`, `performance-engineer`, `cloud-architect`,
`ai-research-engineer`, `backend-architect`, `frontend-architect`,
`mobile-architect`, `ui-ux-engineer`, `solutions-architect`,
`enterprise-integration-engineer` — coordinated by `enterprise-master-agent`.

Each carries a scope, its public grounding (named catalog repos), a method, and
non-negotiables built around one rule: **verify by running, and say what you did
not do.**

## Maintaining the catalog

```bash
scripts/sb verify              # re-resolve everything (~30s, 1,260 repos)
scripts/sb prune --apply       # drop entries that no longer resolve
scripts/sb doctor              # catch missing tags/notes, duplicates, dead agents
```

Add a repo by appending an `owner/repo | tags | why it matters` line to the
right `catalog/*.txt` file, then `sb verify --only-new`.
