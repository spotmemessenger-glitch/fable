# Slice 1 — Exchange: API reconciliation before any component

**Date:** 2026-08-07 · **Branch:** `feat/slice-1-exchange-ui` (stacked on `feat/slice-0-frontend-migration` `5c24511`)
**Status: RECONCILE done. BUILD done.** Four screens, island host, flag, tests.

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

## 5. What landed

### Screens — `packages/ui/exchange/screens.tsx`

Browse (Needs/Offers, category + Services-only), Detail (tags, budget band,
availability, approximate-area circle, Save/Share/Report), Create (3 steps,
None/Low/Medium/High, reach slider, Discoverable), My intents
(Active/Paused/Matched/Fulfilled). **Withdraw and Mark fulfilled sit in an
overflow menu** on Detail and on every My-intents row.

Built to §4 above: three fields omitted, expiry from the real value, primary
action **Request contact**, no distance filter.

### Island host — `apps/web/src/lib/island.js`

Deferred from slice 0 because a mount point with nothing to mount tripped the
fence it shared a PR with. Slice 1 is its first consumer.

The `@spotme/ui` specifier is **assembled at call time, not static**. A static
import would (a) make every dark surface reachable from the shipped entry,
which the dark fence rightly forbids, and (b) bundle React for the 100% of
users who have the flag off. Hostile storage reads as OFF, so the failure mode
is "legacy renders", never "React renders unexpectedly". The host **writes
nothing**, so ADR-035 §(g) tier-1 rollback has no persisted shape to diverge.

Route: `#/exchange` → `views/exchange.js`, which renders "Exchange is not
enabled on this device" with the flag off. Exchange is greenfield, so there is
no legacy screen to fall back to — absence *is* today's behaviour.

### The dark fence changed mechanism rather than being dropped

Exchange is now deliberately reachable, so asserting non-reference would only
assert that slice 1 did not ship — the same situation the Discovery fence hit
when `DiscoveryModule` went behind `DomainGate`. It now asserts the stronger
invariant: exactly one reach from the live entry and it is the route view;
that view gates on `uiFlag`; nothing defaults the flag on; the host has no
static package import; and the ui entry exports **Exchange only**, so
discovery/events/moments/assistant stay unreachable through it.

**Tamper-checked:** removing the flag gate turns it red; restoring turns it
green.

### Verification

| Surface | Before | After |
|---|---|---|
| `packages/ui` | 105 passed / 4 skipped | **125 / 4**, boundary 6/6, tsc clean |
| `apps/web` | 1,125 assertions / 60 suites | **1,125 unchanged + 7 new**, **61 suites**, exit 0 |
| `apps/web` lint · build | 0 · 0 | **0** · **0** |
| backend dark fences | 65/65 | **66/66** |

The apps/web baseline **held exactly** — no existing assertion changed. The
7 additions are the island-flag suite; the 20 new `packages/ui` tests are the
screens.

### How to see it

```
localStorage.setItem('spotme.ui.exchange', 'on')   // then open #/exchange
localStorage.removeItem('spotme.ui.exchange')      // tier-1 rollback
```

Fixture-backed: no endpoint is wired, because `browse` takes no radius
parameter and contact is consent-gated server-side.

## 6. Hard rules — status

| Rule | Status |
|---|---|
| Coarse circles, never pins | **Done** — one `<circle>`, no marker element; test-pinned |
| Distances approximate | Supported per-card; the *filter* is not |
| Budget band, never a number | `budgetBand` enum only — no currency field exists |
| No cart, no checkout | Nothing added; `informationalPrice` carries `'informational-only-no-payment'` |
| Report on every user-content surface | **Done** — Detail action row, test-pinned |
| 44 px targets, accessible names | **Done** — CSS min-height/width 44px; a test asserts every button has a name |
| Latin + Indic type | Carried by the #132 font stack already in `apps/web` |
| No persisted-shape change | **Held** — the host writes nothing; a test asserts no `setItem`/`indexedDB` |

**Hard stops honoured:** branched from #139, not master · no merge · no deploy ·
no Vercel change · nothing deleted · no Tailwind · env **names** only.
