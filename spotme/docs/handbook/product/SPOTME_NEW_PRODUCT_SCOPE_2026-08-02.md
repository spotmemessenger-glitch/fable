<!--
CANONICAL PRODUCT AUTHORITY — verbatim owner scope.
Source: SPOTME_NEW_PRODUCT_SCOPE (owner upload, 2026-08-02).
This is the owner's PRODUCT SCOPE, not an implementation claim. Per the doc's own
memory instruction, separate: requested scope / planned architecture / implemented
code / real-device validation / production activation. Do not treat any item here
as built unless verified in ../03-IMPLEMENTATION-STATUS.md.
Reproduced verbatim; do not edit the owner's text — annotate in the handbook instead.
-->

SPOT ME — NEW PRODUCT SCOPE
Date: 2026-08-02  
Status: Owner scope captured from today’s discussions  
Purpose: Product requirements only; implementation must follow the canonical migrated architecture document
Memory instruction
This document defines the current product scope requested by the owner. It does not prove that any listed capability is implemented. Future Claude sessions must separate:
requested product scope;
planned architecture;
implemented code;
real-device validation;
production activation.
Do not import superseded scope from old chats unless the owner explicitly reconfirms it.

1. Core communication experience
Spot Me must deliver fast, dependable messaging comparable to the leading global communication apps.
Required capabilities:
instant text messaging;
delivery, sent, read and action receipts;
typing indicators and presence;
replies, reactions, mentions, forwarding and pinning;
private chats, groups, communities, channels and announcements;
media, documents, location, contacts, voice notes and calls;
offline queueing and reliable replay;
multi-device continuity;
strong E2EE identity and safety-number UX;
adaptive transport without asking users to choose a network;
graceful operation on weak or intermittent networks.
Performance goal:
interactions feel immediate;
messages never silently disappear;
switching connectivity does not cause duplicate, reordered or lost messages;
degraded mode is visible and understandable.

2. Translation and voice-preserving communication
2.1 Text translation
translate individual messages;
translate whole conversations;
automatic language and script detection;
transliteration;
glossary and context support;
confidence and uncertainty;
user-selectable privacy mode;
provider routing, failover and cost controls;
cache only when privacy policy permits it.
2.2 Voice-note translation
transcribe a voice note;
translate it;
synthesize the translated audio using the sender’s consented voice profile;
preserve the original audio;
display captions and confidence;
allow voice-profile deletion and replacement.
2.3 Live voice translation
real-time captions;
original and translated captions;
translated speech in the speaker’s consented voice;
interruption and barge-in;
language switching during calls;
captions-before-speech;
original-audio fallback;
one-to-one first, then groups;
clear consent and plaintext-provider boundary;
latency targets measured by language pair and network.

3. Push notification platform
Notifications must support behavior expected from WhatsApp, Telegram, Signal, Messenger and Instagram while respecting device controls.
Required classes:
message;
mention;
reply;
reaction;
knock/contact request;
call and missed call;
group and channel update;
story or nearby activity;
login and security warning;
verification;
silent synchronization.
Required behavior:
default or custom sounds;
mute/silent delivery;
vibration/haptics;
heads-up and lock-screen presentation;
badges;
grouped notifications;
rich actions such as reply, mark read, mute, archive and call accept/decline;
foreground, background and terminated-state handling;
quiet hours, DND and focus allowlists;
content-free by default for E2EE safety;
encrypted rich content only after device-key and security review;
Android, iOS and web support.

4. AI Camera
The camera should compete on speed, quality, creativity and intelligence.
4.1 Professional capture
very fast launch and shutter response;
high-resolution still capture;
HDR;
night mode and low-light stacking;
burst;
portrait/depth-aware blur where hardware or approved models support it;
stabilization;
zoom, focus, exposure, white balance and torch controls where real device capabilities exist;
slow motion, timelapse and high-quality video;
clear refusal when a capability is unavailable rather than fake controls.
4.2 Beauty and appearance
Beauty is a major product requirement.
natural skin smoothing;
tone, warmth and brightness controls;
blemish softening without plastic-looking output;
face-aware adjustments;
teeth and eye enhancements with strict naturalness caps;
makeup looks;
hair-color previews;
glasses and accessories;
face masks and character effects;
user-controlled strength and complete disable option;
no hidden appearance scoring or discriminatory defaults.
4.3 Gesture-reactive AR effects
Examples:
kiss/smooch gesture triggers flying kisses;
wink triggers animated effects;
smile, eyebrow, mouth-open and head-turn triggers;
hand gestures trigger stickers or transitions;
face masks, lenses and world effects;
safe performance degradation on devices without landmark or AR support.
4.4 Filters and transitions
professional color looks;
live preview filters;
story/reel transitions;
background, sky and lighting effects;
stickers, captions and music timing;
saved presets and templates.

5. AI Vision
The camera and uploaded images should support an AI assistant with explicit safety boundaries.
Capabilities:
OCR and document reading;
camera translation;
homework, essay and diagram assistance;
object and product identification;
coin, plant, food, landmark and animal identification;
barcode and QR scanning;
shopping comparison and product information;
screenshot understanding;
visual question answering;
photo organization and search;
accessibility descriptions.
Health-related visual information:
may describe visible features and general educational possibilities;
must show uncertainty and limitations;
must never claim a medical diagnosis;
must identify urgent red flags and encourage professional care;
must not infer sensitive health profiles for advertising or passive personalization.

6. Creative Studio
6.1 Photo editor
non-destructive editing;
undo/history;
exposure, contrast, color, curves, highlights and shadows;
crop, rotate, straighten and perspective correction;
sharpness, clarity, grain and vignette;
object removal;
background removal/replacement;
sky replacement;
relighting;
collages and templates;
export quality controls.
6.2 Video, stories and reels
timeline editor;
trim, split, reorder and speed;
transitions;
captions and translated captions;
filters and overlays;
music and voice tracks;
voice-preserved translation;
templates;
draft storage;
background export;
story/reel formats and sharing.

7. Discovery V2 — interactive local map
7.1 Default “Happening Around You” experience
The Discovery screen must not feel empty.
By default, show useful activity within 10 km:
cultural events;
concerts and DJ parties;
food events and festivals;
sports and community activities;
exhibitions;
popular attractions;
trending places;
nightlife;
family-friendly activities;
relevant nearby community posts.
If results are insufficient, expand transparently through configurable radii such as 15 km, 25 km, 50 km and 100 km. The app must tell the user when it expands.
7.2 Place and service search
Users can search for any supported category, including:
restaurants and specific dishes such as mutton biryani;
vegetarian, vegan, Jain, halal and other explicitly selected food needs;
cafés, juice shops, bakeries and street food;
bars, pubs and nightlife;
parks and tourist attractions;
hotels and lodging;
hospitals, clinics, pharmacies and medical specialties;
banks and ATMs;
fuel stations and EV chargers;
shopping and services;
events and venues.
7.3 Map experience
map expands to full or near-full screen after search;
smooth zoom and fit-to-results;
rich pins and clusters;
selected pin synchronized with a swipeable result card;
draggable bottom sheet;
best-first list;
alternative sorts for distance, rating, open now, price and review volume;
route, ETA and distance;
saved places, share, call, website, reserve or book where supported;
Snapchat-like visual polish without copying proprietary assets.
7.4 Voice map assistant
A microphone inside map search should support natural questions such as:
“Show the best orthopedic hospitals nearby.”
“Find vegetarian restaurants within five kilometres.”
“What events are happening tonight?”
“How far is Bangalore from here?”
“Show petrol stations on my route.”
Requirements:
partial and final transcript;
language detection;
permission handling;
text fallback;
route questions use a directions/distance provider, not an unlabeled straight-line estimate.
7.5 Reviews and result summaries
Use only authorized data:
official map/provider reviews where permitted;
Spot Me user reviews;
Spot Me photos and videos;
legal embeds or links from public external platforms where supported.
Do not scrape Instagram, Facebook, Snapchat, YouTube or Google.
AI summaries may provide:
best for;
common positives;
common negatives;
best time to visit;
confidence;
number and source of reviews.
They must say “insufficient evidence” instead of inventing a conclusion.
7.6 Personalization
Personalization is opt-in and editable.
Examples:
dietary preferences;
favorite cuisines;
budget;
family-friendly preference;
accessibility needs;
nightlife preference;
travel interests;
preferred radius;
saved and hidden categories.
Sensitive religious or health attributes must not be inferred. Medical searches must not become a passive advertising profile.

8. Nearby social feed, photos and videos
Create a local visual feed integrated with Discovery.
Capabilities:
nearby photos and videos;
scrollable feed;
stories and short videos;
like, comment, save and share;
follow creators and places;
location-tagged posts with privacy controls;
approximate/coarse location by default;
local trends and event coverage;
creator tools from the Camera and Studio;
moderation, block, report and appeals;
age and safety controls;
optional friends-only and community modes.
The feed should connect content to the map without exposing a poster’s precise live location.

9. AI recommendation feed
Spot Me AI may create explainable recommendations such as:
“Because you liked South Indian food…”
“Trending near you.”
“Popular this evening.”
“Friends visited recently,” subject to privacy permissions.
“Quiet cafés open now.”
“Vegetarian options near your route.”
Requirements:
explanation for every recommendation;
user controls to edit or reset preferences;
no sensitive inference;
no hidden manipulation;
sponsored content clearly marked and separated from organic relevance.
The goal is sustained usefulness and enjoyment, not harmful compulsive engagement.

10. Revenue model
10.1 Consumer plans
Suggested product structure:
Free: secure chat, basic calling, limited translation trials, limited AI camera/vision usage and normal Discovery.
Plus: larger translation allowance, voice-note translation, advanced camera tools, more studio exports, higher AI limits and saved preferences.
Pro/Creator: higher-resolution exports, advanced AI effects, creator analytics, premium templates, larger storage and priority processing.
Usage credits: optional pay-as-you-go for costly voice clone, live translation, cloud vision, TTS and high-resolution AI processing.
Chat and core safety functions should remain usable without an AI subscription.
10.2 Local commerce and discovery revenue
sponsored pins and listings, clearly labeled;
promoted events;
coupons and offers;
restaurant reservations;
ticket commissions;
hotel and activity affiliate fees;
business subscriptions;
verified business pages;
business analytics;
creator-brand marketplace;
local advertising with strict privacy controls.
Paid placement must never silently override relevance or safety.
10.3 Business and enterprise
organization accounts;
managed devices;
business messaging;
customer-support inboxes;
audit logs;
compliance features;
API and webhook plans;
moderation and analytics tools.

11. Autonomous 24/7 agent organization
Spot Me should eventually operate with a controlled multi-agent system.
11.1 Core leadership agents
Chief Orchestrator / Spot Me Brain
CTO agent
CPO/Product agent
CISO/Security agent
SRE/Operations lead
CFO/Cost-governance agent
CMO/Growth agent
Legal/Privacy policy agent, advisory only
11.2 Engineering and operations agents
backend;
web/mobile frontend;
database;
realtime;
cryptography;
media;
calls;
notifications;
translation and voice;
camera/vision/AR;
discovery/maps;
QA;
performance;
accessibility;
DevOps;
incident response;
documentation;
support and moderation.
11.3 Operating rules
agents are event-driven, not continuously wasting tokens;
local models handle repetitive low-risk tasks;
stronger cloud models handle complex reasoning and independent review;
read-only diagnosis may be automatic;
code changes go to isolated branches and draft PRs;
production changes require policy-based approval;
dangerous actions require human confirmation;
complete audit logs and rollback are mandatory;
two independent reviewers for security, crypto, billing and data deletion;
no agent may hide an alert or mark its own unverified claim as evidence.

12. Safety, privacy and trust requirements
E2EE remains a central guarantee.
Exact user location is private by default.
Nearby discovery uses coarse or consented location.
Location history is off by default.
Voice cloning requires explicit enrollment and deletion controls.
Cloud AI boundaries are visible.
Medical visual assistance is non-diagnostic.
Children and vulnerable users require stronger defaults.
Sponsorship is always labeled.
Moderation includes report, block, appeals and evidence handling.
Data collection must be minimized and retention bounded.
Users can export, clear and delete their data.

13. Global readiness
The product must support:
multilingual UI;
RTL languages;
localized dates, times, numbers and currencies;
metric and imperial units;
low-bandwidth operation;
accessible navigation and screen readers;
dynamic text and high contrast;
reduced motion;
keyboard and switch access where applicable;
regional provider routing and compliance;
Android, iOS, web and later desktop.

14. Product delivery order
Recommended order for the new migrated build:
1.  Migrated platform foundation and security.
2.  Core chat, realtime, media and notifications.
3.  Text translation and voice-note translation.
4.  Live voice translation.
5.  Camera engine and Creative Studio.
6.  AI Vision, beauty, masks and gesture AR.
7.  Discovery places/events and voice map assistant.
8.  Nearby social feed and creator system.
9.  Monetization and business tools.
10.  Autonomous operations agents.
11.  Global launch hardening.

15. Instruction to future Claude sessions
Treat this document as the owner’s current product scope. Do not claim these capabilities are implemented unless verified in the migrated repository. Before building any item, map it to the canonical migrated architecture, identify owner decisions and legal/provider dependencies, split work into reviewable draft PRs, keep all new flags OFF, provide exact evidence, and stop before merge or activation.