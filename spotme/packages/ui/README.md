# web-next — React strangler beachhead (NOT DEPLOYED)

**Status: Implemented (Draft PR — DARK).** This package is inert: it is not
deployed, not referenced by the live `spotme/web` app, outside the Vercel
root, and carries no backend wiring, routing, or authentication. It exists so
the React migration (ADR-027 boundary) can grow behind fences instead of
landing as a big-bang rewrite.

## Architecture (Discovery experience, Platform Phase 2E)

```
React components (pure, prop-driven)          src/discovery/components.tsx
        ▲ props/callbacks only                 src/discovery/MapView.tsx
        │                                      src/discovery/DiscoveryShell.tsx
DiscoveryController (framework-free            src/discovery/controller.ts
state machine; useSyncExternalStore)
        ▲ 5 injected ports
        │
DiscoveryApiPort · GeolocationPort ·           src/discovery/ports.ts
RealtimePort · ClockPort · CachePort           src/discovery/fixtures.ts
(this phase: fixture/disabled adapters only)
```

Rules the tests pin:

- **No fetch in components.** Components render state and raise callbacks;
  only the controller talks to ports; only ports could ever touch a network
  (this phase none do — the API port is a deterministic fixture).
- **Precise location is device-local.** The raw fix exists only inside the
  controller's search scope; `src/discovery/coarsen.ts` is the ONLY
  constructor of the branded `CoarsePublicLocation` (C12 fence) — deterministic
  per-identity jitter + rounding before anything outbound. The privacy
  mutation battery (`test/discovery-privacy-mutation.test.ts`) scans request
  bodies, URLs, logs, cache, realtime events, error objects and final state
  for the raw coordinate substrings.
- **Epoch cancellation.** A superseded search can never overwrite a newer
  one; stale responses drop silently.
- **One disclosed radius expansion** on empty results — never silent.
- **People show distance BANDS only**; no total counts; the filter sheet is
  distance band / category / open-now(places-only) — no age/gender controls
  exist anywhere (A3).
- **Accessibility:** 44 px touch targets, keyboard-activatable map markers,
  visible focus, reduced-motion support, fixed-size skeletons (no layout
  shift), virtualized result list (fixed 132 px rows).

## Commands

```
npm run test:unit   # vitest (jsdom): UI + controller + privacy mutation suites
npm test            # same
npm run build       # vite production build (artifact is NOT deployed anywhere)
npx tsc --noEmit    # strict TypeScript
RUN_DISCOVERY_BENCH=1 npx vitest run test/discovery-perf.test.ts   # perf leg (loud-skip otherwise)
```

Isolation is enforced from the backend side by the C12 fences
(`spotme/backend/test/discovery-dark-fences.spec.ts`): no live `spotme/web`
module references this package, no vercel config points at it, and the only
brand-cast site is `coarsen.ts`.
