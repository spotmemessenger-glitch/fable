# Camera engine — rollback plan (mission CAM-1)

The rollback story is short BECAUSE the design bought it: the module is
additive, dark, dependency-free, egress-free and persistence-free. There
is no data to migrate, no schema to downgrade, no key material, no server
side, and no user-visible state on any device.

## While dark (the current state)

| Situation | Action | Blast radius |
|---|---|---|
| Remove the mission entirely | `git revert` the feat/camera-engine commits (they touch only `src/lib/camera/**`, `test/camera-*`, `test/helpers/fake-media.js`, `test/bench/camera.bench.mjs`, docs, and the package.json test chain line) | None. The app was byte-identical with the module present (bundle fence proved dist/ contains none of it); removing it changes nothing users see |
| Suspected fence breach (an import appeared) | `node test/camera-fence.test.js` pinpoints the importer; revert that importing commit | None while the flag chain is dark — the factory is inert even if imported |
| One suite starts failing | Fix forward or revert the specific camera commit; suites are per-module and independent of the app's suites | CI only |

## After the (future) wiring PR lights flags

The layered tree is the rollback lever, finest to coarsest:

1. **One capability misbehaves** (e.g. night mode ghosting): flip its one
   flag (`CAMERA_NIGHT_ENABLED: false`) in a one-line PR. The capability's
   namespace reverts to the same machine-readable FLAG_DISABLED refusals
   it shipped with — call sites already handle them, because dark was the
   shipped state they were written against.
2. **The engine misbehaves:** flip `CAMERA_ENGINE_ENABLED`. Factory
   returns the inert stub everywhere.
3. **Platform-level stop:** flip `AI_CAMERA_ENABLED`. Every mission (1–4)
   goes dark in one move.
4. **Code-level:** revert the wiring PR, then (only if desired) the
   library commits.

In every case: no data cleanup exists to do (nothing persisted), no server
coordination (nothing egressed), no key/trust events (no crypto). A user
mid-recording at flip time keeps their in-memory blob until page close —
acceptable: nothing is stored.

## Rollback rehearsal evidence

- Dark-state equivalence is CONTINUOUSLY rehearsed: every `npm test` run
  proves the inert factory + all-false flags + no-import fence, and the
  post-build fence proves dist/ purity (run green 2026-08-02).
- Flip-back behaviour is rehearsed by the engine suite: the same call
  sites are exercised against dark (stub) and lit (live) engines in
  `test/camera-engine.test.js`.
