# Slice 1 — Exchange: API reconciliation before any component

**Date:** 2026-08-07 · **Branch:** `feat/slice-1-exchange-ui` (stacked on `feat/slice-0-frontend-migration` `5c24511`)
**Status: RECONCILE done. BUILD not started.** Four screens not written.

Mission order was "RECONCILE FIRST, BUILD SECOND … report the gaps BEFORE
writing components." The gaps are large enough that building first would have
produced a UI promising things the server cannot do.

---

## 1. The four fields, confirmed or denied

Source of truth: `backend/src/exchange/exchange.types.ts` → `ExchangeIntentPublic`
(the only shape that reaches a client), `exchange.controller.ts`,
`exchange.policy.ts`.

| Mock element | Screen | Exists? | Verdict |
|---|---|---|---|
| "Seen by ~40 people" | Create step 3 | **NO** | **OMIT** |
| "4 people messaged" | My intents | **NO** | **OMIT** |
| "visible for 30 days" | My intents toast | **field yes, number wrong** | **OMIT the literal** |
| Thumbnail on every card | Browse | **NO** | **OMIT** |

### "Seen by ~40 people" — does not exist, and should not

No audience, reach-estimate, impression or view field exists anywhere in the
Exchange types. Building it would mean inventing a number.

It is also the *category* of metric this product has already ruled out: a count
of people who never chose to be counted. ADR-028 bans engagement telemetry and
the moments dark fence enforces the list by name (`viewCount`, `shareCount`,
`watchTimeMs`, and — added in the B2 work — `impressionCount`, `dwellMs`). An
Exchange audience estimate is the same thing wearing a friendlier label.

### "4 people messaged" — does not exist

No contact-count field. `ExchangeIntentPublic` carries no aggregate about other
people's behaviour toward the intent at all. Same objection as above, with an
added privacy edge: it reports how many people looked at *you* and decided
something.

### "visible for 30 days" — the field exists; the number is wrong by 30×

`expiresAtIso: string | null` is real. But `exchange.policy.ts`:

- `defaultExpiryHours: 24` — **one day** is the default
- `maxExpiryHours: 24 * 30` — thirty days is the **ceiling**, only reachable by
  passing `expiresInHours` explicitly

So a toast saying "visible for 30 days" is false for every intent that does not
opt in, which is all of them by default. It is also marked `[PROPOSED]` in the
policy, so the number is not even settled.

**Correct UI:** render the actual `expiresAtIso` relatively ("visible until
tomorrow"), or say nothing. Never a hardcoded duration.

### Thumbnails on browse cards — do not exist

`ExchangeIntentPublic` has no `media`, `mediaIds`, `thumbnail`, `image` or
`posterUrl`. Moments has a media pipeline; **Exchange has none**. All five
browse cards in the mock show a photo and not one of them can be rendered.

This is the largest visual gap: the mock's browse layout is built around a
64 px leading thumbnail. Without it the card needs a different composition, not
a placeholder box — a grey rectangle on every row is worse than a text-first
card that was designed to be text-first.

---

## 2. Three further gaps the mission did not ask about

These matter more than two of the four above.

### 2a. "Message Meena" is the wrong primary action — the server will refuse it

`ports.ts` carries
`contact: { state: 'none'|'requested'|'accepted'|'declined'; canRequestContact: boolean; requiresExplicitConsent: true }`,
and Phase 3's standing constraint is *"contact/chat follows explicit
acceptance; nothing opens a conversation implicitly (PRD §03.4, P7)."*

A primary button reading **Message Meena** promises a chat that opens on tap.
It does not. The real flow is **request → the owner accepts → chat opens**.

This is precisely the mission's own rule — "do not let a toast promise
something the server does not do" — applied to the most prominent control on
the screen. Correct label: **Request contact**, with the consent step visible
rather than implied.

### 2b. The distance filter has no server parameter

`GET /exchange/browse` accepts exactly `kind`, `category`, `cursor`. That is
all.

- **"Services only"** → expressible as `kind=service` ✓
- **"Any category"** → `category` ✓
- **"Within 5 km"** → **no parameter exists.** No lat, no lon, no radius.

Browse cannot filter by distance today. Shipping the control would mean either
a dropdown that changes nothing, or client-side filtering of one keyset page —
which silently lies about completeness. **Omit until the endpoint takes it.**

Note the asymmetry: individual intents *do* carry `approxLocation` and
`radius`, so per-card "about 2 km" is renderable. It is the *filter* that is
missing, not the distance.

### 2c. The mock's orange button fails ADR-034

"Message Meena" is **white text on the orange 500 fill**. ADR-034 Decision 1
measured exactly this: **2.87:1, fails AA**. The ADR mandates near-black on 500
(6.67:1) and records the measurement specifically so the white version is not
proposed again.

The token layer added in this branch encodes it: `--x-onaccent: var(--ink)`.

---

## 3. What IS available, and lines up cleanly

Everything the Detail screen shows apart from the CTA:

| Mock | Field |
|---|---|
| NEED / OFFER / SERVICE badge | `kind: 'need' \| 'offer' \| 'service'` |
| Tags (Lifting, Weekend, 20 min) | `tags: string[]` |
| Budget band Low | `budgetBand?: 'low' \| 'medium' \| 'high'` |
| Availability "Sat & Sun, mornings" | `availability: {state:'window'\|'recurring'\|'unknown'}` |
| Approximate-area circle | `approxLocation {lat,lon,cell}` + `radius {km,maxKm}` |
| "About 900 m away · approximate" | derived from `approxLocation` |
| My-intents tabs | `status` enum covers active/paused/matched/fulfilled |
| Pause / Edit | `POST /intents/:id/{pause,resume,update}` |
| Withdraw / Mark fulfilled | `POST /intents/:id/{withdraw,fulfilled}` |
| Discoverable toggle | `visibility: 'hidden' \| 'discoverable'` |
| Reach slider | `radius: {km, maxKm}` |
| Budget "None" option | absent band = None (`budgetBand` optional) ✓ |

The existing inert surface (`packages/ui/exchange`, 599 lines: `IntentComposer`,
`IntentCard`, `MatchCard`, `ModeTabs`, `CategoryPicker`) already models the
honest subset — its ports carry no audience, no contact count and no media
either. **The mocks, not the existing code, are what drifted.**

---

## 4. Recommended scope change

Build the four screens against the real API, with these four omissions and two
corrections:

1. no audience estimate (Create step 3 loses its right-hand caption);
2. no contact count (My intents shows reach only);
3. expiry rendered from `expiresAtIso`, never "30 days";
4. no thumbnails — browse becomes a text-first card;
5. primary CTA is **Request contact**, not Message;
6. no distance filter until `browse` accepts one.

Items 1, 2 and 6 are arguably product decisions rather than engineering ones —
if the owner wants an audience estimate, it needs a backend field and an
ADR-028 exception, and both are owner-retained. Flagged, not assumed.

---

## 5. What landed on this branch

**Exchange accent tokens only** (`apps/web/src/tokens.css`), ADR-034-governed
and scoped: `--x-accent-{400,500,600,700}`, `--x-onaccent`, `--x-accent-well`,
`--x-accent-line`. `--x-` prefixed so none can be mistaken for the app primary,
which is untouched. Danger deliberately excluded from the ramp so an Exchange
destructive action keeps reading as destructive — the CVD separation ADR-034
measured.

`apps/web` still **1,125 assertions / 60 suites, exit 0** — the design-token
fence passes with the new tokens.

**Not built:** the four screens, the island host, flag `spotme.ui.exchange`.
Nothing partial is on the branch.

---

## 6. Hard rules — status

| Rule | Status |
|---|---|
| Coarse circles, never pins | Not yet exercised; `approxLocation` + `radius` support it |
| Distances approximate | Supported per-card; the *filter* is not |
| Budget band, never a number | `budgetBand` enum only — no currency field exists |
| No cart, no checkout | Nothing added; `informationalPrice` carries `'informational-only-no-payment'` |
| Report on every user-content surface | Not yet built |
| 44 px targets, accessible names | Not yet built |
| Latin + Indic type | Carried by the #132 font stack already in `apps/web` |
| No persisted-shape change | **Held** — this branch adds CSS tokens only |

**Hard stops honoured:** branched from #139, not master · no merge · no deploy ·
no Vercel change · nothing deleted · no Tailwind · env **names** only.
