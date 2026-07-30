---
name: knowledge-extraction
description: Turn a public repository, standard, or documentation set into reusable, attributed engineering knowledge — patterns, checklists and decision rules — without copying code you are not licensed to reuse or inventing provenance you cannot support. Use when asked to "learn from", "extract patterns from", or "distil" a codebase or corpus.
---

# Knowledge extraction

The value in a good repository is rarely the code — it is the **decisions**: why
it is shaped this way, what it refuses to do, which trade-off it took. Extract
that, attribute it, and check the licence before any code travels.

## Procedure

1. **Scope and licence first.** Read `LICENSE` before anything else. Record the
   licence with the repo. Permissive (MIT/Apache/BSD) code may be adapted with
   attribution; copyleft (GPL/AGPL) pulls its terms into your work; "no licence"
   means no reuse rights at all — you may read it and learn, not copy it.
2. **Map before you read.** README, architecture docs, `docs/`, then the module
   layout. Understand the shape before opening a single implementation file.
3. **Extract the decisions, not the lines.** For each pattern worth keeping,
   write: what problem it solves, how this project solves it, what it costs, and
   when *not* to use it. That is portable; a copied function is not.
4. **Attribute every claim.** "Idempotency via a dedup key, as in
   `stripe/openapi`" — with the repo and, where it matters, the file. If you
   cannot point to where a claim comes from, do not present it as fact.
5. **Separate fact from inference.** "The README states X" is a fact. "This
   implies Y" is your inference — label it as yours.
6. **Produce a distilled artefact**, not a copy: a checklist, a pattern note, an
   ADR, or a set of routing rules. The test is whether a reader could apply it
   without cloning the source.

## What this skill will not do

- It will not present any company's internal or proprietary knowledge. Public
  repositories reveal how a project is built, not how a company runs.
- It will not vendor copyleft or unlicensed code into a permissive deliverable.
- It will not fabricate a citation. An unverifiable source is dropped, not
  smoothed over.

## Output shape

```
## Pattern: <name>
Source: <owner/repo>[ · <path>]   Licence: <spdx>
Problem: <one line>
Approach: <2-3 lines, in your words>
Cost / when not to: <one line>
Confidence: stated-in-source | inferred
```

Feed extracted patterns back to the requesting agent as structured notes; do not
leave them buried in prose.
