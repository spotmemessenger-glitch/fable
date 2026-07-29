---
name: omniparser-eyes
description: Give a GUI agent vision-based element grounding with Microsoft OmniParser — turning a raw screenshot into labelled, clickable UI elements when the accessibility tree is empty or lying. Use when automating apps that expose no UIA elements (Electron, Java, games, canvas, remote desktop), when deploying or calling an OmniParser server, or when deciding between tree-based and vision-based perception.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash, WebFetch]
---

# OmniParser as the agent's eyes

[microsoft/OmniParser](https://github.com/microsoft/OmniParser) converts a
screenshot into a structured list of interactive elements — bounding boxes plus
captions — so a model can pick a target by *identity* instead of guessing pixel
coordinates. It is the fallback for surfaces the accessibility tree cannot see.

## When it earns its cost

OmniParser is not free: a GPU inference pass plus a round trip, an order of
magnitude slower than a UIA enumeration. Use the cheapest source that answers
the question:

| Surface | Use |
|---|---|
| Native Win32/WinForms/WPF | UIA tree (`ui_inspect`) — exact, ~336 tokens, no GPU |
| Electron, Java/Swing, Qt, Unity, games | **OmniParser** — tree is empty or useless |
| Canvas, charts, PDFs, video, image editors | **OmniParser** or raw pixels |
| Remote desktop / VM / screen share | **OmniParser** — no tree exists across the wire |
| Browser | Neither — drive the DOM (see `browser-automation`) |

The decision rule: if `ui_inspect` returns elements that cover the target, use
them. OmniParser is what you fall back to, not what you start with.

## Deployment

Three options, in order of practicality:

1. **Self-hosted REST** — [addy999/omniparser-api](https://github.com/addy999/omniparser-api)
   wraps the model in an HTTP service. Simplest integration: POST a PNG, get
   boxes and captions back. Point an `OMNIPARSER_URL` at it.
2. **Local** — clone microsoft/OmniParser, run the weights directly. Needs a
   CUDA GPU; on CPU it is too slow for an interactive loop.
3. **Remote GPU box** — run the server on a GPU host, call it over the network.
   Latency is dominated by inference, not transport, so this is usually fine
   and keeps the agent machine light.

[OpenAdaptAI/OmniMCP](https://github.com/OpenAdaptAI/OmniMCP) wires OmniParser
into MCP. Treat it as a reference implementation rather than a dependency — it
is an agent framework with its own perceive-plan-act loop, which will fight an
existing operator loop rather than slot into it.

## Integration shape

Keep it behind the same interface as the accessibility tree. In ybot terms,
OmniParser should return the same shape `uia.py` returns — a list of refs with
labels and native-pixel centres — so the operator loop, `guard`, and the verify
loop work unchanged and the model uses one vocabulary for targets.

```
inspect(window) -> [Element(ref, label, control_type, center_xy)]
   ├── UIA backend      (default, cheap, exact)
   └── OmniParser backend (fallback, vision, captioned)
```

Two things to get right at the boundary:

- **Coordinate space.** OmniParser returns boxes in the space of the image you
  sent it — usually the *downscaled* frame. Scale centres back to native pixels
  before clicking, exactly as `actions.execute` does for model coordinates.
- **Element identity across frames.** Boxes are re-detected per screenshot and
  refs are not stable. Re-inspect after every action rather than caching refs;
  a stale ref is worse than no ref because it clicks confidently at the wrong
  place.

## Captions are guesses

OmniParser labels are model output, not ground truth — "Submit" may be a
lookalike, an ad, or a disabled control. Vision-grounded clicks therefore need
the verification loop *more* than tree-based ones, not less. Confirm the effect
after every OmniParser-sourced click (see `action-verify-loop`), and prefer the
tree whenever both are available.

## Anti-patterns

- Running OmniParser on every step when UIA already answers — pure latency.
- Caching element refs across frames.
- Trusting a caption to mean the control is enabled or safe.
- Sending a full-resolution screenshot when a downscaled one detects the same
  elements — inference cost scales with pixels.
- Bypassing `guard.evaluate()` because the target came from vision rather than
  the tree. The policy layer is about *what is clicked*, not how it was found.
