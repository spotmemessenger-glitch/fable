# Moments — audience (Part A) and the interaction layer (Part B, partial)

**Date:** 2026-08-07 · **Branch:** `claude/vercel-token-connection-bj4d21` · PR #143

**Part A is complete and now CI-verified.** Part B is not. B1 and B6 are done and verified; B2–B5
and B7 are not started. Naming that up front because a partial delivery reported
as a whole one is the more expensive failure.

---

# PART A — audience and feeds

## A1 — the author always sees their own posts ✅

Three independent clauses excluded them, and each looked reasonable alone:

1. **`WHERE m."visibility" <> 'private'`** at the top level — so a `private`
   post was invisible to **everyone including its author**. Not "only you":
   nobody. The composer offered the option and choosing it silently threw the
   post away, with no surface anywhere that could show it back.
2. **friends mode requires a `MomentFollow` row**, and nobody follows
   themselves — so posting to Friends and then opening Friends showed an empty
   feed containing the post you had just made.
3. **nearby/city filter on visibility and geography** — so your own `friends`
   post, or one with no location fix, vanished from the tab you were looking at.

Fixed by OR-ing an `isAuthor` predicate with the **audience** clause only.
Moderation was lifted **out** of the per-mode block and is applied
unconditionally, so this widens *who* may see a post and never *what* may be
shown. Fenced in both directions: the author does **not** see their own removed
post, and a deleted post stays gone for them too.

### On `notSelfExcluded` — the mission asked, and the answer is worth keeping

**The name is a lie, and that is how this survived.** It asserts the author is
not excluded. The SQL is `AND m."deletedAt" IS NULL` and has never had anything
to do with self. Anyone reading the name would reasonably conclude
self-visibility was handled and stop looking — which is exactly what a
misleading name costs. Renamed to `notDeleted`.

## A2 — the audience badge ✅

Every card carries a small badge: **Nearby · Friends · Public · Only you**. On
other people's posts as well as your own, deliberately — knowing a post is
public is what tells you whether resharing it is reasonable.

Built from the app's own tokens (`--ink`, `--ink2`, `--well`, `--hair`,
`--arch`, `--onfill`). **Red is untouched**: ADR-034 reserves it for destructive
and SOS, so "Only you" — the most restrictive audience and the one most worth
noticing — is distinguished by weight and a filled ground rather than by alarm
colour. Token fence 29/29.

## A3 — the composer's selection reaches the create call ✅ (test written)

`test/moments-audience.spec.ts`, one case per value, driving the **real HTTP**
create route and reading the stored value back **out of the database** — an echo
of the create response would pass even if the column were written with a
default.

## A4 — no dead options ⚠️ half

- **`private` → "Only you"**, which is what it does, and A1 makes that true in
  the query. Was genuinely dead before: chosen, stored, and then visible to
  nobody.
- **`public` is kept and labelled honestly**, not removed. The city feed already
  reads it; no tab reaches the city feed. Deleting a value the backend supports
  would only have to be undone when that tab lands, and the badge at least makes
  the choice visible and reversible.

**The open half: `public` still has no surface of its own.** A city tab, or
folding public into nearby without a distance limit, is a product decision I
should not make silently. Recorded rather than quietly resolved.

## A5 — does Friends work now? ✅ YES — verified, not reasoned

**CI ran `moments-audience.spec.ts` against real Postgres on `7bdc3fe` and it
passed**, along with web, e2e and compose. This section previously said the
answer was conditional; it no longer is.

What is now proven rather than argued:

| assertion | result |
|---|---|
| the author's own **friends** post appears in the friends feed | ✅ |
| …with **no self-follow row** — fixed in the query, not by inventing data | ✅ |
| a **`private`** post is visible to its author — "only you" means you | ✅ |
| the author's own nearby post appears in nearby | ✅ |
| the author's own **friends** post appears in **nearby** too | ✅ |
| a stranger never sees the private post, in any mode | ✅ |
| a stranger who follows nobody does not see the friends post | ✅ |
| a stranger still sees the nearby post — nothing was narrowed | ✅ |
| the author does **not** see their own **removed** post | ✅ |
| a **deleted** post stays gone for its author too | ✅ |
| all four audience values persist as chosen, read back from the DB | ✅ |

**Keep both tabs.** Friends is now the only mode showing follow-scoped posts,
and Nearby cannot substitute for it because Nearby is geography-bound. The
friends feed's only bar to the author was the `MomentFollow` requirement, and
`isAuthor` short-circuits it without a self-follow row.

**One detail worth keeping**, because it makes the nearby assertion stronger
than I originally designed it: the `friends` and `private` posts carry **no
location at all** — the policy refuses a location on those tiers outright. So
the author's own friends post appearing in the **nearby** feed cannot be
explained by geography. It can only come from `isAuthor` short-circuiting the
geo predicate, which is exactly what A1 claims.

---

# PART B — the interaction layer

## B1 — like, instant and physical ✅

**A tap now likes.** The picker was previously the only way to react, so the
commonest action in the product cost a tap, a sheet, a read and a second tap. A
long press still opens the full picker.

- **Optimistic**: fill and burst happen *before* the request. A like that waits
  on a round-trip feels broken on a slow connection even when it works.
- **On failure the fill is reverted** and said once. The revert matters more than
  the toast: a like that silently did not persist leaves the reader believing
  something untrue.
- **Double-tap the media** likes it through the same path, burst centred on the
  finger.
- **Burst**: 260 ms overshoot-and-settle, 380 ms particle throw — under the
  400 ms ceiling by construction, both numbers declared in one place so the
  budget is checkable.
- **No layout shift, structurally**: particles live in a zero-size absolutely
  positioned anchor, so adding them cannot move a pixel.
- **Transform and opacity only** — this fires mid-scroll, and anything forcing
  layout per frame turns a like into a stutter on exactly the hardware that can
  least afford it.
- `prefers-reduced-motion` disables it.
- **Teal, not red** (ADR-034).

**Haptics, honestly:** wired via `navigator.vibrate`. **iOS Safari does not
implement it**, so this is a no-op on the owner's phone; Android Chrome honours
it. Wired rather than pretended, and there is no web API that changes this.

## B6 — one audible media at a time ✅ (the real gap, found by looking)

Moments video already routed through `playExclusive`, which pauses the current
owner **first** and only then takes ownership — the correct order.

**Chat voice notes did not.** They called `audio.play()` directly, so there were
two independent notions of "what is playing" and neither could see the other: a
voice note could be audible over a Moments video. All three chat playback sites
now go through the same owner.

Play-new-then-pause-old is the ordering that produces the overlap, however
brief, and on a slow decode it is not brief.

**Not verified:** the "scroll fast through 20 video posts" test needs a device
and real clips.

## B2, B3, B4, B5, B7 — NOT DONE

Not started. No partial code was left behind for them.

**B2 is the one I would do next**, and it is the largest. "A like only appears
on the liker's own profile" is a real defect and the fix spans three layers —
reaction persistence and count aggregation, a live count on the card, and an
Alerts entry for the author. B1 makes the *gesture* instant; **it does not make
the like reach anyone**, and those are easy to confuse from the outside. A like
today still goes nowhere the author can see.

B3/B5 partly exist from earlier work in this session — the reels viewer has an
action rail, scrub bar and back chevron — but they have not been checked against
this mission's spec (counts on the icons, save pinned and separated, 44 px
targets audited) and I am not claiming them.

---

## Verification

| | |
|---|---|
| web lint | clean |
| web `npm test` | ✅ exit 0 |
| web build | ✅ |
| design-token fence | 29/29 |
| backend `tsc --noEmit` | clean |
| backend build | ✅ |
| `moments-audience.spec.ts` | **✅ PASSED in CI** against real Postgres (`7bdc3fe`) — not runnable locally, no Postgres |
| CI overall on `7bdc3fe` | web ✅ · backend ✅ · e2e ✅ · compose ✅ |

**"Verify on both phones" — I cannot.** I have no access to either device, and
no headless run makes that claim true. Everything above is verified by the means
named next to it; the two-account, two-device checks in B2 and B6 are exactly
the ones that need real hardware, and B2 is not built yet in any case.

## Recommended order next

1. **B2** — make a like reach the author. It is the substance behind B1's
   surface, and without it B1 is a convincing animation over a no-op.
2. **B3/B4/B5** against this spec, with the existing viewer as the starting
   point rather than a rewrite.
3. **A4's open half** — decide whether `public` gets a city tab or folds into
   nearby. Product call, not mine.
