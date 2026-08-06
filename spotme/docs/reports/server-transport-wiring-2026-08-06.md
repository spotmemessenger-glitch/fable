# Server transport wiring — 2026-08-06 (afternoon session)

Owner directive: wire Centrifugo, LiveKit and Metered TURN into Spot Me;
the migration off peer-to-peer is total — server-side transport only,
then complete the phases one by one.

## What landed

### ADR-033 + P2P removal (PR #125, `chore/server-only-transport-migration`)
- ADR-033 records the decision: the Trystero P2P path is REMOVED, not frozen.
  Supersedes ADR-002's retention clause.
- `TRANSPORT_KEYS` loses `p2p`; `setTransport('p2p')` throws; a legacy stored
  flag falls back to `socketio`. Both trystero packages out of `package.json`.
- `transport.test.js` now pins the ABSENCE (24/24): p2p unselectable + a
  source scan that fails if any src file imports trystero again.
- Backend unchanged — its only P2P references are historical wire-shape notes.
- **Merge AFTER #124** (that branch still carries master-era transport files).

### PR #124 (calls) unconflicted and at master parity
- `master` merged into `feature/calls-livekit-only` (`f200623`, lint fix
  `d61e4c9`). GitHub: CONFLICTING → **MERGEABLE**.
- Conflict intents honoured: call-media deletion stands (no `rtc` type, no
  stream surface in socket-transport, `remotes` Map); master's newer messaging
  work stands (clearRoomCursor, onUndecryptable, replay refactor, DM peerId
  gate, freeze checks, A5); the 5 s bounded Centrifuge connect survives; chat
  copy keeps the ADR-004 "Messages are encrypted" qualifier.
- One real merge bug caught by CI lint and fixed: `removePeer` still called
  `closePc()`, whose definition the call-path deletion removed.
- CI now: web ✓, e2e ✓, compose ✓, secret-scan ✓. Backend fails ONLY on
  `moment-media-iphone.spec.ts` — the identical pre-existing heif-convert
  failure master's own CI has (verified against master run 31078537896).
  `queue.e2e` failed once and passed on re-run — flaky, not the merge.

### Railway — variables actually correct now (read back, not assumed)
- `api`: `LIVEKIT_URL` now exists as itself (it was nested inside a var
  literally named `LIVEKIT_ENVIRONMENT_VARIABLE`); `METERED_TURN_SUBDOMAIN`
  and `METERED_TURN_API_KEY` added under the names the calls-branch
  `turn.js` actually reads; 6 malformed vars deleted (two LIVE_KIT typo
  duplicates, one nested-URL var, three "METERED_*" vars whose values were
  pasted sample code from Metered's docs).
- Left in place deliberately: the lowercase orphans (`livekit`, `metered`,
  `redis`, `typesense`, `google r2`, `s3_bucket`) — they hold unique secret
  values the owner parked; deleting them is an owner call.

### Centrifugo — DEPLOYED and PROVEN (the messaging plane's broker exists now)
- New Railway service `centrifugo` (image `centrifugo/centrifugo:v5`,
  running v5.4.9) in `spotme-backend/production`. Config via env: API key,
  token HMAC secret (generated fresh, never in chat), allowed origins for
  both Vercel hosts + capacitor + localhost, `room` namespace with presence,
  user-limited channels on, client publish off.
- Public domain `centrifugo-production-4d55.up.railway.app` (websocket, port
  8000); `/health` answers 200.
- `api` got `CENTRIFUGO_API_URL` (private network), `CENTRIFUGO_API_KEY`,
  `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`, and was redeployed (SUCCESS, healthy).
- **Proven end-to-end against production**: guest signup (the 18+ gate
  correctly demanded `birthYearMonth` first) → `POST /api/v2/realtime/token`
  returns a token (this endpoint 503'd by design before today) → the broker
  ACCEPTED that token over a real websocket connect.

### TURN — proven live
- `GET /api/turn` on production mints real Cloudflare TURN credentials
  (`relay: true`, credentialed `turn:` entry). Metered-first ordering arrives
  with #124's `turn.js`; its env vars are already in place.

### App regression after the api redeploy — driven, not assumed
- Real browser at mobile viewport against `spotme-web-v2.vercel.app`:
  onboarding completed, server tokens issued, main surface (Chats/Nearby/
  Discovery) rendered, zero console errors except the two BY-DESIGN Moments
  404s for a non-allowlisted account.

## What is NOT claimed
- Chat does not ride Centrifugo yet and cannot until the Phase-3 seal/open
  refactor moves crypto above the adapter (`transport/room.js` documents why;
  it still falls back loudly). The broker being live removes the
  infrastructure blocker, nothing more.
- No LiveKit call has been driven in a browser — the code is in #124,
  unmerged, and the flag defaults OFF.
- No call on a real mobile network; Metered relay unexercised by a real call.
- The api→broker private-network publish path is configured but unproven
  (proving it needs a room member publishing, i.e. the browser e2e after
  activation).

## Next steps (in order)
1. Owner reviews + merges #124 (calls, dark), then #125 (P2P removal).
2. After both land: browser-drive a real 1:1 LiveKit call (flag on for a
   test device), verify TURN relay engages on a hostile network.
3. Phase 3: move seal/open above the transport adapter so chat can ride
   Centrifugo; then flip `spotme.transport=centrifugo` for a test device and
   drive two peers.
4. Owner allowlist row (unchanged blocker: private-network DB, no SSH key).
