# 02 — UX & Screens

> Reconstruction pending A5 ratification. Screen names and flows are `[PROPOSED]`.

## 2.1 Design principles (UX)

- **One tap to express intent** — posting a Need/Offer is fast; structure is
  inferred and confirmable, never a long form up front.
- **Unified with Discovery** — Exchange results live on the same map + list
  surfaces as places/events (single result model, single map state) `[REUSE]`.
- **Explainable** — every match shows *why* (distance, intent fit, availability,
  trust) in plain language.
- **Approximate by default** — location shown as a coarse area/pin, "~X km",
  never an exact address until both sides consent.
- **Honest states** — loading / empty / unavailable / partial / failed are all
  explicit; no fake results, no invented counts.

## 2.2 Screen inventory `[PROPOSED]`

| Screen | Purpose |
|---|---|
| **Exchange Home** | Tab within Discovery. Toggle Needs / Offers / Both; nearby feed + map; "Post" FAB. |
| **Compose Need** | Create a Need: intent chips + free text, category, urgency, budget (optional), radius, expiry, location precision control. |
| **Compose Offer** | Create an Offer: same shape; recurring toggle; business fields if a business. |
| **Match List** | Proposed matches for one of my Needs/Offers, ranked, each with rationale. |
| **Match Detail** | A single counterpart: approximate location, distance, availability, trust/reputation, rationale, actions (Message, Save, Hide, Report). |
| **Unified Search** | Text/voice search across places, events and Exchange; results tabbed + on map. |
| **My Exchange** | My active/expired Needs & Offers; status; edit/withdraw; resolution. |
| **Conversation Handoff** | Transition sheet: what the other side sees, consent to share more, then knock → chat. |
| **Report / Block** | Safety flow (§06). |
| **Settings — Exchange** | Notification prefs, default radius, location-precision default, business mode, opt-in personalization. |

## 2.3 Primary flow — post a Need → match → converse

```
Exchange Home
   │  tap "Post" → choose "Need"
   ▼
Compose Need  ──(intent chips + text; category; radius[PROPOSED 10km]; expiry[PROPOSED 24h];
   │             location precision = Approximate by default)
   │  Submit
   ▼
Need = ACTIVE  →  matching runs (async)  →  Match List populates (honest "searching…" then results/empty)
   │
   ▼
Match Detail  ──(shows rationale + approximate distance + trust)
   │  tap "Message"
   ▼
Conversation Handoff  ──(consent gate: what to reveal; still approximate unless you opt to share)
   │  Confirm → knock
   ▼
Chat (Communication pillar)  →  resolve  →  mark Need RESOLVED (or it EXPIRES)
```

## 2.4 Compose — the intent-capture pattern

- **Intent chips** offer structured hints (category, "need/offer", urgency,
  "today/this week", "free/paid") the user taps; free text refines.
- The **structured intent** (category, timeframe, budget band, tags) is what
  matching keys on; free text is a secondary signal.
- **Location precision control** (default **Approximate**): Approximate (coarse
  cell) / Neighbourhood / Exact-on-connect. Exact is never public; it is shared
  only at Handoff with explicit consent (§07).
- **Expiry** (default `[PROPOSED]` 24h for Needs, 7d for Offers) with a visible
  countdown; extend/withdraw anytime.
- Honest capability: if AI intent parsing is unavailable, fall back to the
  structured chips + text — never block posting.

## 2.5 Match List & rationale

- Ranked best-first (§04); each row: title, approximate distance ("~1.2 km"),
  availability, a **trust badge**, and a one-line **rationale** ("Matches
  'plumbing' · ~1.2 km · available today · verified").
- Alternative sorts: distance, soonest-available, trust, recency `[PROPOSED]`.
- Empty state is honest: "No matches yet within ~X km — we'll notify you, or
  expand the radius." Offer transparent radius expansion (§04) with a visible
  "expanded to N km" note.

## 2.6 Unified Search

- A single search box (text + mic) over **places · events · exchange**; results
  tabbed and reflected on the shared map (`[REUSE]` Discovery map state).
- Voice: partial + final transcript, language detection, text fallback; route
  questions use a directions provider, never a straight-line-as-driving estimate
  (constitution) `[REUSE]`.

## 2.7 Accessibility & i18n

- WCAG-oriented: semantic structure, focus order, screen-reader labels for map
  pins and match rationale, dynamic text, high contrast, reduced motion.
- Fully localizable strings; RTL; metric/imperial distance; local currency for
  optional budget; timezone-correct availability.

## 2.8 Visual & motion

- Map/list 60 FPS target on supported devices `[REUSE]`; long feeds virtualize.
- Distinct-but-consistent visual language shared with Discovery; Exchange items
  are visually differentiated (Need vs Offer) without a separate app feel.
