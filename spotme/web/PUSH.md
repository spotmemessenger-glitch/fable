# Push notifications

**STATUS: WIRED IN. Dormant until the environment variables below are set.**

With no keys configured, `/api/push` answers `{enabled: false}`, the client never
offers push, and nothing else changes. Setting the variables is what turns it on.

---

## What you must do to switch it on

### 1. Generate a VAPID keypair — do NOT reuse an exposed one

```bash
npx web-push generate-vapid-keys
```

The keypair identifies your server to Apple's and Google's push services. The
private key is a **credential**: it belongs in an environment variable and
nowhere else. Never in the repo, never in a screenshot, never pasted into a
chat. If one has been exposed, generate a new pair and replace it — subscriptions
survive the rotation because the public key is served by `/api/push` rather than
baked into the bundle.

### 2. Create an Upstash Redis database

<https://console.upstash.com> → Create Database → copy the **REST** URL and token.
The REST API is plain HTTPS, which is why this needs no npm package and
`vercel.json` can keep its empty `installCommand`.

### 3. Set five environment variables in Vercel

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | public key from step 1 |
| `VAPID_PRIVATE_KEY` | private key from step 1 — **secret** |
| `VAPID_SUBJECT` | `mailto:spotmemessenger@gmail.com` |
| `UPSTASH_REDIS_REST_URL` | from step 2 |
| `UPSTASH_REDIS_REST_TOKEN` | from step 2 — **secret** |

Redeploy. In Settings → Notifications, "Show notifications" should read
**"On · closed-app alerts"** once allowed.

---

## How it works, given that no server holds messages

Nothing server-side knows a message exists. So the **sender** raises the alarm:

1. Alice sends. `wakeIfUnreachable()` in `lib/rooms.js` sees no live peer.
2. Alice's device POSTs `{action:'notify', toUserId}` to `/api/push`.
3. The server looks up Bob's push endpoint and sends a **payload-free** push.
4. Bob's phone shows "You have something new". He taps; the app opens.
5. The peer connection forms and the message arrives **directly**, as always.

### The limit this leaves

**The poke only happens while the sender still has the app open.** If Alice writes
and immediately closes Spot Me, Bob is alerted but the message waits until both
are online again. Closing that last gap needs the always-on relay peer — that is
the next piece, not a defect in this one.

Groups are deliberately excluded: waking twenty phones per message needs a
fan-out the rate limiter is not shaped for.

---

## The privacy constraint that shapes everything

Push payloads pass through Apple's and Google's push services. Spot Me's premise
is that no server reads messages, so a push carries **no message text and no
sender name** — only "open the app". Content is fetched peer-to-peer after the
tap. That is also why `api/push.js` needs no crypto library: an encrypted payload
would need ECDH + HKDF + AES-GCM, while a payload-free push needs only a signed
ES256 JWT, which is a few lines of WebCrypto.

**What the server does learn**, stated plainly: which push endpoint belongs to
which Spot Me id, and who poked whom, when. That is contact-graph and timing
metadata, not content. Only the endpoint is stored — the subscription's
`p256dh`/`auth` keys exist to encrypt payloads, and there are none, so keeping
them would be hoarding material for a capability this deliberately lacks.

---

## Platform reality

| Situation | Result |
|---|---|
| App open, another chat | tone + vibration + tray notification |
| App backgrounded | tray notification, taps into the right chat |
| App fully closed, sender online | **push** — needs the setup above |
| App fully closed, sender also closed | nothing until both reopen |
| iPhone, Safari tab | **nothing** — iOS grants notifications only to an installed app |
| iPhone, added to Home Screen | works |

iOS is the one users will report as broken. Safari exposes no Notification API
in a tab at all; the app must be added to the Home Screen and opened from there.
Settings says "Add to Home Screen" rather than "Not supported" for this reason.

---

## Files

| File | Role |
|---|---|
| `api/push.js` | subscribe / unsubscribe / notify; VAPID signing; rate limit |
| `src/lib/push.js` | subscription lifecycle, `pokePeer()` |
| `src/lib/notify.js` | local alerts: tone, vibration, tray notification |
| `public/sw.js` | receives the push, shows it, routes the tap |
| `test/push.test.js` | 21 checks, including real signature verification |

## Security notes

- `isPushEndpoint()` restricts pushes to known push services. Without it the
  notify route would be an open relay — any caller could make the server POST
  to a URL of their choosing, carrying our IP and our signature.
- One poke per recipient per 30s. Otherwise anyone who learns an id could ring
  that phone continuously; the push service would throttle us eventually, but
  the victim's battery goes first.
- Subscriptions expire after 90 days untouched, and are deleted on `404`/`410`
  so dead endpoints are not retried forever.
