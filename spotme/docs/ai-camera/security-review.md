# Camera engine — security review (mission CAM-1, dark library)

Scope: `web/src/lib/camera/**` at the mission's final commit, plus its
tests and the package.json test-chain edit. Method: threat-model walk
(threat-model.md), code read of all 26 files, fence/suite evidence.
**Result: no High/Critical findings; three Notes, all with dispositions.**

## Findings

### N1 — The engine trusts its caller for frame lifetimes (Note)
Subscribers must not use a frame after their callback resolves.
A misbehaving consumer could close() early or retain a dead handle.
**Disposition:** contract documented (developer-guide.md §FrameSource),
close-exactly-once refcounting contains double-close, and retained-handle
misuse fails visibly in the consumer, not the engine. Missions 2–3 code
reviews must check consumer discipline.

### N2 — `stillPath` trusts `ImageCapture.prototype` shape (Note)
A hostile page-level prototype patch could redirect the still path. Any
such attacker already runs script in the page and owns getUserMedia
itself — not an escalation. **Disposition:** accepted; XSS is the app's
existing boundary, camera adds no new privilege.

### N3 — Metrics tags are caller-supplied objects (Note)
`record(name, ms, tags)` stores the last tags object per series; a wiring
bug could put content-derived data there. **Disposition:** engine only
passes enum-like tags (path/strategy names — audited); rule recorded in
ops-guide.md: tags must never carry frame-derived data.

## Verified properties (with the proving evidence)

| Property | Evidence |
|---|---|
| Permission gating: no capture without explicit session start | Only `session.js` calls `getUserMedia` (grep: single choke point); nothing at import time; factory inert while dark — `camera-fence.test.js` throwing-fakes check; `camera-engine.test.js` stub checks |
| Stream release guarantees | `camera-session.test.js`: release stops every track + idempotent; OS-ended track → session released; switch-failure → RELEASED not zombie; `liveTrackCount === 0` assertions; frame source stops on session release (`camera-frames.test.js`) |
| Zero egress | Call-shape fence over fetch/XHR/WebSocket/sendBeacon/RTCPeerConnection/EventSource/io( across all files — `camera-fence.test.js` |
| Zero persistence | Call-shape fence over indexedDB/localStorage/sessionStorage/caches/navigator.storage |
| No crypto implemented or imported | Fence: no `crypto.subtle`, no `/crypto/` imports. ADR-008 §12 untouched |
| Shipped dark, byte-identical app | All flags false + `assertShippedDark`; no outside import; no views mention; dist/ contains none of 4 distinctive identifiers after `npm run build` (fence run post-build: 14/14) |
| Bounded resources | Burst/slow-mo/timelapse byte+count budgets with named truncation (`camera-video.test.js`); frame refcount leak test; metrics rings bounded (`camera-engine.test.js`) |
| Bounded waits | `withTimeout` on getUserMedia/applyConstraints; wedged-driver test (`camera-session.test.js`) |
| Input validation at boundaries | resolveFlags throws on unknown/non-boolean; stage/segmenter/LUT/mask validation with named defects; muxer validates codec/geometry/frames |
| No new dependencies / no AGPL | Fence pins the exact pre-mission dependency list; module imports only relative paths |

## Suite evidence

`npm test` — 59 suites green (37 pre-existing + 11 camera + existing e2e
chain unchanged), exit 0. `npx eslint .` clean. `npm run build` green;
post-build fence 14/14. Camera assertions: 202 (203 with the post-build
bundle check) across
flags/capabilities/session/frames/pipeline/algorithms/portrait/video/
stabilize/engine/fence.

## Review checklist for the FUTURE wiring PR (blocking)

1. Engine outputs must enter the EXISTING media path (`lib/media.js`
   sizing/caps, `store.js` view-once/disappearing semantics) — no parallel
   send path.
2. UI must show live capture state; stop must call `session.release()` on
   every exit path including navigation.
3. No capability map, metric, or frame derivative sent to the server.
4. Flag flips in the documented order (activation-guide.md) only.
5. Re-run this review against the wiring diff; this document covers the
   dark library only.
