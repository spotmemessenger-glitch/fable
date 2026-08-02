# AI Camera platform — threat model (mission CAM-1 scope)

The camera is the most privacy-sensitive sensor the app will ever touch: it
sees faces, rooms, documents, other people who never consented to an app at
all. This model covers the ENGINE (dark library). Each wiring PR and each
later mission must revisit it — a threat model of unwired code is
necessary but never sufficient.

## Assets

1. Live camera frames (preview, stills, video, bursts, masks).
2. The permission grant itself (once granted, silent reuse is possible
   within the page session — the OS indicator is the user's only signal).
3. Derived data: metrics timings, capability fingerprints.
4. User trust that the camera light means what it says.

## Trust boundaries

- **Device ↔ page:** getUserMedia permission. The engine never requests it
  while dark (factory inert, fence-proven); when lit, ONLY
  `openSession`/`startScanning`-style explicit calls prompt.
- **Engine ↔ app:** the factory + flag chain. No app import exists while
  dark (fence).
- **Engine ↔ network: NONE.** Zero egress is a structural property
  (call-shape fence over every file), not a policy. There is no plaintext
  boundary to govern because there is no provider path at all in this
  module; any future model egress is mission 2's explicitly-flagged,
  owner-approved boundary (D1-style: default OFF).
- **Engine ↔ storage: NONE.** No IndexedDB/localStorage (fence). Frames
  and settings die with the session.

## Threats and dispositions

| # | Threat | Disposition |
|---|---|---|
| T1 | Camera opened without user intent (dark code path, ad-hoc probe) | Factory inert while dark (throwing-fake proof); nothing at import time in any module; only `openSession` calls getUserMedia — grep-auditable single choke point |
| T2 | Camera stays on after the UI is done ("light stays on") | `release()` stops every track, idempotent; OS-ended tracks release the session; frame source stops with the session; leak assertions in tests (`liveTrackCount === 0`) |
| T3 | Frames exfiltrated over the network | Structurally impossible in-module (zero-egress fence: no fetch/XHR/WS/beacon/RTC/EventSource call shapes); wiring PRs must keep engine outputs inside the reviewed media path |
| T4 | Frames persisted covertly (survive disappearing/view-once expectations) | Zero-persistence fence; blobs are in-memory and caller-owned; when wiring attaches captures to chats, view-once/disappearing semantics of `store.js` apply UNCHANGED because the engine hands over ordinary blobs and keeps nothing — restate in the wiring PR's review |
| T5 | GPU/heap exhaustion as DoS (burst/slow-mo buffers, frame leaks) | Hard byte budgets with RESOURCE_LIMIT truncation; refcounted close-exactly-once frame ownership (leak-tested); bounded metrics rings |
| T6 | Fingerprinting via capability probes | `probeBrowser` reads only standard API presence; `probeTrack` requires an OPEN session (already permission-gated). No probe results leave the device (T3). Wiring must not ship capability maps to the server |
| T7 | Hallucinated features eroding trust (fake HDR/night/slow-mo) | The honesty pattern is enforced by tests: unavailable-with-reason everywhere, no interpolation, no fake segmenter, still path labeled |
| T8 | Supply chain | Zero new dependencies (fence pins the exact dependency list); no AGPL anywhere; future deps are owner decisions in ADRs |
| T9 | Flag drift lighting the platform accidentally | `assertShippedDark` + fence in every `npm test`; unknown flag names throw; effective flags require the whole ancestor chain |
| T10 | Timer/resource activity while dark (battery, wake) | Inert factory arms zero timers (throwing-clock proof) |
| T11 | A registered segmenter (future ML engine) leaking frames | ISegmenter is called with frames but lives OUTSIDE this module; 014b/c must threat-model each engine before registration is wired; the registry refuses malformed engines and survives throwing ones |
| T12 | Metrics as a side channel | Snapshot object only, no transport, bounded rings; nothing identifies content (durations and counts only) |

## Residual risks (accepted, stated)

- The engine cannot control the OS camera-indicator UX; it can only
  guarantee tracks are stopped (T2). On platforms with sticky indicators,
  user perception lags by design of the OS.
- GL pipeline equivalence with CPU reference is device-verified, not
  CI-verified (no GPU in CI) — manual matrix item.
- A wiring PR could violate T3/T4 outside this module; the fence catches
  imports, and the activation guide makes the media-path rule an explicit
  review item for that PR.
