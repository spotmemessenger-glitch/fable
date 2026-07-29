---
name: pickup
description: Resume work exactly where the previous session ended. Reads the handoff brief in fable/.handoff/ and reports current state, the agreed next task, and what is blocked — before doing anything else. Use when the user says "recall previous session", "recall last session", "pick up from where you left off", "continue from last session", "resume", "/pickup", or otherwise starts a session expecting continuity from prior work.
---

# /pickup — resume from the last session

The user should never have to re-explain context. Everything needed is on disk.

## Do this, in order

1. **Read the brief** — `C:\Users\yuv\fable\.handoff\NEXT-SESSION.md`.
   This is the authoritative pickup document: constraints, the agreed next
   task, known traps, measured numbers, what is unproven, what is blocked.

2. **Read the log only if needed** —
   `C:\Users\yuv\fable\.handoff\SESSION-2026-07-29.md` holds the chronological
   evidence. Skip it unless the user asks "why" or you need detail the brief
   omits.

3. **Verify before trusting.** The brief records what was true when written.
   If it names a file, version, container or service you are about to rely on,
   check it still exists. State-drift between sessions is normal — containers
   stop, keys get rotated, packages change.

4. **Report back in under 15 lines:**
   - where things stand (one or two sentences)
   - **the agreed next task**, named explicitly
   - anything still blocked on the user
   - anything the brief claimed that no longer holds

5. **Then ask what to work on**, offering the agreed next task as the default.
   Do not start editing code until the user confirms — the brief may be stale
   or their priority may have changed.

## Rules

- **Never claim something works because the brief says so.** The brief is a
  record, not a live check. Anything marked UNPROVEN in it stays unproven until
  you run it.
- **Surface the blocked-on-user list early.** Those items stall work and are
  easy to forget between sessions.
- If `.handoff/NEXT-SESSION.md` is missing, say so plainly and fall back to the
  memory note `ai-os-stack-2026-07-29` — do not guess at prior context.

## Keeping it current

At the end of a substantial session, update `.handoff/NEXT-SESSION.md` in place
rather than creating a new file — one brief, always current. Add a new
`SESSION-<date>.md` alongside it for that session's log.
