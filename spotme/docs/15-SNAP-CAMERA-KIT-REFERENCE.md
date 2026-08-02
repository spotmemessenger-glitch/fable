# Snap Camera Kit — Reference Record

**Status: REFERENCE ONLY — NOT AN AUTHORIZED INTEGRATION.**
**Written:** 2026-08-02. **Measured in:** the remote session container for
branch `claude/snap-camera-kit-repos-65c88r` (PR #53).

Camera Kit appears **nowhere** in the controlling roadmap
(`MASTER-ENGINEERING-ROADMAP-V2.md`): not in §7's third-party integration
table, and not in the owner's 2026-08-01 execution order (push → translation →
live voice translation → adaptive transport → remaining Priority 1 crypto).
Nothing in this file is approved work. It exists so that if Spot Me ever wants
AR camera capability, the evaluation does not start from zero.

**Do not treat any line here as a live check.** Every claim below is tagged
MEASURED (executed in this container, on the date above) or UNVERIFIED (read
from a manifest, never run). Versions move; re-measure before relying on them.

---

## 1. The repositories

All five exist and were reachable on 2026-08-02. `403` responses from a plain
`curl` in this container come from the agent proxy, not from GitHub — do not
read them as "repo missing".

| # | Repository | What it actually is | Consumed via |
|---|---|---|---|
| 1 | [`Snapchat/react-camera-kit`](https://github.com/Snapchat/react-camera-kit) | Official React bindings for the web SDK | npm |
| 2 | [`Snapchat/camera-kit-ios-sdk`](https://github.com/Snapchat/camera-kit-ios-sdk) | Native iOS SDK | Swift Package Manager |
| 3 | [`Snapchat/camera-kit-android-sdk`](https://github.com/Snapchat/camera-kit-android-sdk) | Native Android SDK (repo holds only samples + changelog; the SDK is a Maven artifact) | Maven Central |
| 4 | [`Snapchat/camera-kit-reference`](https://github.com/Snapchat/camera-kit-reference) | Docs + sample apps. **1.3 GB at `--depth 1`** (MEASURED) | clone only — nothing installable |
| 5 | [`Snapchat/Lens-Studio-Plugins`](https://github.com/Snapchat/Lens-Studio-Plugins) | Plugins for the Lens Studio 5 **desktop app** | copied into a Lens Studio install |

### Also relevant, and not in the original list

[`Snapchat/camera-kit-react-native`](https://github.com/Snapchat/camera-kit-react-native)
— the Camera Kit wrapper for React Native. **This, not #1, is the repo that
matches `spotme/app`** (Expo 57 / RN 0.86 / React 19.2.3). #1 is web-React
bindings and cannot drive a native RN camera. If Spot Me ever pursues AR on
mobile, start here. UNVERIFIED — not installed or run.

Also exist: `camera-kit-flutter-sample`, `camera-kit-unity-sample` — not
relevant to this stack.

---

## 2. Where each one can and cannot go in this repo

The repo has three JS hosts and one Android project:

| Target | Stack | Camera Kit fit |
|---|---|---|
| `ysnap` | Next 15, React 19.1.0 | **Only** valid host for the web React bindings |
| `spotme/web` | Vite + vanilla JS + Capacitor. **Zero React deps** | React bindings cannot run here. Plain `@snap/camera-kit` could, in principle |
| `spotme/app` | Expo 57 / RN 0.86 | Needs `camera-kit-react-native`, not #1 |
| `spotme/web/android` | Capacitor Android | Only possible Android target |
| — | no iOS project exists anywhere | no SPM consumer |

---

## 3. Web — INSTALLED (in `ysnap` only)

MEASURED. Landed on branch `claude/snap-camera-kit-repos-65c88r` (PR #53):

```
@snap/react-camera-kit  ^0.5.1
@snap/camera-kit        ^1.19.0
rxjs                    ^7.8.2
```

`@snap/react-camera-kit@0.5.1` declares peers `@snap/camera-kit ^1.13.0`,
`react >=16.8.0`, `react-dom >=16.8.0`, `rxjs >=7` — all four satisfied.

Verified: `npm run build` in `ysnap` completed clean, all routes rendered, no
new warnings; the Vercel preview deployment reported **Ready**. No existing
dependency changed version.

It is **inert** — nothing imports it. Rendering a lens additionally needs an
API token and Lens Group ID (§6).

Transitive deps added to the lockfile: `browser-fs-access`, `browser-headers`,
`google-protobuf`, `uuid`, `wasm-feature-detect`, `rxjs`. See §7 — the
protobuf/gRPC-web pair is there because the SDK talks to Snap's backend.

---

## 4. Android — RESOLVABLE, NOT WIRED IN

Version **1.50.0**. Published on **Maven Central** — no credentials needed to
*fetch* the artifacts. The API token is a runtime value, not a repo credential.

MEASURED — these downloaded successfully from Maven Central in this container:

| Artifact | Size |
|---|---|
| `com.snap.camerakit:camerakit:1.50.0` (aar) | **47.4 MB** |
| `com.snap.camerakit:camerakit-kotlin:1.50.0` | <0.1 MB |
| `com.snap.camerakit:support-camera-layout:1.50.0` | 0.1 MB |
| `com.snap.camerakit:lenses-bundle:1.50.0` | 0.2 MB |

Other coordinates seen in the samples (UNVERIFIED): `camerakit-api`,
`support-camera-activity`, `support-snap-button`, `support-permissions`,
`support-camerax`, `support-snap-attribution`, `support-media-picker-source`,
`support-media-recording`.

Sample `gradle.properties` keys:

```properties
com.snap.camerakit.api.token=REPLACE-THIS-WITH-YOUR-OWN-APP-SPECIFIC-VALUE
com.snap.camerakit.lenses.group.id=REPLACE-THIS-WITH-YOUR-OWN-APP-SPECIFIC-VALUE
com.snap.camerakit.lenses.group.id.arcore=REPLACE-THIS-WITH-YOUR-OWN-APP-SPECIFIC-VALUE
```

### Two traps before anyone tries this

1. **`dl.google.com` is blocked by the agent proxy in remote sessions.**
   Camera Kit's transitive AndroidX deps (`androidx.core`, `appcompat`,
   `camera-*`, `exoplayer`) all 403. A full Android resolve **cannot be
   verified in a remote container** — only `transitive = false` resolution
   succeeds. MEASURED.
2. **47.4 MB of APK for the main AAR alone**, before AndroidX and ExoPlayer.
   Material for a messenger that ships over Capacitor.

Deliberately not added to `spotme/web/android`: off-roadmap, unverifiable
here, and a bare Gradle dependency does nothing for a Capacitor app without a
JS bridge.

---

## 5. iOS and Lens Studio — CANNOT BE INSTALLED HERE

**iOS SDK** (v1.50.0, UNVERIFIED — read from `Package.swift`): SwiftPM,
`swift-tools-version:5.4`, iOS 13+. Products `SCSDKCameraKit`,
`SCSDKCameraKitLoginKitAuth`, `SCSDKCameraKitPushToDeviceExtension`,
`SCSDKCameraKitReferenceUI`, `SCSDKCameraKitReferenceSwiftUI`. These are
`binaryTarget` xcframeworks fetched from
`storage.googleapis.com/snap-kit-build/scsdk/camera-kit-ios/releases-spm/1.50.0/`,
plus a dependency on `Snapchat/snap-kit-spm >= 2.5.0`.

Blocked twice over: no Swift toolchain in this Linux container, and **no iOS
project exists anywhere in the repo** — no `Podfile`, no `.xcodeproj`. One
would have to come from `expo run:ios` on macOS first.

**Lens Studio Plugins**: plugins are `module.json` + `main.js` pairs under
`Builtin/` and `Public/`, loaded by the Lens Studio 5 desktop app
(macOS/Windows only). They are authoring-time tooling for building lenses —
they never ship inside an application, so they are not a Spot Me dependency in
any sense.

`MCP/claude-desktop-extension` in that repo is an MCP server for Lens Studio
(`@modelcontextprotocol/sdk ^1.28.0`), requiring **Lens Studio 5.15+ running
locally**. Of interest only to whoever authors lenses, on their own machine.

---

## 6. Credentials, if this is ever pursued

Camera Kit is **not** a self-serve SDK. It needs an approved app in the Snap
developer portal, which issues an API token and a Lens Group ID, and the lenses
themselves must be built in Lens Studio and published to that group. There is
no local-only mode. Under roadmap §7 these are least-privilege secrets and must
live in an approved secret store — never in `gradle.properties`, `.env`, or any
committed file.

---

## 7. Why this needs a security review before it goes near Spot Me

Recorded so the question is not skipped later:

- **It is a live network dependency.** The web SDK pulls `google-protobuf` and
  `browser-headers` because it speaks gRPC-web to Snap's backend. Lenses are
  fetched remotely and the SDK reports telemetry. A camera feed in an
  E2E-encrypted messenger is exactly the surface where that matters.
- **Roadmap §2.8 and §7 apply**: any provider needs an adapter/service
  boundary, documented timeouts, retries, quotas, cost, regional availability
  and data retention, least-privilege credentials, and graceful degradation.
  None of that exists for Camera Kit today.
- **Roadmap §2.7**: security-sensitive state must never be logged, sent to
  analytics, or shipped to a server. The data-retention terms for camera frames
  and telemetry have **not** been read.
- **APK/bundle weight** (§4) against a product that has not yet shipped push,
  translation, or the remaining Priority 1 crypto.

Verdict for now: Camera Kit is a **candidate for evaluation**, gated behind
owner authorization and a §7 integration review. It is not scheduled.

---

## 8. Reproducing the measurements

```bash
# repos exist (curl 403s here are the proxy, not GitHub)
#   use the GitHub API instead of curl in remote sessions

# web (already done, in ysnap)
cd ysnap && npm install @snap/camera-kit @snap/react-camera-kit rxjs && npm run build

# android: proves the AARs fetch. transitive=false is REQUIRED in a remote
# container, because dl.google.com is proxy-blocked (§4 trap 1).
#   repositories { mavenCentral() }
#   configurations { probe { transitive = false } }
#   dependencies { probe "com.snap.camerakit:camerakit:1.50.0" }
```

Java and Gradle are present in the container; `swift` is not.
