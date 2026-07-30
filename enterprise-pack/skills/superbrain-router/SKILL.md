---
name: superbrain-router
description: Route any enterprise engineering request to the right specialist agents, skills and verified reference repositories, and get a paste-ready brief. Use at the start of any non-trivial build, migration, review, or research task to decide who does the work and what public prior art to consult first.
---

# Superbrain router

The router is the deterministic front door to the Enterprise AI Engineer Pack.
It runs before any model call, so it is cheap, explainable and testable — every
score traces back to a matched token.

## Use it

From `enterprise-pack/`:

```bash
scripts/sb route  "<the task, in the user's words>"   # specialists + repos + pipeline
scripts/sb brief  "<the task>"                          # the same, as a markdown brief
scripts/sb search "<keywords>" [--domain <name>]        # rank catalogued repos
scripts/sb stats                                        # what is in the pack
scripts/sb doctor                                       # integrity check
scripts/sb verify [--only-new|--only-failed]            # resolve repos with git ls-remote
```

`sb route --json` emits structured output for programmatic use.

## How to read a route

- **shape** — bugfix / feature / refactor / performance / security / migration /
  research. It decides the **pipeline** (the ordered specialist roles).
- **agents** — the specialists to spawn, the classified owner first.
- **repos** — verified public reference implementations, ranked by an
  IDF-weighted match so a rare, specific term outweighs a common one.
- **domains** — which corners of the catalog the task touched.

## Rules the router enforces downstream

1. **Ground every design in named public prior art.** The repos in a route are
   evidence of a working pattern — cite them, do not blindly vendor them.
2. **Verify before you quote.** If `sb stats` says the catalog was never
   verified, run `sb verify` before presenting any repo as live.
3. **Licence and provenance** travel with any reused pattern (see the
   `knowledge-extraction` skill).
4. **No invented references.** Every repo cited is in the catalog or checkable
   now. Uncertain means say so, not fabricate a URL.

## When to skip it

Single-file edits, one-line fixes, and pure questions do not need routing — do
them directly. Reach for the router when the work spans multiple files,
specialisms, or you do not yet know who owns it.
