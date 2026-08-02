# Camera engine — operations guide

The engine is a client library with no server component, no credentials,
no scheduled jobs and no telemetry pipeline. "Operations" therefore means:
what to watch in CI while dark, and what to watch on devices once lit.

## While dark (now)

| Signal | Where | Healthy | Action when not |
|---|---|---|---|
| Fence suite | `npm test` → camera-fence | 14/14 (13 without dist/) | An import/flag/egress/persistence breach names the file — treat as a broken build, revert the breaching commit |
| Camera suites | `npm test` (11 suites, 222 asserts) | all green | Standard fix-forward; suites are deterministic (seeded), so a flake IS a bug |
| Bundle fence | `npm run build` then camera-fence | TREE-SHAKEN OUT pass | Something made the module reachable from an entry point; find the import, revert |
| Bench drift | `node test/bench/camera.bench.mjs` (manual, on perf work) | within ~2× of benchmark-report.md medians | Update the report WITH environment, or investigate the regression |

## Once lit (per wiring PR)

The engine's only runtime surface is `engine.metrics()` — an in-memory
snapshot the wiring UI can show on a debug screen. NOTHING here transmits;
if product later wants aggregated metrics, that is a new reviewed egress
decision (Priority 9 observability), not a default.

Series worth a debug panel, with expected shapes:

| Series | Meaning | Watch for |
|---|---|---|
| `session.open` | getUserMedia → live (cold) | p50 creep (driver issues); timeouts appear as FAILED opens in UI, not here |
| `session.switch` | tagged warm/cold | cold ratio rising = devices refusing dual-open more than expected |
| `frames.firstFrame` | pump start → first frame | the perceived startup number; compare against matrix baselines |
| `still.capture` | per path (takePhoto/grabFrame/canvas-draw) | path distribution per platform matching camera-engine.md's table |
| `video.record` | duration, stoppedBy tags | maxBytes/maxDuration stops dominating = caps mis-tuned |
| `timelapse.capture` | frames, elapsed | truncatedBy=budgetBytes often = budget too small for chosen interval |
| counters `frames.dropped` | backpressure pressure | sustained growth = a consumer (mission-2 model?) too slow for its fps ask |

Rules for anyone adding `metrics.record` calls:
1. Durations and counts only — NEVER frame-derived data, dimensions of a
   user's face, or anything content-correlated.
2. Tags are closed enums (path/strategy names), per security-review N3.

## Incident quick cards

- **"Camera light stayed on" report:** the engine guarantees track stop on
  `release()`; hunt the wiring exit path that skipped release. Evidence
  to collect: whether `session.state()` was RELEASED. The library-side
  guarantee is test-pinned; the bug will be in wiring.
- **Feature works on device A, "missing" on device B:** expected — read
  the availability envelope's `reason` (the UI should surface it). Verify
  against MediaTrackCapabilities on the device before filing an engine
  bug: NOT_IN_TRACK_CAPABILITIES is the device speaking, not a defect.
- **Runaway memory during burst/slow-mo:** budgets should have truncated
  (RESOURCE_LIMIT). If not, check that the wiring passes budgets through
  and RELEASES bursts (`releaseBurst`) — bitmaps are caller-owned.
- **Kill switch:** flip the narrowest governing flag
  (activation-guide.md); the platform master darkens everything at once.
