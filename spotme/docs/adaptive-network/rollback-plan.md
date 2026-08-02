# Rollback plan — adaptive network production layer (P2D)

The layer ships dark, so rollback has two regimes.

## Regime A — before any activation (the state this PR ships)

Rollback is **deletion with zero user impact**: no data was ever written (the
outbox database is never created while flags are off), no crypto changed, no
call site changed.

1. `git revert` the P2D commits on `feat/adaptive-transport-scaffold`
   (engine → offline → mesh → adapters → factory/fence/bench → docs), or
   manually:
   - delete the production files under `web/src/lib/transport-supervisor/`
     (everything except the ADR-012 scaffold list) and `adapters/`;
   - delete the eight `test/adaptive-{flags,supervisor,migration,adapters,
     outbox,mesh-production,stress,network-fence}.test.js` suites and
     `test/bench/adaptive-network.bench.mjs`;
   - remove their invocations from `web/package.json`;
   - revert the `outbox.js` additive `get()` and the `index.js` barrel block;
   - optionally revert the db.js wipe line (`spotme-adaptive-outbox`) — it is
     harmless either way (deleting a nonexistent DB), and KEEPING it is safer
     if any device ever ran an activation build.
2. The scaffold (ADR-012) remains intact and green; nothing imports either.
3. `npm test && npm run build` — the suite and bundle return to the pre-P2D
   state byte-for-byte (the bundle already contains no supervisor code).

## Regime B — after a future activation (for that PR's plan; recorded now)

- **Flags off = today.** Every engine constructs nothing when dark; the
  wiring site degenerates to the existing socket path (that is what the
  shadow-mode design is for). This is the first rollback lever and needs no
  data work.
- **Outbox:** envelopes still owed at rollback drain over the primary
  transport once flags return (or the store is dropped — it is a QUEUE, and
  the sender-visible failure states of today apply). The wipe path already
  covers deletion.
- **No wire-format debt:** every transport carries the same envelope; nothing
  written under one transport is unreadable under another (they meet at
  envelopeId + the room store, not at the wire).
- **The seal-lift's own rollback** (if it has landed by then) is governed by
  ADR-008 §12's rollback-after-publication precondition and the e2e version
  negotiation — outside this layer, by design.

## What rollback must NEVER do

- Remove the db.js wipe registration on a fleet that ever ran activation
  (wipe gap).
- Leave a sub-flag on with the master off — impossible by construction
  (`resolveFlags` layering), listed here so nobody "simplifies" it away.
