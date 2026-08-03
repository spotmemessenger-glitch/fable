# 07 — Privacy Architecture

> Reconstruction pending A5 ratification. Binds to ADR-018/019 and the product
> constitution — these are **not** `[PROPOSED]`; they are inherited law.

## 7.1 Location privacy (inherited, non-negotiable)

- **Precise GPS is device-local.** Exchange uses the precise fix only on-device
  for distance, radius and centring; it is **never** attached to a Need/Offer,
  broadcast, logged, put in analytics/URLs, or sent to a provider except where a
  nearby lookup technically needs an origin. (ADR-019.)
- **Public location is approximate.** A Need/Offer carries an **approximate**
  location — snapped to a coarse privacy cell with a rotating bounded offset
  (ADR-018) `[REUSE]` `geo-approx`. The map shows a coarse area/pin and "~X km",
  never an address.
- **Exact location is never exposed by matching.** Two people can match without
  either learning the other's exact position. Sharing anything more precise is an
  explicit, per-interaction choice at the **consent gate** (Handoff, §03.4).
- **Mutation-tested boundary:** deterministic tests fail if a precise coordinate
  ever reaches a Need/Offer record, a match payload, a notification, a log, or
  the DOM `[REUSE]` the Discovery privacy test pattern.

## 7.2 Consent

- **Explicit and revocable** for: showing my item on the map, sharing
  neighbourhood/exact location at handoff, enabling proactive provider pings,
  and opt-in personalization. Defaults are the privacy-preserving option.
- Consent choices are recorded (consent records, target architecture Wave 3) and
  editable; withdrawing consent takes effect immediately for future surfacing.

## 7.3 Data minimization & retention `[PROPOSED]`

- Store only what matching needs: structured intent, approximate location, coarse
  timeframe, non-sensitive tags. No exact address; no precise track.
- **Retention:** resolved/expired Needs and their matches are purged after a
  bounded window `[PROPOSED]` (e.g. 30 days), except minimal safety/audit records
  kept per policy. Users can delete an item and its matches at any time.
- **Analytics** are privacy-preserving: aggregate, no exact location, no
  sensitive inference, no per-user tracking beyond what consent permits.

## 7.4 Sensitive attributes

- Exchange **never infers** religious, health, or other sensitive attributes,
  and never lets a category (e.g. a medical Need) become an advertising or
  personalization profile. Sensitive-category Needs get stronger privacy defaults
  and no proactive broadcast.

## 7.5 Identity exposure

- Matching surfaces a **display identity + reputation**, not a phone number or
  exact profile. What the counterpart sees escalates only through the consent
  gate and, ultimately, the chat the user chooses to open.

## 7.6 Provider boundary

- Any external provider (safety classifier, geocoder, intent/embedding) is reached
  through a **provider-neutral port** with no credential leakage; a provider
  receives the **minimum** (e.g. a coarse origin + query), never a precise fix or
  user identity beyond necessity (ADR-017). Cloud-AI boundaries are visible to the
  user.

## 7.7 Export & deletion

- Users can export and delete their Exchange data (items, matches, messages
  metadata) — part of the platform-wide export/clear/delete guarantee
  (`SPOTME_NEW_PRODUCT_SCOPE` §12).
