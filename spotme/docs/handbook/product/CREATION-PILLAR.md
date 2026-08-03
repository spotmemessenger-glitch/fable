# Creation Pillar (Product Authority)

> Owner directive, 2026-08-03: **Camera is not removed from the product.** It is
> a flagship pillar whose output later feeds Discovery via **Nearby Moments**.
> Build state is authoritative in
> [../03-IMPLEMENTATION-STATUS](../03-IMPLEMENTATION-STATUS.md); this page records
> the product framing and a status summary.

## What the Creation pillar is

Creation is the **content engine** of the product loop
(Create → Discover → Communicate). Its surfaces:

| Surface | Product scope | Source |
|---|---|---|
| **AI Camera** | Fast pro capture, HDR/night/burst, honest capability matrix | scope §4.1 |
| **Beauty & AR** | Natural beauty (user-controlled, disable-able), gesture-reactive AR | scope §4.2/§4.3 |
| **AI Vision** | OCR/translate/identify/VQA with safety boundaries; non-diagnostic health | scope §5 |
| **Creative Studio** | Non-destructive photo editor; video/stories/reels timeline | scope §6 |
| **Photos** | Capture/edit/organize | `web/src/lib/photos.js`, `photoedit.js` |
| **Videos** | Video capture/edit | scope §6.2 |
| **Stories / Reels** | Short-form formats; feed into Nearby Moments | scope §6.2/§8 |

Creation's output **feeds Discovery**: photos, videos, stories and reels become
the content of **Nearby Moments** (Discovery step 3), always with approximate/
coarse location and never a poster's precise live location.

## Implementation status (summary)

Status vocabulary for this pillar (owner's terms), mapped to the six-state model:

| Term | Meaning | Six-state equivalent |
|---|---|---|
| **Built** | On `master`, running | Implemented (Merged) |
| **Draft PRs** | Built dark on a branch, open PR | Implemented (Draft PR) |
| **Built-off** | Built, but on a **frozen** branch — not to be advanced without authorisation | Implemented (Draft PR), **frozen** |
| **Not active** | Not built / not wired | Planned |

| Surface | State | Evidence |
|---|---|---|
| Photos / basic photo edit | **Built** | `web/src/lib/photos.js`, `photoedit.js`, `crop.js` (master) |
| Camera Engine (CAM-1) | **Draft PR / Built-off** (frozen) | PR #56 `c7c8020` |
| AI Vision (CAM-2) | **Draft PR / Built-off** (frozen) | PR #58 `44da9ff` |
| AR & Beauty (CAM-3) | **Draft PR / Built-off** (frozen) | PR #59 `97aebee` |
| Creative Studio (CAM-4) | **Draft PR / Built-off** (frozen) | PR #55 `d7ef3fa` |
| Stories / Reels | **Not active** | Planned; no module/ADR |

**Frozen:** the Camera branches (#55/#56/#58/#59) are frozen per owner directive
([../09-OWNER-DECISIONS](../09-OWNER-DECISIONS.md)) — no merge, rebase, further
pushes, wiring, or flag activation without explicit authorisation. They are
recorded here so the pillar is **not** mistaken for removed; they are **not**
scheduled for activation ahead of the Discovery execution order.

## Sequencing note

The current active programme is **AI Discovery & Social Platform**
([DISCOVERY-PROGRAMME](DISCOVERY-PROGRAMME.md)). The Creation pillar's frozen
foundations remain in place but are not advanced until the owner authorises;
their product purpose (feeding Nearby Moments) is why they are preserved rather
than removed.
