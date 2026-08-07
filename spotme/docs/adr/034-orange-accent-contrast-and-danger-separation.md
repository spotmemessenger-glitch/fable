# ADR-034 — Orange accent: text-on-fill, and danger separated from the accent

**Status:** Accepted (owner decision, 2026-08-06)
**Supersedes nothing.** Constrains the orange accent migration begun in #132.

## Context

The accent moves from teal to orange (Helo family), primary `#FF6A00`. Two
rules proposed alongside it were tested against real measurement rather than
adopted on sight. Both failed. This ADR records the numbers so neither is
proposed again.

Measurements are WCAG 2.x relative luminance for contrast, and a Brettel-style
dichromat simulation in linear RGB for colour-vision deficiency, comparing RGB
distance between the two simulated colours (≥40 taken as distinguishable).

## Decision 1 — text on an orange fill is NEAR-BLACK at 500, not white

The proposal was "white for 500+, near-black for 300 and below". White on the
primary fill fails AA outright:

| fill | white text | near-black `#0F0F10` |
|---|---|---|
| 400 `#FF8533` | 2.43:1 ✗ | 7.90:1 ✓ |
| **500 `#FF6A00`** | **2.87:1 ✗** | **6.67:1 ✓** |
| 600 `#E05C00` | 3.68:1 (large only) | 5.20:1 ✓ |
| 700 `#B84B00` | 5.19:1 ✓ | 3.69:1 |

Orange at usable saturation is simply too light to carry white text. The
primary button therefore takes **near-black text on the 500 fill** (6.67:1).
White becomes correct only at 700, which is brown rather than the brand orange.

Corollary, unchanged from the proposal and confirmed: **orange TEXT on white
needs 700 minimum** — 700 = 5.19:1 ✓, 600 = 3.68:1 ✗ for body.

## Decision 2 — danger is `#B3261E`, not `#E5484D`

Danger must not read as the accent. Only 27° of hue separates `#E5484D` from
`#FF6A00`, and red-green CVD collapses both toward the same blue-violet:

| candidate | hue | protanopia | deuteranopia | on white |
|---|---|---|---|---|
| `#E5484D` (proposed) | 358° | **38** | **37** | 3.91:1 |
| `#E5342B` (previous `--red`) | 3° | 49 | 42 | 4.32:1 |
| `#C2185B` | 336° | 82 | 79 | 5.87:1 |
| **`#B3261E` (chosen)** | **3°** | **86** | **89** | **6.54:1** |
| `#A4133C` | 343° | 103 | 106 | 7.67:1 |

The instructive result: `#B3261E` shares its hue (3°) with the colour it
replaces and still passes, because it is 21% darker. **Lightness, not hue, is
the lever that separates danger from an orange accent.** A red chosen only for
being "more red" does not survive simulation.

`#B3261E` also clears AA for body text on white (6.54:1), which `#E5484D`
does not (3.91:1).

## Consequence — colour alone is never the signal

Even at 86/89 separation, danger carries an icon and a label, never colour
alone (WCAG 1.4.1). The measurement above buys margin; it does not buy
permission to encode destructive intent in hue.

## Decision 3 — chat converts, but outgoing bubbles are TINTED, not 500

The chat teals (`--out`, `--outink`, `--teal-deep`) were matched to owner
reference screenshots rather than chosen as brand colour. They convert: a teal
chat inside an orange app reads unfinished.

They do **not** take accent 500. A screen of saturated orange bubbles is
exhausting to read — a bubble is the one surface a person stares at for
minutes at a time, unlike a button they glance at and press.

- outgoing bubble, light: **100/200** with near-black text
- outgoing bubble, dark: **800** with white text
- accent **500** stays for buttons, active tabs and controls

The measurements above already cover this: near-black on 200 and lighter sits
comfortably above AA, and white on 800 is 7.57:1 — against white-on-500's
failing 2.87:1. Tinting is the safe direction at both ends of the ramp.

## Decision 4 — dark mode ships AFTER the orange palette, not with it

Full scope: a real `[data-theme="dark"]` token set honouring the system
setting. Sequenced strictly after the orange migration lands.

The reason is attribution, not effort. `tokens.css` currently pins one light
palette across `:root`, `[data-theme="dark"]` and `[data-theme="light"]`
deliberately, so dark mode is a build rather than a re-token. Moving hue and
theme in the same change means a regression cannot be attributed to either.

## Notes for the migration

- `--blue` (`#1b8a9d`) is documented as BOTH the brand accent and the state
  colour for "unread, active tab, distance, links". Routing it wholesale to
  orange makes link text orange, which at 500 fails AA — link text must take
  700 or keep a separate token.
- `--amber` (`#d97757`) is a muted orange that will collide with the new
  accent family and needs re-picking.
