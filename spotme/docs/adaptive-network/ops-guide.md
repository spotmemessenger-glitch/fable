# Ops guide — running and reading the adaptive network

Applies from shadow-mode activation onward; useful now for reviewers reading
tests. Everything observable is **counts, timings, reasons, and public
values** — never keys, never plaintext, never message content (the 17-CRYPTO
§11 telemetry rule).

## 1. The event log is the primary instrument

`network.supervisor.events()` — a bounded ring (default 256) of frozen,
machine-readable entries:

| type | fields | read it for |
|---|---|---|
| `decision` | selected, switched, reason, shadow, context{noInternet,batterySaver}, scores[{name,score,disqualified,reason}] | why THIS transport, why NOT that one; prediction penalties carry their trend evidence in `reason` |
| `migration` | from, to, connectMs, requeued, resent, released, failed, durationMs | every switch's cost and completeness; `failed` non-null = degraded switch (backlog stays owed to the drain) |
| `send-failure` | via, error | per-transport send errors feeding loss EWMA |
| `dedup` | via, envelopeId | cross-path duplicates absorbed — proof exactly-once is working, not idle |
| `decide-error` / `start` / `stop` | — | lifecycle + guardrail hits |

Healthy shadow-mode reading: decisions every tick, `switched:false` with
`within dwell window` / `did not clear margin` reasons dominating; zero
`decide-error`.

## 2. Health + stats surfaces

- `network.supervisor.stats()` — current transport, in-flight count, pipeline
  counters (received/duplicates/delivered/buffered), selector state.
- `network.supervisor.monitor.snapshot()` — per transport: smoothed
  quality, health state + reason, prediction, lastError.
- `network.drainer.stats()` — sent/acked/retried/abandoned/deferred, queue
  depths + shed counters, AIMD window, owed count. **Alarm on:** owed
  growing while `acked` is flat (stuck drain), `abandoned` > 0 for
  MESSAGE-class (must be impossible — file a bug), pressure pinned at 1.
- `network.mesh.stats()` — originated/delivered/forwarded/dropped, acks
  sent/received, retransmits, misbehaviour, links, seen size, awaitingAck.
  **Alarm on:** misbehaviour climbing (hostile neighbour), awaitingAck
  growing without exhaustion (tick not running).

## 3. Watch rules (the translation-router discipline applied here)

1. **Flapping:** >2 `migration` events between the same pair within 5 min ⇒
   inspect hysteresis inputs before touching margins; the six-hour stress
   test is the reference for "no, it does not flap on noise."
2. **UNAVAILABLE is a fact, not an incident:** iOS BLE, missing broker URL —
   these are platform truths; only a CHANGE (available→unavailable on a
   platform that had it) is a signal.
3. **Battery:** duty schedule is `network.mesh.dutySchedule()`; `critical`
   (receive-only) on a charging device means the Battery API reading is
   wrong — check `batteryKnown`.
4. **Nothing here pages a human for content** — there is no content.

## 4. Config knobs (all injected, all defaulted, none runtime-flippable)

Selection weights/hysteresis (scaffold `DEFAULT_WEIGHTS`/`DEFAULT_HYSTERESIS`),
monitor cadence + prediction ceilings (`MONITOR_DEFAULTS`), health bars
(`HEALTH_THRESHOLDS`), QoS policy (`QOS_POLICY`), AIMD + backoff
(`CONGESTION_DEFAULTS`, `BACKOFF_CLASSES`), mesh TTL/fanout/duty
(`MESH_ENGINE_DEFAULTS`, `DUTY_CYCLE`), BLE chunk sizing
(`BLE_CHUNK_DEFAULTS`). Tuning is a code change with tests, deliberately.
