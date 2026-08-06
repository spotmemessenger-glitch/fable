# Spot Me — UI/UX Design System

**Status: LOCKED (2026-07-24). Do not re-litigate.**
Additions must *extend* this system; nothing here may be replaced or restyled without an explicit owner decision. The lock is recorded in the source itself — the header comment of `spotme/web/src/tokens.css` reads: *"Spot Me — locked design system (2026-07-24). Do not re-litigate."*

This document is the written form of what already ships. The source of truth is the CSS, in this order:

| File | Owns |
|---|---|
| `spotme/web/src/tokens.css` | Tokens, app shell, bottom bar, avatars, pills, toasts, action sheets, onboarding, crop modal, privacy blur, pull-to-refresh |
| `spotme/web/src/views/chat.css` | Thread, bubbles, split-bubble translation, media bubbles, voice waveform, reactions |
| `spotme/web/src/views/inbox.css` | Header, search, tabs, chat rows, swipe actions, new-chat sheet |
| `spotme/web/src/views/discovery.css`, `bluetooth.css`, `contacts.css`, `groups.css`, `stories.css`, `profile.css`, `notifications.css` | Per-view styles built from the same tokens |

Locked reference HTML lives in `spotme/design/` (e.g. `01-messages.html`, `03-chat.html`); the view CSS files were lifted from those designs and note it in their headers.

Phase tags: **P1** = current web app (shipped, locked). **P2** = React Native port of the same system. **P3** = scale-era additions (theming for new surfaces, design-token pipeline). Nothing in P2/P3 changes P1.

---

## 1. Color roles (P1)

Color is **semantic, not decorative**. Every color has exactly one job, stated in the `tokens.css` header:

| Role | Token | Value | Job |
|---|---|---|---|
| **Ink** | `--ink` | `#0f0f10` | **Commit actions.** Search, Accept, Send, Choose — anything that *does* something is a solid black fill. Never blue. |
| **Blue (teal)** | `--blue` | `#1b8a9d` | **Information and state.** Unread badges, active tab dot, distance chips, links, translated-caption tag, read ticks. The accent family was swapped from iOS blue to the owner's teal reference on 2026-07-25; the token *name* stayed `--blue` so no call site changed. |
| **Red** | `--red` on `--redwell` | `#e5342b` / `#feecec` | **Destructive only.** Reject, delete, block, failed sends, the friend-request pip. Red never decorates. |
| **Live green** | `--live` | `#22c55e` | Presence dots only. |
| **Mesh blue** | `--mesh` | `#2563eb` | Bluetooth-mesh accent — deliberately distinct from the Nearby green and the teal accent. `--mesh-dim` is its 12% wash. |

Supporting neutrals: `--ink2 #3d3d42` (secondary text), `--muted #8e8e96`, `--bg #e9e9ec`, `--surface #fff`, `--well #f1f1f3` (inset fills), `--line #e6e6ea`, `--hair #eeeef1`. Chat-specific: `--out #4db6c9` (outgoing bubble, light teal) with `--outink #0c343b` (dark text on it — outgoing bubbles are dark-on-light, per the owner's reference), `--teal-deep #17616b` (send button). Discovery map has its own muted palette (`--road`, `--block`, `--park`, `--route`, `--water`).

**Roles extracted from the view CSS (2026-08-06).** The view files carried 137 raw hex literals, which is the same thing as a colour with no stated job. The ones outside `chat.css`/`moments.css` are now tokens holding *exactly* the literals they replaced — nothing in the palette moved, and `test/design-tokens-fence.test.js` pins each value individually so this stays a rename. The one distinction worth knowing: **`--onfill` (`#fff`) is text and icons ON a filled ground; `--surface` (`#fff`) is the ground itself.** Same value today, different jobs, and they stop being interchangeable if a dark theme is ever added as a P3 extension — so the fence asserts `--onfill` is never a background and `--surface` never a text colour. Also `--ink-press` (`#000`, the hover deepening of an ink fill, deliberately one step past `--ink`), `--arch` (archive, beside `--red` for delete in the swipe vocabulary), `--bt-scope-*`/`--bt-blip` (the Bluetooth radar's dark scene), and `--vcard-*`. `chat.css` and `moments.css` still hold the other 98 literals pending PR #130.

The rule that settles most debates: **black is "do it", blue is "know it", red is "undo it".** Example in code: `.pill.ok` in `tokens.css` carries the comment *"Commit actions are ink, not blue — blue is information, black is 'do it'."*

The palette is **light-only and pinned**: tokens are declared for `:root`, `:root[data-theme="dark"]`, and `:root[data-theme="light"]` identically, with `color-scheme: light`, so a host dark-mode toggle cannot break it. A dark theme is not a P1/P2 goal; if ever added it is a P3 extension with its own token set, not an edit to these values.

## 2. Typography (P1)

- **Family:** `--font: "Sora", "Plus Jakarta Sans", <nine Noto Sans Indic faces>, -apple-system, … sans-serif` — Sora everywhere, including `button`, `input`, `textarea`, `select` (explicitly reset in `tokens.css`). Sora leads and is unchanged; the Noto families sit behind it purely as **script coverage** for characters Sora has no glyphs for — Devanagari, Tamil, Telugu, Bengali, Kannada, Malayalam, Oriya, Gujarati, Gurmukhi. This is a fallback extension, not a restyle: a family is only reached for characters every family before it lacks, so no Latin glyph changes. It exists because `LANGS` (`lib/translate.js`) renders every language's native name in the picker at once, and a script with no font draws as tofu. Arabic (incl. Urdu) and CJK are deliberately left to system fonts — the reasons are pinned in `test/design-tokens-fence.test.js`, which fails if a language is added to `LANGS` without glyphs behind it.
- **Hosting:** the faces are **self-hosted** in `public/fonts/`, declared in `src/fonts.css`, and regenerated by `scripts/fetch-fonts.mjs`. They were previously fetched from `fonts.googleapis.com`, which put a render-blocking third-party stylesheet on the critical path and leaked every reader's IP. Weights are kept **discrete** on purpose: these are variable fonts, and a single `font-weight: 200 800` face would re-render the 640/650 weights below as a true, visibly lighter 640 instead of snapping them to 700.
- **Tracking:** display and headings run tight negative tracking (`-.03em` to `-.04em` — onboarding `h1` at 32px, inbox `.h2` at 19px, wordmark `.wm`). Body sits around `-.01em`. Uppercase micro-labels invert to wide tracking (`.11em`–`.12em` — day dividers in `chat.css`, field labels in onboarding).
- **Tabular numerals:** `font-variant-numeric: tabular-nums` on every timestamp, counter, and badge (`.tOut`, `.meta`, `.tm`, `.bdg`, `.pip`, `.apCount`, voice-note durations) so numbers never jitter as they tick.
- **Weights:** 600 for labels, 640–650 for names and buttons, 700 for emphasis/active states, 800 for the wordmark only.
- **Sizes** are small and dense by design: 10–12px metadata, 12.5–13.5px secondary, 14–15.5px primary, 19px section headings, 32px onboarding display.

## 3. Layout: the 560px shell (P1)

`#app` in `tokens.css` is the entire layout contract: `height: 100dvh`, `display: flex; flex-direction: column`, **`max-width: 560px`**, centered, `overflow: hidden`. The app is a single phone-width column even on desktop; views (`.view`) are flex columns with `min-height: 0` and one `.scroll-y` region. `html, body` lock scrolling (`overflow: hidden; overscroll-behavior: none`) — the app owns all scroll surfaces. Safe areas are handled with `env(safe-area-inset-bottom)` on the nav bar, sheets, and toasts.

Overlays share one max-width: action sheets are `max-width: 560px; margin: 0 auto`, so nothing ever escapes the shell.

## 4. Floating bottom bar (P1 — verbatim-locked)

The `tokens.css` section is literally titled *"locked bottom bar (verbatim)"*. Spec, from the owner's WhatsApp reference (IMG_6987):

- A **floating rounded plate**, not a full-width strip: `border-radius: 999px`, `margin: 0 10px calc(8px + env(safe-area-inset-bottom))`, hairline border, soft teal-tinted shadow.
- Tabs (`.nv`): icon (22px SVG) over a real text label (10.5px / 600 / `-.01em`), color `--ink2`.
- **Active tab** = filled pill: `background: var(--well)`, ink label at weight 700, icon `stroke-width: 2.1`. Exactly the reference's grammar — no underline, no accent recolor.
- **Pips:** unread counts are a blue pill (`--blue`, tabular numerals, 2px surface ring). Friend requests get a **red** pip (`.pip.req`) with a `pip-pop` scale-in — the code comments the reasoning: *"Friend requests demand attention, not information."*

## 5. Shared components (P1)

All defined once in `tokens.css`, reused by every view:

- **Avatars (`.av`)** — size via `--s` custom property (default 40px). Photo, or a gradient-initial fallback (135° indigo→cyan, white initial at 42% of size). Presence dot `.dot` = `--live`, 24% of avatar size, 2.5px surface ring.
- **Pills (`.pill`)** — the button vocabulary. `pill.ok` = ink fill, white text, soft shadow, hover lifts `-1px`, disabled at 42% opacity. `pill.no` = `--redwell` well with `--red` text. 12.5px / 650 / full-radius.
- **Action sheets (`.as-*`)** — bottom sheets on a 32%-ink backdrop; sheet slides up 40px over 220ms `cubic-bezier(.4,0,.2,1)`, 18px top radius, safe-area padding. Items are 15px/600 rows; `.danger` is red; `.cancel` is muted and centered.
- **Toast (`.toast`)** — ink pill fixed above the nav bar (`bottom: calc(84px + env(safe-area-inset-bottom))`), 13px/600 white text, single line with ellipsis, 220ms rise-in.
- **Crop modal (`.crop-*`)** — dark 84% backdrop, circular mask preview, ink commit button with a hairline so it reads on the dark ground.
- **Privacy blur (`.privacy-blur`)** — 26px blur applied on `visibilitychange` for the app switcher.
- **Pull-to-refresh (`.pullref`)** — always-visible drag feedback; added because the silent Archived reveal *"made the gesture feel broken"* (comment in `tokens.css`).

## 6. Motion (P1)

- **Working band: 140–220ms.** Interaction transitions run `.14s`–`.18s ease` (hover fills, tab pills, color shifts); structural entrances run `.22s` (sheets, toasts). Nothing interactive is slower.
- **List entrances** may run slightly longer (`.28s`–`.32s` fades) and are **staggered**: rows animate in at 32ms steps (inbox `inbox.js`, discovery `discovery.js`, notifications `notifications.js`), 40ms for Bluetooth radar rows (`bluetooth.js`), always **capped** (8–12 items) so long lists don't wait. Chat reaction bursts stagger at `calc(var(--i) * 90ms)` (`chat.css`).
- Message arrival uses a 6px rise (`vchat-rise`, `chat.css`); decorative flourishes (voice-note sparkles, the reaction orbit) are pure-CSS `nth-of-type` staggers — GPU-cheap, no JS timers (noted in `chat.js`).
- **`prefers-reduced-motion` is law.** `tokens.css` globally kills all animations and transitions under the media query, and view files additionally zero their own entrance animations (`chat.css`, `inbox.css`).

## 7. The split-bubble translation pattern (P1 — product signature)

Incoming bubbles (`.bubIn` in `chat.css`) are split into two permanently visible sections:

1. `.src` — the **original text**, top section, 14.5px, exactly as the sender wrote it.
2. `.tr` — the **translation**, bottom section, separated by a hairline `border-top` on a `--surface` ground: a small blue caption `.trTag` (the language name, 10px — deliberately restyled from the old wide-tracked caps because that treatment *"turn[s] a language name into a smear"*, per the comment) above the translated text `.trTxt` in 14px italic `--ink2`.

**Rationale (why never a toggle):** translation is presented as an *annotation on* the message, not a *replacement of* it. Both parties can always see the exact bytes that were sent — the reader can verify, quote, or learn from the original; a mistranslation is visible instead of silently substituted. Hiding the original behind a tap would make the app the invisible middleman in every cross-language conversation, which contradicts the honesty rules below. The visual grammar reinforces the hierarchy: original in upright ink on the well, translation in italic secondary ink on surface, tagged in the information color (blue).

## 8. Honesty as design (P1 — product law)

These are not style preferences; they are product rules the UI must encode:

- **No fake states.** Message status is **Sent + Read only** — there is no invented "Delivered" tier the transport cannot actually prove. A failed transfer renders as a red warning row (`.readRow.failed`, `chat.css` — comment: *"A transfer that never landed. Reads as a warning, not as a tick."*), never as an optimistic tick.
- **Approximate data is marked approximate.** Distances display with `~`. Never render precision the sensor doesn't have.
- **Demo content is labeled.** Practice contacts and demo rows carry visible chips; nothing synthetic impersonates a real peer.
- **Denied is a state, not an error.** Geolocation off/denied gets an honest, tappable retry panel (`discovery.css`: *"Geolocation off/denied — honest, and tappable to retry."*). Notification settings show real permission state readout, not aspirational toggles.
- **Cooperative features admit it.** Anything that depends on the other device cooperating (disappearing timers, view-once) is described as such in the UI. Settings carries a "What is actually private" card.
- **Gestures give feedback.** No silent affordances — see the pull-to-refresh rationale above.

Any new feature must pass this filter before it passes visual review.

## 9. React Native component-library equivalence (P2)

The RN app must be the *same system*, not a re-design. Mapping:

| Web (P1) | React Native equivalent (P2) |
|---|---|
| `tokens.css` custom properties | A single `tokens.ts` exporting the same names/values; consumed via a theme object. No second palette. |
| Sora via CSS `--font` | Sora loaded with `expo-font`; one text component enforcing family, tracking, and weight scale |
| `font-variant-numeric: tabular-nums` | `fontVariant: ['tabular-nums']` on all timestamp/counter styles |
| 560px shell, `100dvh` flex column | Native fills the screen (shell cap applies to web/tablet only); same flex-column + single-scroll-region structure; `react-native-safe-area-context` replaces `env()` |
| `.nav` floating bar | Custom `tabBar` on the bottom-tab navigator reproducing the plate, active-pill, and pip spec — not the default tab bar |
| `.as-*` action sheets | One bottom-sheet component (e.g. `@gorhom/bottom-sheet` or Modal-based) with the same backdrop, radius, timing, and item grammar |
| `.pill`, `.av`, `.toast` | `Pressable`-based Pill, Avatar (with gradient-initial fallback + presence dot), and Toast components with identical tokens |
| Split-bubble `.bubIn`/`.src`/`.tr` | A `MessageBubble` component with the same two-section anatomy; original and translation both always rendered |
| CSS transitions/staggers | Reanimated, same 140–220ms band and 32–40ms capped staggers |
| `prefers-reduced-motion` | `AccessibilityInfo.isReduceMotionEnabled` gating all animation, globally |
| `.privacy-blur` on `visibilitychange` | `AppState` + blur/cover view on background (app-switcher snapshot protection) |

P2 acceptance test: a screenshot of any RN screen placed beside the web view should differ only in platform chrome.

## 10. P3 notes

- Token pipeline (style-dictionary-class generation from one source into CSS + TS) becomes worthwhile only when a third surface exists.
- Any theming (dark, high-contrast) is additive token sets validated against the color-role table in §1 — roles are invariant even if values gain variants.

---

*Everything cited above is present in the repository at the listed paths. When this document and the CSS disagree, the CSS wins — then fix the document.*
