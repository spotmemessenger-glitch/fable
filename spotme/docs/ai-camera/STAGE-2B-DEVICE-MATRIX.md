# Camera Stage 2B — Device Validation Matrix (owner runbook)

> Stage 2A built the cockpit; **Stage 2B is yours to run** — real phones,
> real cameras. Nothing here activates anything: the lab is a
> `CAMERA_LAB_ENABLED` local/preview build, absent from every production
> artifact (fence-proven). Its results are what unblock each activation
> wiring.

## 1. How to run the lab

From `spotme/web-next/`:

```bash
npm ci                              # installs the pinned engine devDeps
npm run stage:camera-assets         # stage + digest-verify the model binaries into public/models/
CAMERA_LAB_ENABLED=true npm run build
CAMERA_LAB_ENABLED=true npm run preview   # serves the built app + lab
```

Then on the **phone** (same network, or use the preview host's LAN URL):

- open `http://<preview-host>:4173/lab/camera-lab.html`
- grant camera permission when asked.

> HTTPS note: `getUserMedia` needs a secure context. `localhost` is exempt;
> for a phone on the LAN use the preview over your platform's https preview,
> or a trusted local tunnel you control — **never** expose the lab publicly
> (it is a validation surface, not a product).

The lab never appears in `npm run build` / `npm run preview` **without** the
flag: the HTML entry, the wirings, and the engine packages are simply not
inputs. `npm test` re-proves this every run
(`check:camera-lab-absent` after the flag-false build).

## 2. Device checklist (fill your models)

| # | Device (model / OS / browser) | Owner has? |
|---|---|---|
| 1 | (e.g. Pixel / Android 14 / Chrome) | |
| 2 | (e.g. iPhone / iOS 17 / Safari) | |
| 3 | (older/budget Android for the floor) | |

## 3. Per-capability pass/fail criteria & what it unblocks

| Capability | Lab action | PASS | FAIL is honest if | Unblocks |
|---|---|---|---|---|
| **Still capture** | `still` | frame captured, sane ms | — | composer CameraPort binding |
| **HDR** | `hdr` | fused OR honest `no-exposure-control` on a device without an EV range | device has no EV range | (informational; fusion quality) |
| **Night** | `night` | stacked frame, no ghosting on a static scene | — | (informational) |
| **Burst** | `burst` | N frames within the byte budget | — | (informational) |
| **Video** | `video` | records; honest cap `stoppedBy` | recorder unsupported | (informational) |
| **Beauty tier-0** | sliders + `preview beauty` | natural result at max sliders (caps hold); ms acceptable for preview | — | beauty UI activation |
| **Face landmarks** | `detect faces` | `landmarker registered` + face count; integrity verified | no platform FaceDetector → honest refusal | **MediaPipe registration wiring** |
| **Barcode/QR** | `scan` | decodes a real code; payload shown as **untrusted text, never opened** | nothing in frame → `nothing found` | **jsQR lazy-loader wiring** |
| **OCR (eng/kan)** | `OCR (eng)` / `OCR (kan)` | reads text; empty read is honest `''` | blank frame → empty | **tesseract registration wiring** |
| **Recording indicator** | any capture | the red "Camera is active" banner shows while a track is live | — | (safety gate for activation) |
| **Thermal/battery** | note field | record any heat/drain over a few-minute session | — | (activation risk sign-off) |

## 4. Reporting results back

The lab renders a **copyable markdown block** (attachments don't transfer):
fill the device + thermal fields, run the features, then copy the textarea
and paste it into a session. One block per device. A capability's activation
wiring is unblocked once it PASSES (or honestly refuses for a
device-capability reason) on the owner's device set.

## 5. What stays owner-gated after 2B

Even with green results, **activation itself is a separate owner change**:
importing the lab wirings into a production surface, mounting any capture UI,
and the flag flip. Stage 2A ships none of that — only the validated
building blocks and this runbook.
