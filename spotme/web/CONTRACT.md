# Spot Me web — view module contract

You are building ONE view module for a working P2P messenger. The shell
(`src/main.js`), state, transport, and design tokens already exist. Read this
whole file before writing code.

## Hard rules

1. **JavaScript, not TypeScript.** ESM. No frameworks, no dependencies.
2. Your module: `src/views/<name>.js` exporting
   `export function render (root, ctx) { ... return cleanup }`
   - `root`: an empty `<div class="view">` (flex column, fills the screen
     above the bottom nav). Build your DOM under it.
   - `ctx`: `{ nav(path), openThread(roomId), toast(msg) }`
   - Return a cleanup function that unsubscribes everything you subscribed to
     and clears any timers. (The chat view alone receives a third arg.)
3. Your CSS: `src/views/<name>.css`, imported at the top of your JS
   (`import './<name>.css'`). **Every selector must live under your namespace
   class `.v-<name>`** (e.g. `.v-inbox .row`). The root element you create
   must carry that class. Shared classes from tokens.css (`.av`, `.pill`,
   `.scroll-y`, `.toast`, action sheets) are available and NOT namespaced.
4. **Do NOT render the bottom nav** — the shell owns it.
5. **Design fidelity is the point.** Your screen's locked design is an HTML
   file in `spotme/design/`. Open it, lift its structure and CSS (rename the
   wrapper to `.v-<name>`, drop the desktop `.page/.stage/.notes` scaffolding
   and the `.phone` frame border/size — your view IS the phone, full-viewport).
   Base64 photos in the design are demo-people avatars; in the app they come
   from data (`person.avatar`), never hardcoded.
6. Colour roles are LOCKED: black `var(--ink)` = commit actions; blue
   `var(--blue)` = information/state (unread, active, distance); red on
   `var(--redwell)` = Reject/destructive only; green = presence + Bluetooth.
7. Empty states for every list. No console.log. Handle errors with
   `ctx.toast(...)`.
8. **GateGuard:** the first Write of any new file may be rejected with a
   "[Fact-Forcing Gate]" error. State the 4 requested facts in your next
   message and retry the SAME Write — it passes on the second attempt.

## Libraries (exact APIs — import what you need)

### `../lib/db.js` → `{ db, randomHex }`
- `db.ready()`, `db.profile()` → `{id,name,lang,avatar,translit,autoTranslate}`
- `db.setProfile(patch)`
- `db.convos()` sorted; `db.convo(roomId)`; `db.upsertConvo(convo)`;
  `db.removeConvo(roomId)`; `db.setArchived(roomId,bool)`
- convo: `{roomId, secret, kind:'dm'|'group'|'demo', mode:'meet'|'nearby'|'bluetooth',
   peer:{id,name,avatar,lang}, title, created, archived, unread, pending,
   last:{text,ts,fromMe}}`
- `db.requests()` → `[{fromId,name,avatar,lang,text,roomId,secret,mode,ts}]`;
  `db.removeRequest(fromId)`
- `db.contacts()`, `db.addContact(c)`, `db.removeContact(id)`
- `db.block(id,name)`, `db.unblock(id)`, `db.isBlocked(id)`, `db.blocked()`
- `db.settings()` → `{rangeM, showOnMap, demoMode, readAloud, enterSends}`;
  `db.setSettings(patch)`
- `db.totalUnread()`; `db.subscribe(fn)` → unsub
- `db.setOpenRoom(roomId|null)` — chat view only.

### `../lib/discovery.js` → `{ lobby, distanceM, fmtDistance, coarse }`
- `lobby.start()` (already called by shell), `lobby.peers()` →
  `[{id,name,avatar,lang,lat,lon,ghost,ts,peerId}]` (real people online now)
- `lobby.request(peer, text, mode)` → roomId (creates pending convo, sends request)
- `lobby.accept(request)` / `lobby.decline(request)` (request object from db.requests())
- `lobby.myPosition()` → `{lat,lon}|null`; `lobby.refreshPosition()`;
  `lobby.announce()`; `lobby.subscribe(fn)` → unsub
- `distanceM(a,b)` → metres|null; `fmtDistance(m)` → `"~24 m"|"~1.2 km"|null`

### `../lib/rooms.js` → `{ rooms }`
- `rooms.ensure(roomId)` → conn `{store, net, peerCount, typing:{name,until}|null,
   readUpTo, seenByPeer:Set, on(fn)→unsub}`; conn events:
  `{type:'message'|'history'|'reaction'|'deleted'|'expired'|'typing'|'read'|'seen'|'peers', ...}`
- `conn.store.list()` → messages `[{id,from,name,lang,ts,kind,text,data,fileName,
   fileSize,dur,lat,lon,replyTo,viewOnce,ttl,reactions:[{from,emoji}]}]`
   (kind: 'text'|'image'|'voice'|'file'|'location')
- `rooms.sendMessage(roomId, partial)` → sends + persists; e.g.
  `rooms.sendMessage(id, {text:'hi'})`,
  `rooms.sendMessage(id, {kind:'image', data:dataURL, viewOnce:true})`,
  `rooms.sendMessage(id, {kind:'voice', data, dur})`,
  `rooms.sendMessage(id, {kind:'location', lat, lon})`,
  `{kind:'file', data, fileName, fileSize}`, `{text, ttl: seconds}`
- `rooms.deleteMessage(roomId, id)` (delete for everyone, no residue)
- `rooms.react(roomId, targetId, emoji)`; `rooms.typing(roomId, on)`;
  `rooms.markRead(roomId)`; `rooms.viewOnceOpened(roomId, id)`;
  `rooms.leave(roomId)`; `rooms.connectAll()`

### `../lib/translate.js` → `{ translateText, LANGS, langName, speak, dictate }`
- `await translateText(text, fromLang, toLang)` → `{text, engine:'device'|'cloud'|null}`
- `LANGS` = `[{code,name,native}]`; `langName('ta')` → 'Tamil'
- `speak(text, lang)` → bool; `dictate(lang, onResult(text,isFinal), onEnd)` → rec|null

### `../lib/media.js`
- `await compressImage(file, maxEdge?, q?)` → `{dataURL,width,height}`
- `await fileToDataURL(file)` → `{dataURL,name,size}` (throws over ~2.5 MB)
- `await recordVoice()` → `{stop()→Promise<{dataURL,dur,size}>, cancel()}`
- `await currentLocation()` → `{lat,lon}`; `mapLink(lat,lon)` → OSM URL

### `../lib/demo.js` → `{ DEMO_PEOPLE, demoPeers, isDemo }`
- `demoPeers(myPos)` → discovery-shaped peers with `demo:true`, positioned near
  the user. Show a small "demo" chip on any demo person. Only include them
  when `db.settings().demoMode` is true.
- To start a chat with a demo person: `db.upsertConvo({roomId:'demo-'+randomHex(6),
   secret:'x', kind:'demo', mode:<mode>, peer:{id:person.id,name,avatar,lang},
   title:person.name})` then `rooms.ensure(roomId)` then `ctx.openThread(roomId)`.

### `../lib/ui.js` → `{ el, clear, toast, avatar, fmtTime, fmtDay, actionSheet }`
- `el(tag, {class,text,html,style,onClick,...}, [children])`
- `avatar(person, sizePx, {dot:true})` → locked-design avatar (photo or
  gradient initials + green presence dot)
- `actionSheet([{label, danger:true, fn}], title?)` → Promise

### `spotme-core/core/translit.js` → `{ transliterate, supportedScripts }`
- `transliterate('vanakkam', 'ta')` → Tamil script. Apply at SEND time.
- `supportedScripts()` → `[{code,...}]` (currently ta, hi families)

## Modes & tabs (product logic)
- convo.mode: `'meet'` (username/link chats — "General" tab), `'nearby'`
  (Discovery requests), `'bluetooth'` (mesh preview chats).
- Inbox tabs General/Nearby/Bluetooth filter by those modes.

## Honesty rules (verbatim product decisions)
- Distances always carry a tilde ("~24 m") — positions are coarse by design.
- Demo people always carry a "demo" chip.
- View-once / delete / timers are cooperative — never claim more than that.
  The Settings screen carries the honesty copy; other screens stay clean.
- Calls (voice/video) are NOT in the web build: tapping shows a toast
  "Calls arrive with the native app". Do not fake a call UI.
