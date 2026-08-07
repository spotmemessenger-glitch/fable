# IndexedDB availability on iOS — fixes, and one blocker I did not fix

**Date:** 2026-08-07 · **Branch:** `claude/vercel-token-connection-bj4d21`

Items 1–3 are done and fenced. Item 4 is **half done, and the missing half is
the most important thing in this report**. Item 5 I could not do.

---

## THE HEADLINE: with IndexedDB unavailable, the app renders nothing at all

Requirement 4 says the app "must still send and receive". It does not. It shows
a **blank screen** and never reaches onboarding.

Driven in a real browser with IndexedDB replaced by one that behaves the way
iOS private mode does — the global **exists**, every `open()` fails:

| IndexedDB behaviour | onboarding renders | screen |
|---|---|---|
| working (control) | **yes**, 3 inputs | full onboarding |
| `SecurityError` on open | **no** | **blank** |
| open never settles | **no** | **blank** |
| open blocked | **no** | **blank** |

No console error. No page error. It **hangs**, silently — which is why it has
never produced a diagnosable report.

**This is pre-existing, not a regression from this branch.** I built the
unmodified baseline and drove it the same way: also blank. Verified before
claiming it, because the alternative was shipping a regression and calling it a
finding.

I have **not** fixed this. I found it at the end of the mission with the budget
I had left, and a wrong guess at a boot-order fix is worse than an accurate
report. What is known: nothing throws, so it is an unsettled promise blocking
module evaluation, not an exception. `lib/socket-transport.js:871` has a
**top-level `await`**, and a top-level await anywhere in the graph blocks
`main.js` entirely — which matches the symptom exactly (no error, no paint).
That is a lead, not a conclusion; it needs its own session.

Everything below is real and shipped, but on a device with no IndexedDB it is
downstream of a screen that never paints.

---

## 1. The swallowed exception — FIXED

`identity-store.js:163` was:

```js
try { db = await openDb() } catch { openFailed = true; return null }
```

The exception was the only explanation there was, and it was discarded. The
banner then said *"private browsing is the usual cause"* for **every** failure
mode at once — a guess printed as a diagnosis, unfalsifiable because nothing
recorded the truth. Someone whose store had been evicted was told to change a
setting they were not using.

Now: `spotme/web/src/lib/storage-health.js` records the real `name`, `message`,
and phase (`open` / `blocked` / `timeout` / `read`), plus the storage context —
quota, usage, `persisted`, whether localStorage itself works. `explainFailure()`
maps the actual exception to actual advice: `SecurityError` → Block All Cookies
or private browsing; `QuotaExceededError` → device full; blocked → close the
other tab. No blanket guess.

**Two hang paths closed along the way.** `openDb()` handled only `onsuccess`
and `onerror`. It handled neither `onblocked` (another tab on an older version)
nor "iOS suspended the tab mid-open, so nothing fires at all". In both cases the
promise never settled and `loadIdentity()` — which awaits it — waited forever.
From outside that is not "storage failed", it is "the app hung". Both now settle
with a named reason, on a 3 s ceiling.

**`blobstore.available()` was answering a different question.** It returned true
whenever the `indexedDB` *global existed*. In iOS private mode that global
exists and every open fails — so it returned **true on exactly the devices where
it was false**. `store.js` gates `offloadMedia()` on it, so on those devices the
offload ran, silently did nothing, and left the base64 in localStorage. That is
the mechanism joining the two halves of this bug. It now defers to a real probe,
warmed once at boot.

### What actually fails on the owner's iPhone

**I do not know, and I will not guess.** That is the honest answer and it is the
whole reason item 1 came first. The machinery to answer it now exists and did
not before: on the next run the device logs one greppable, PII-free line —

```
STORAGE_UNAVAILABLE {"db":"…","phase":"open","name":"…","message":"…","at":"…"}
```

— and the banner states that reason instead of the private-browsing guess.

## 2. Media never base64s into localStorage — FIXED

A data URL is base64: ~1.33x the file, against a 5–10 MB quota. One 40 MB video
serialised to ~53 MB, `setItem` threw, and the shedding ladder existed to
recover from a write that should never have been attempted. It still had to
destroy somebody's recording to succeed, and it only ran *after* the whole
conversation had failed to persist once.

`stripDerived()` now replaces any un-offloaded `data:` payload with a reference
carrying `memoryOnly: true` and the mime. Bytes stay in memory for the session,
so nothing on screen changes; the disk copy is small. The ladder is **kept** —
a room can still overrun on text alone — but media can no longer reach it.

Chat renders `memoryOnly` as **"Video — not saved on this device"**, deliberately
not a button. The old "tap to load" for something that will never load is what
made people tap repeatedly and report the app as broken.

## 3. Pre-upload check with real numbers — FIXED

`spotme/web/src/lib/media-precheck.js`, wired into both chat send paths.
Refuses before a byte moves, and every message carries the measured numbers:

> That file is 209.0 MB. The limit for a chat attachment is 25.0 MB — trim it,
> or send it at a lower quality.

A zero-byte pick (an iCloud placeholder that has not downloaded) is caught and
named. A video whose duration cannot be read is **allowed through** — refusing
on an unreadable duration would reject exactly the containers least likely to be
at fault. Nothing here says "try again" about something that cannot work.

## 4. Degrade honestly — HALF DONE

The banner half is done: it now states the recorded reason and says plainly that
messages will send but nothing is kept after a reload.

The other half is the blank screen above. **Until that is fixed, requirement 4
is not met**, and the honest summary is: on a device with no IndexedDB, Spot Me
does not degrade — it fails to start.

## 5. Verify on the owner's iPhone — NOT DONE

**I have no access to the owner's phone**, and no amount of headless Chromium
makes that claim true. What I did instead is stated above: a real browser with
IndexedDB forced into each of its three failure modes, plus a working control.
Timings and reload persistence on the actual device are still unmeasured.

---

## The chat video complaint is a SEPARATE bug

> "Videos doesn't upload in chats it takes very long time and it fails and it
> doesn't run in the background it stops if I leave the app"

`media-transfer.js:48`:

```js
export function objectStorageEnabled () {
  try { return localStorage.getItem('spotme.media') === 'object' } catch { return false }
}
```

**Off by default.** So chat attachments do not go to object storage at all. They
go through `rooms.js:713` — 128 KB slices, `await`ed one at a time, over the
socket. A 25 MB video is ~200 sequential round-trips. That is the "very long
time".

And it cannot survive backgrounding: iOS suspends the tab, the socket drops
mid-sequence, and the transfer aborts — *"That transfer did not complete — try
again"*, exactly as in the screenshot. Nothing resumes, because the loop holds
its position only in a live closure.

The direct-to-bucket path already exists and is written; its own comment says it
"has never been exercised between two real devices". Turning it on is the fix,
and it needs a two-device test before it is trusted — not a flag flip in the
dark. Not done here: out of this mission's scope, and it would want its own
verification.

---

## Verification

| | |
|---|---|
| `npm run lint` | clean |
| `npm run build` | ✅ |
| `npm test` | ✅ exit 0 |
| `test/storage-degrade.test.js` (new) | **21/21** |
| `test/store-quota.test.js` (rewritten) | 23/23 |
| `test/viewonce.test.js` (updated) | 21/21 |

Two existing fences encoded the *old* contract and were rewritten to the new
one, deliberately and visibly:

- **store-quota** asserted the shedding ladder shed *their* media before *mine*.
  That ordering was right and the premise was wrong. It now asserts the stronger
  invariant: **not one base64 payload reaches localStorage**, nothing is shed,
  and nobody loses a recording.
- **viewonce** proved its exemption was not vacuous by showing an ordinary photo
  *was* written to localStorage in full. No photo is, now. The proof moved to
  the distinction that still exists: an ordinary photo persists as a recoverable
  reference (`memoryOnly`, mime intact); a view-once photo is `detached` with
  nothing to recover.

**A limit of the new fence, stated plainly:** `storage-degrade.test.js` guards
the contract of a module that did not exist before, so it cannot be shown to
fail against the old code the way a true regression test can. What it does
guard is that the reason survives, that a hung open settles, and that the
refusal names its numbers.

## Recommended order next

1. **The blank screen.** Nothing else on an affected device matters until the
   app starts. Start at the top-level `await` in `socket-transport.js:871`.
2. Have the owner reproduce once on the phone and send the `STORAGE_UNAVAILABLE`
   line — that finally answers "why does it fail on iOS", which item 1 built the
   machinery for and which nothing before this could answer.
3. The chat-video transport, with a real two-device test.
