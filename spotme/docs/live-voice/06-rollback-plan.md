# Live Voice Translation — rollback plan

Three rollback levels, cheapest first. The design guarantee that makes all
three safe: the translated stream is ADDITIVE — the original E2E call never
depends on any live-voice code, so no rollback can hurt a call.

## Level 0 — runtime kill (seconds, no deploy)

Unset/void the flags where they are set (env/deploy config):

```
LIVE_VOICE_ENABLED=            # master — everything below it dies with it
```

Layering means the master alone is sufficient; sub-flags cannot outlive it.
Sessions in flight: the next `attach()` refuses; existing integrations are
detached by the app restart, and even without one every provider path is
deadline-bounded. No data to clean up — nothing was persisted.

## Level 1 — disable one capability (surgical)

| Symptom | Flag to drop | Result |
|---|---|---|
| TTS cost/latency/abuse | `VOICE_CLONE_ENABLED` (clone→generic) or demote via ladder `forceBottom` | captions continue |
| Provider outage/scandal | `STREAMING_PROVIDER_ENABLED` | adapters refuse to open a real transport; sessions degrade to original-only |
| Group problems | `GROUP_TRANSLATION_ENABLED` | 1:1 unaffected |
| MT spend | `LIVE_TRANSLATION_ENABLED` | attach() refuses entirely (it requires this + master) |

## Level 2 — full removal from the tree (a clean revert)

The module graph makes this mechanical (fence-tested: nothing else imports
live-voice):

1. `git rm -r spotme/web/src/lib/live-voice/`
2. `git rm spotme/web/test/live-voice-*.test.js spotme/web/test/bench/live-voice.bench.mjs spotme/web/test/helpers/fake-translation-provider.js`
3. In `spotme/web/package.json`: remove the trailing `&& npm run
   test:live-voice` from `test`; delete the `test:live-voice` script (or
   restore the scaffold's five-file version if reverting only to #49).
4. Revert the one-hunk carve-out in
   `spotme/web/test/translation-v2-not-shipped.test.js`
   (`isFencedConsumer`).
5. `git rm -r spotme/docs/live-voice/ spotme/docs/adr/011b-live-voice-platform.md`
6. `cd spotme/web && npm test` → the pre-branch suite must be green.

No schema, no storage, no config outside the files above — removal leaves
the tree exactly as the base branches left it.

## Rollback rehearsal evidence

The OFF state is continuously rehearsed: the entire test suite runs with
every flag off (asserted by `live-voice-flags.test.js` and the fence), so
"flags down = today's app" is CI-proven on every run, not a claimed
property.
