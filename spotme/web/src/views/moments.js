/**
 * Spot Me — Moments (#/posts): the feed, the stories ring row, the composer
 * and the reels viewer.
 *
 * ONE SCREEN, THREE MODES. Instagram/Messenger shape, deliberately: stories
 * are the ring row at the TOP OF THE FEED, never a bottom-bar tab (M6), and
 * reels are a full-bleed vertical viewer entered from a video card rather than
 * a separate destination. That keeps the bottom bar at five slots and matches
 * what people already know.
 *
 * WHAT THIS SCREEN WILL NOT SHOW, and it is not an oversight:
 *  - NO like/reaction COUNTERS. Reactions exist and are recorded; tallies are
 *    deliberately absent from the contract (the server refuses `likeCount`
 *    and friends as unsupported fields). A number next to a post is the thing
 *    that turns posting into scorekeeping, and the product decision is to not
 *    have one. If this ever needs a count, it is an owner decision first.
 *  - NO private posts from anyone else. `private` is excluded server-side and
 *    never reaches a feed; nothing here filters for it, because nothing here
 *    should ever receive one.
 *
 * The surface is gated by the SERVER: every call 404s while the `moments`
 * domain is dark, and this view renders an explicit "not available" state
 * rather than a broken screen.
 */

import './moments.css'
import { db } from '../lib/db.js'
import { el, clear, avatar, actionSheet } from '../lib/ui.js'
import * as M from '../lib/moments-api.js'
import { videoEl, watchInView, playExclusive, pause, pauseAll, isSoundOn, setSoundOn, onSoundChange } from '../lib/video.js'
import { likeBurst, tick, onDoubleTap } from '../lib/burst.js'
import { openPhotoEditor } from '../lib/photoedit.js'
import { fileToDataURL, fileFromDataURL } from '../lib/media.js'

/**
 * The card's icon set, in the SAME grammar as the bottom bar (see NAV_ITEMS in
 * main.js): a 24px grid, `currentColor`, outline by default at stroke-width
 * 1.8, and a solid fill only to mark an active state. The emoji row this
 * replaces could not do any of that — emoji render in the system's colours and
 * at the system's weight, so 🤍 next to 💬 next to ↗️ arrived as three
 * different design languages stacked in one row, and none of them could show
 * "on".
 */
const STROKE = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
const HEART_D = 'M12 20.1c-.5 0-8-4.6-8-9.6a4.4 4.4 0 018-2.6 4.4 4.4 0 018 2.6c0 5-7.5 9.6-8 9.6z'
const ICONS = {
  // Outline heart, and the same silhouette filled for a reaction that is on —
  // one shape in two states, so the change reads as the same control.
  react: `<svg ${STROKE}><path d="${HEART_D}"/></svg>`,
  reactOn: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="${HEART_D}"/></svg>`,
  comment: `<svg ${STROKE}><path d="M20 11.9a7.6 7.6 0 01-10.9 6.9L4.6 20l1.3-4.6A7.6 7.6 0 1120 11.9z"/></svg>`,
  share: `<svg ${STROKE}><path d="M12 15.2V3.9"/><path d="M8.3 7.6L12 3.9l3.7 3.7"/><path d="M5.8 13v5.4a1.7 1.7 0 001.7 1.7h9a1.7 1.7 0 001.7-1.7V13"/></svg>`,
  // Dots take a solid fill because a 1.4px-radius ring reads as mush at 24px —
  // the bar's Posts glyph solves its own small dot the same way.
  more: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.4" cy="12" r="1.5"/></svg>`,
  soundOff: `<svg ${STROKE}><path d="M4.5 9.4v5.2h3.2l4.1 3.3V6.1L7.7 9.4H4.5z"/><path d="M16.4 9.8l4.1 4.4M20.5 9.8l-4.1 4.4"/></svg>`,
  soundOn: `<svg ${STROKE}><path d="M4.5 9.4v5.2h3.2l4.1 3.3V6.1L7.7 9.4H4.5z"/><path d="M15.6 9.2a3.9 3.9 0 010 5.6"/><path d="M18.2 6.8a7.4 7.4 0 010 10.4"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.4 5.7a.9.9 0 011.36-.77l8.1 5.5a.9.9 0 010 1.5l-8.1 5.5a.9.9 0 01-1.36-.77V5.7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/></svg>`,
  /* Back is a CHEVRON, not a cross. A cross says "dismiss this thing"; the
   * reels viewer is a place you went from the feed, and a chevron is what says
   * "the feed is still behind me" — which is where the gesture actually goes. */
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  save: `<svg ${STROKE}><path d="M6.5 4.2h11a.8.8 0 01.8.8v14.3l-6.3-3.6-6.3 3.6V5a.8.8 0 01.8-.8z"/></svg>`,
  saveOn: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6.5 4.2h11a.8.8 0 01.8.8v14.3l-6.3-3.6-6.3 3.6V5a.8.8 0 01.8-.8z"/></svg>`,
  /* ±10s: an arrow that curls back on itself, with the number sitting inside
   * the curl. The glyph carries the interval so the control needs no label. */
  back10: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11.8 6.2V2.9L7.4 6.2l4.4 3.3V6.2a6.4 6.4 0 11-6.3 7.5"/><text x="12" y="17.6" font-size="7.4" font-family="system-ui,sans-serif" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none">10</text></svg>`,
  fwd10: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12.2 6.2V2.9l4.4 3.3-4.4 3.3V6.2a6.4 6.4 0 106.3 7.5"/><text x="12" y="17.6" font-size="7.4" font-family="system-ui,sans-serif" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none">10</text></svg>`
}

/* SAVED POSTS ARE DEVICE-LOCAL, and that is a limitation rather than a design
 * choice: the Moments API has no save/bookmark route to call (no endpoint, no
 * column). The control is in the rail because the reels contract asks for it,
 * and it does the only honest thing available — remembers on this device. When
 * a server-side collection exists this becomes a call and the key retires. */
const SAVED_KEY = 'spotme.moments.saved'
const readSaved = () => {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')) } catch { return new Set() }
}
const writeSaved = (set) => {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify([...set])) } catch { /* private mode */ }
}

const FEED_MODES = [
  { key: 'nearby', label: 'Nearby' },
  { key: 'friends', label: 'Friends' },
  /* `global` is what makes `public` a real choice. Without it a post marked
   * public reached the same people a nearby post did, so the option meant
   * nothing and was removed from the composer. The tab and the audience go in
   * together, deliberately — shipping the option without the surface is how it
   * became dead the first time. */
  { key: 'global', label: 'Everyone' }
]
/** The closed reaction registry — same list the server accepts. */
const REACTIONS = [
  { key: 'like', glyph: '👍' }, { key: 'love', glyph: '❤️' }, { key: 'laugh', glyph: '😂' },
  { key: 'wow', glyph: '😮' }, { key: 'support', glyph: '🫶' }
]
/* Display label -> the reason string the server stores. 'child-safety' is the
 * one machine key the backend's MANDATORY priority lane keys on (M6); the rest
 * are free text. Surfacing it as its own option is the only way a client can
 * ever trigger that lane. */
const REPORT_REASONS = [
  { label: 'Child sexual abuse / a minor', reason: 'child-safety' },
  { label: 'Nudity or sexual content', reason: 'Nudity or sexual content' },
  { label: 'Violence', reason: 'Violence' },
  { label: 'Harassment', reason: 'Harassment' },
  { label: 'Spam or scam', reason: 'Spam or scam' },
  { label: 'Something else', reason: 'Something else' }
]
/** Beyond this a video is a long clip, and the poster/preload story changes. */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/* -------------------------------------------------- perf harness (M3) */

/**
 * The measurement overlay, activated ONLY by `spotme-perf` in the query
 * string (e.g. https://…/?spotme-perf#/posts). It is the same instrument on
 * every device — my throttled-emulation numbers and the owner's real-phone
 * numbers come from identical code, so they are comparable and neither is
 * dressed up as the other. Measures, per reel video:
 *   TTFF  — ms from "this pane became active" to the first 'playing' event
 *   stalls — count of 'waiting' events after first frame (rebuffering)
 * and summarises median TTFF + stall rate across everything played so far.
 */
const PERF = (() => {
  try { return new URLSearchParams(location.search).has('spotme-perf') } catch { return false }
})()

function perfHarness (root) {
  if (!PERF) return { attach: () => {}, activated: () => {} }
  const rows = new Map()   // mediaId -> {t0, ttff, stalls, el}
  const panel = el('div', {
    style: 'position:fixed;top:8px;left:8px;right:8px;z-index:99;background:rgba(0,0,0,.82);color:#7CFC98;' +
      'font:11px/1.5 monospace;padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre'
  })
  root.appendChild(panel)
  const draw = () => {
    const done = [...rows.values()].filter((r) => r.ttff != null)
    const ttffs = done.map((r) => r.ttff).sort((a, b) => a - b)
    const median = ttffs.length ? ttffs[Math.floor(ttffs.length / 2)] : null
    const stalled = done.filter((r) => r.stalls > 0).length
    panel.textContent =
      `SPOTME PERF  videos:${done.length}  medianTTFF:${median != null ? median + 'ms' : '—'}  ` +
      `stallRate:${done.length ? Math.round((stalled / done.length) * 100) + '%' : '—'}\n` +
      [...rows.values()].slice(-6).map((r) =>
        `${r.name}  ttff:${r.ttff != null ? r.ttff + 'ms' : '…'}  stalls:${r.stalls}`).join('\n')
  }
  return {
    attach (video, name) {
      const row = { name, t0: null, ttff: null, stalls: 0 }
      rows.set(name, row)
      video.addEventListener('playing', () => {
        if (row.t0 != null && row.ttff == null) { row.ttff = Math.round(performance.now() - row.t0); draw() }
      })
      video.addEventListener('waiting', () => {
        if (row.ttff != null) { row.stalls++; draw() }
      })
    },
    activated (name) {
      const row = rows.get(name)
      if (row && row.t0 == null) { row.t0 = performance.now(); draw() }
    }
  }
}

export function render (root, ctx, params) {
  /* `#/posts?m=<id>` — the link the Share button on a post produces. With an
   * id present this screen shows THAT post rather than a feed, because the
   * whole reason to send someone a link is that the post is not necessarily
   * in the feed they would otherwise get. */
  let focusId = (params && params.get('m')) || null
  let mode = 'nearby'
  let items = []
  let stories = []
  let cursor = null
  let state = 'loading'        // loading | ok | empty | unavailable | forbidden | failed
  let detail = ''
  const assetCache = new Map() // mediaId -> Promise<{url,posterUrl,width,height}|null>
  let disposed = false
  let reelsCleanup = null

  /* The feed's video wiring, rebuilt on every draw. `feedVids` is in DOM order
   * so a card can preload its NEIGHBOURS without asking the DOM where it is. */
  let feedVids = []
  let feedIO = null
  let unsubSound = null
  /* Which media slots are on screen RIGHT NOW. The observer and the asset
   * fetch race each other — whichever lands second is the one that can
   * actually start playback, so both have to check the other's result. */
  let inView = new Set()

  const head = el('div', { class: 'mo-head' })
  const railWrap = el('div', { class: 'mo-rail' })
  const list = el('div', { class: 'mo-list' })
  const wrap = el('div', { class: 'mo-wrap scroll-y' }, [head, railWrap, list])
  root.appendChild(wrap)

  /* ------------------------------------------------------------- helpers */

  /**
   * How a person is NAMED on a story.
   *
   * The handle, not the profile name. A story is a claim about who posted it,
   * and `@username` is the identifier that is unique, stable and searchable in
   * this app — a display name is neither, and two people may share one. Falls
   * back to the display name when an account has claimed no username, and never
   * to `userId`, which is an internal id nobody should be shown.
   */
  const handleOf = (author) =>
    (author?.username ? `@${author.username}` : null) || author?.displayName || 'Someone'

  /* A4 — ONE VOCABULARY FOR AUDIENCE, USED BY THE PICKER AND THE BADGE.
   *
   * `private` used to be offered in the picker and then rendered nowhere,
   * because the feed query excluded it for every viewer INCLUDING THE AUTHOR —
   * so choosing it silently threw the post away. It is now "Only you", which is
   * what it does, and A1 makes that true in the query.
   *
   * `public` IS OFFERED AGAIN — owner decision, 2026-08-07, now that the
   * Everyone tab exists to reach it. The history is kept because the reason it
   * left is the reason it may not leave the tab behind again.
   *
   * IT WAS REMOVED because it and `nearby` were indistinguishable in practice:
   * both surfaced in the nearby feed, both bounded by the same radius. Two
   * options with one behaviour is worse than one option, because it asks the
   * reader to choose between things that are not different.
   *
   * IT IS BACK because the `global` feed mode now exists — a query with no
   * geographic predicate at all — and the Everyone tab reaches it. `public` now
   * means something `nearby` cannot: anywhere in the world.
   *
   * THE RULE THAT FOLLOWS FROM BOTH: the option and the surface ship together.
   * If the Everyone tab is ever removed, `public` leaves the picker in the same
   * commit, or it becomes dead again exactly as before.
   *
   * `public` never left the database enum, the backend policy or this map, so
   * posts stored while it was unpickable kept working and kept their badge —
   * which is why restoring it needed no migration and no backfill.
   */
  const AUDIENCE = {
    nearby: { label: 'Nearby', hint: 'People near you' },
    friends: { label: 'Friends', hint: 'People who follow you' },
    public: { label: 'Public', hint: 'Anyone, anywhere in the world' },
    private: { label: 'Only you', hint: 'Nobody else can see this' }
  }

  /* What the composer offers. Kept as its own list rather than derived from
   * AUDIENCE: the two coincide today, and the reason they were allowed to
   * diverge — a value that must still RENDER after it stops being SELECTABLE —
   * is a distinction worth keeping expressible. */
  const PICKABLE = ['nearby', 'friends', 'public', 'private']

  const audienceBadge = (v) => {
    const a = AUDIENCE[v] || AUDIENCE.nearby
    return el('span', {
      class: `mo-aud is-${v || 'nearby'}`,
      text: a.label,
      title: a.hint,
      'aria-label': `Audience: ${a.label}. ${a.hint}`
    })
  }

  /** Resolve one asset to its short-lived URL bundle, once. */
  function assetFor (mediaId) {
    if (assetCache.has(mediaId)) return assetCache.get(mediaId)
    const p = M.assetUrl(mediaId).then((r) => (r && r.url ? r : null)).catch(() => null)
    assetCache.set(mediaId, p)
    return p
  }

  /* THE LOCATION LINE.
   *
   * `coarseCell` is an internal grid id. The server builds it as `g<lat>:<lon>`
   * (discovery.policy.ts) so rows in the same cell can be grouped and notified
   * together — it is not a place name, it was never meant to be read, and it
   * was being printed to people verbatim as "g11.933:79.808".
   *
   * Worse than ugly: it is a COORDINATE. Rounded to a ~110 m grid, but a
   * coordinate all the same, and the entire point of that rounding is that a
   * precise fix never leaves the device. Printing the cell handed back a good
   * part of what the rounding was there to protect.
   *
   * A post either carries a location or it does not, and the only honest thing
   * this screen can say about one it cannot name is that it is nearby. */
  const place = (m) => (m.coarseCell ? 'Nearby' : null)

  /* Aspect clamps for the reserved media box. A 9:16 phone clip is the tallest
   * thing worth showing inline — past that a single post owns the whole screen
   * and the feed stops reading as a feed. */
  const AR_MIN = 0.5625
  const AR_MAX = 1.91

  const when = (ts) => {
    const mins = Math.max(0, Math.round((Date.now() - Number(ts)) / 60000))
    if (mins < 1) return 'now'
    if (mins < 60) return `${mins}m`
    if (mins < 1440) return `${Math.round(mins / 60)}h`
    return `${Math.round(mins / 1440)}d`
  }

  /* ---------------------------------------------------------------- load */

  /**
   * A shared link resolves against the by-id route, NOT against a feed page.
   * Filtering the feed client-side would only ever find posts the viewer was
   * already going to be shown, which is precisely the case where a link is not
   * needed. The server applies the same tier rules either way, so this grants
   * no extra access — a post the viewer may not see 404s and says so.
   */
  async function loadFocused () {
    state = 'loading'; cursor = null; items = []; draw()
    try {
      const view = await M.momentById(focusId)
      items = view ? [view] : []
      state = items.length ? 'ok' : 'notfound'
    } catch (e) {
      if (e instanceof M.MomentNotFoundError) state = 'notfound'
      else if (e instanceof M.MomentsDisabledError) state = 'unavailable'
      else if (e instanceof M.MomentsForbiddenError) { state = 'forbidden'; detail = e.message } else { state = 'failed'; detail = e.message }
    }
    draw()
  }

  /** Leave the single-post view. Navigating rather than mutating state drops
   *  the `?m=` from the URL too, so a reload or a Back press lands on the feed
   *  instead of silently re-opening the post. */
  function clearFocus () { ctx.nav('#/posts') }

  async function load (reset = true) {
    if (focusId) return loadFocused()
    if (reset) { state = 'loading'; cursor = null; draw() }
    try {
      // Location is attached ONLY for the nearby feed, and only coarsely —
      // the client rounds before sending and the server refuses anything
      // finer, so a precise fix cannot leak through this path.
      let origin = null
      if (mode === 'nearby') origin = await coarseFix()
      const page = await M.feed({ mode, origin, cursor })
      const got = page?.results || []
      items = reset ? got : items.concat(got)
      cursor = page?.cursor || null
      state = items.length ? 'ok' : 'empty'
      loadStories()
    } catch (e) {
      if (e instanceof M.MomentsDisabledError) { state = 'unavailable' } else if (e instanceof M.MomentsForbiddenError) { state = 'forbidden'; detail = e.message } else { state = 'failed'; detail = e.message }
    }
    draw()
  }

  async function loadStories () {
    try {
      const rail = await M.storiesRail()
      stories = rail?.results || rail?.stories || []
    } catch { stories = [] }
    drawRail()
  }

  /** A coarse fix (3-decimal grid ≈ 110 m), or null. Never the precise one:
   *  the raw device fix is rounded HERE, and the API layer rounds again at the
   *  wire as a backstop (moments-api feed()). See discovery.js. */
  function coarseFix () {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null)
      const c3 = (n) => Math.round(n * 1000) / 1000
      /* BOUNDED BY US, not just by the API. `getCurrentPosition`'s own
       * `timeout` starts when the browser begins LOCATING, and does not cover
       * the permission prompt sitting unanswered in front of it — so someone
       * who ignores that dialog gets neither callback, ever, and the feed
       * behind it stays on "Loading…" for as long as they look at it.
       *
       * Whoever answers first wins, and a missing fix is not an error: the
       * nearby feed simply loads without an origin, exactly as it does when
       * permission is refused outright. */
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      setTimeout(() => finish(null), 7000)
      navigator.geolocation.getCurrentPosition(
        (pos) => finish({ lat: c3(pos.coords.latitude), lon: c3(pos.coords.longitude) }),
        () => finish(null),
        { timeout: 6000, maximumAge: 300000 }
      )
    })
  }

  /* ---------------------------------------------------------------- draw */

  function drawHead () {
    clear(head)
    /* Single-post view: a back affordance instead of the feed tabs. Leaving
     * the tabs visible would offer a "Nearby / Following" choice that this
     * screen cannot honour — one post has no feed mode. */
    if (focusId) {
      head.appendChild(el('button', {
        // NOT `mo-back` — that class is the sheet backdrop (fixed, inset 0).
        class: 'mo-backbtn', type: 'button', 'aria-label': 'Back to posts', text: '‹',
        onclick: clearFocus
      }))
      head.appendChild(el('h1', { class: 'mo-title', text: 'Post' }))
      return
    }
    head.appendChild(el('h1', { class: 'mo-title', text: 'Posts' }))
    const tabs = el('div', { class: 'mo-tabs' })
    for (const m of FEED_MODES) {
      tabs.appendChild(el('button', {
        class: 'mo-tab' + (m.key === mode ? ' on' : ''), type: 'button', text: m.label,
        onclick: () => { if (mode === m.key) return; mode = m.key; load(true) }
      }))
    }
    head.appendChild(tabs)
    head.appendChild(el('button', {
      class: 'mo-new', type: 'button', 'aria-label': 'New post', text: '＋',
      onclick: openComposer
    }))
  }

  function drawRail () {
    clear(railWrap)
    // The stories ring row belongs to the feed, not to one linked post.
    if (focusId) return
    if (state === 'unavailable' || state === 'forbidden') return
    const me = db.profile()
    // "Your story" always leads, so adding one is one tap from the feed.
    const mine = el('button', { class: 'mo-ring mine', type: 'button', onclick: () => openComposer({ story: true }) }, [
      el('span', { class: 'mo-ringimg' }, [avatar({ name: me?.name || ' ', avatar: me?.avatar }, 56)]),
      el('span', { class: 'mo-ringplus', text: '＋' }),
      el('span', { class: 'mo-ringname', text: 'Your story' })
    ])
    railWrap.appendChild(mine)
    for (const s of stories) {
      const who = handleOf(s.author)
      /* THE RING SHOWS THE STORY, not a letter.
       *
       * It rendered a name-derived avatar and nothing else, so a story you had
       * just posted looked exactly like a story you had not — which is a large
       * part of what "posting a story produces an empty story" describes. The
       * author avatar stays underneath as the placeholder, and the story's own
       * frame replaces it as soon as the asset lookup lands (the poster for a
       * video, the picture itself for a photo). */
      const ringImg = el('span', { class: 'mo-ringimg live' }, [avatar({ name: s.author?.displayName || who, avatar: s.author?.avatar }, 56)])
      railWrap.appendChild(el('button', { class: 'mo-ring', type: 'button', onclick: () => openStory(s) }, [
        ringImg,
        el('span', { class: 'mo-ringname', text: who })
      ]))
      if (s.mediaId) {
        assetFor(s.mediaId).then((a) => {
          const src = a && (a.kind === 'video' ? a.posterUrl : a.url)
          if (!src || disposed || !ringImg.isConnected) return
          clear(ringImg)
          ringImg.appendChild(el('img', { class: 'mo-ringthumb', alt: '', src }))
        })
      }
    }
  }

  function drawList () {
    clear(list)
    /* A redraw replaces every card, so the previous observer and its registry
     * point at nodes that have left the document. Tear both down first, and
     * stop whatever was playing — otherwise a removed <video> keeps its audio
     * running with nothing on screen to pause it. */
    if (feedIO) { feedIO.disconnect(); feedIO = null }
    pauseAll()
    feedVids = []
    inView = new Set()
    if (state === 'loading') { list.appendChild(el('p', { class: 'mo-note', text: 'Loading…' })); return }
    if (state === 'unavailable') {
      list.appendChild(el('div', { class: 'mo-note' }, [
        el('b', { text: 'Posts aren’t switched on' }),
        el('p', { text: 'This surface is off for your account right now.' })
      ]))
      return
    }
    if (state === 'forbidden') {
      list.appendChild(el('div', { class: 'mo-note' }, [
        el('b', { text: 'Not available for this account' }),
        el('p', { text: detail || 'Spot Me is for people 18 and over.' })
      ]))
      return
    }
    if (state === 'failed') {
      list.appendChild(el('div', { class: 'mo-note' }, [
        el('b', { text: 'Couldn’t load posts' }),
        el('p', { text: detail || 'Check your connection.' }),
        el('button', { class: 'pill', type: 'button', text: 'Try again', onclick: () => load(true) })
      ]))
      return
    }
    /* A link to a post that was deleted, or that this account may not see.
     * Deliberately one message for both: the server answers 404 either way, so
     * saying which it was would leak whether the id exists. */
    if (state === 'notfound') {
      list.appendChild(el('div', { class: 'mo-note' }, [
        el('b', { text: 'This post isn’t available' }),
        el('p', { text: 'It may have been deleted, or it isn’t shared with your account.' }),
        el('button', { class: 'pill', type: 'button', text: 'Go to Posts', onclick: clearFocus })
      ]))
      return
    }
    if (state === 'empty') {
      list.appendChild(el('div', { class: 'mo-note' }, [
        el('b', { text: 'Nothing here yet' }),
        el('p', {
          text: mode === 'nearby'
            ? 'No posts nearby. Be the first.'
            : mode === 'global'
              ? 'No public posts yet. Post to Everyone and it shows up here.'
              : 'Posts from people you follow show up here.'
        }),
        el('button', { class: 'pill ok', type: 'button', text: 'Create a post', onclick: () => openComposer() })
      ]))
      return
    }
    for (const m of items) list.appendChild(card(m))
    wireFeedVideos()
    // One post from a link: offer the feed rather than a dead end.
    if (focusId) {
      list.appendChild(el('button', {
        class: 'pill mo-more', type: 'button', text: 'See more posts', onclick: clearFocus
      }))
      return
    }
    if (cursor) {
      list.appendChild(el('button', {
        class: 'pill mo-more', type: 'button', text: 'Load more', onclick: () => load(false)
      }))
    }
  }

  /**
   * Autoplay-in-view for the feed, built from the SAME observer factory the
   * reels viewer uses (`watchInView` in lib/video.js) rather than a second
   * hand-rolled one. The two surfaces ask an identical question — "is this the
   * element being looked at?" — and answering it twice is how they drift.
   *
   * Only the card in view plays, and `playExclusive` guarantees it is the only
   * video playing anywhere, so scrolling never leaves a trail of audio behind.
   */
  function wireFeedVideos () {
    if (!feedVids.length) return
    const at = (node) => feedVids.findIndex((f) => f.slot === node)

    feedIO = watchInView(
      (node) => {
        const i = at(node)
        if (i < 0) return
        inView.add(node)
        // Neighbours get their metadata ready so the next card starts without
        // a stall — bytes only, never the speaker.
        for (const j of [i - 1, i + 1]) {
          if (feedVids[j] && feedVids[j].v.preload !== 'auto') feedVids[j].v.preload = 'metadata'
        }
        feedVids[i].v.preload = 'auto'
        // No source yet means the asset call is still out; its `then` will
        // start playback instead, using the set this just joined.
        if (feedVids[i].v.src) {
          playExclusive(feedVids[i].v).then((ok) => feedVids[i]?.slot.classList.toggle('failed', !ok))
        }
      },
      (node) => {
        const i = at(node)
        inView.delete(node)
        if (i >= 0) pause(feedVids[i].v)
      }
    )
    for (const f of feedVids) feedIO.observe(f.slot)

    /* Sound is one shared truth. Flipping it on any card has to repaint every
     * other card's control, or the feed shows two contradictory states at once
     * and the button stops meaning anything. */
    if (!unsubSound) {
      unsubSound = onSoundChange((on) => {
        for (const f of feedVids) {
          const b = f.slot.querySelector('.mo-sound')
          if (!b) continue
          b.innerHTML = on ? ICONS.soundOn : ICONS.soundOff
          b.setAttribute('aria-label', on ? 'Mute' : 'Unmute')
        }
      })
    }
  }

  function draw () { if (!disposed) { drawHead(); drawRail(); drawList() } }

  /* ---------------------------------------------------------------- card */

  /* Outline by default, the same silhouette FILLED once you have reacted —
   * one shape in two states, so the change reads as the same control rather
   * than as a different button appearing.
   *
   * Note this deliberately does not show WHICH of the five reactions was
   * chosen; the button says "you reacted", and the sheet is where the choice
   * lives. Showing the picked emoji here would put a system-drawn glyph back
   * into a row that exists to be one stroke weight. */
  const reactFace = (key) => (key ? ICONS.reactOn : ICONS.react)

  function card (m) {
    const who = m.author?.displayName || m.author?.userId || 'Someone'
    const mine = m.author?.userId === db.profile()?.id
    const media = (m.media || [])[0]

    /* HEADER ABOVE THE MEDIA. The ⋯ menu belongs here, not at the far end of
     * the action row: that put "report" and "block" one thumb-slip from
     * "react", and left the header with dead space exactly where every feed
     * people already use puts the control. */
    const head = el('header', { class: 'mo-cardhead' }, [
      avatar({ name: who, avatar: m.author?.avatar }, 36),
      el('div', { class: 'mo-whowrap' }, [
        el('div', { class: 'mo-wholine' }, [
          el('b', { class: 'mo-who', text: who }),
          /* A2 — WHO CAN SEE THIS, ON THE CARD.
           *
           * The audience was chosen in the composer and then never shown
           * again, so there was no way to tell a post you had sent to
           * everyone from one you had sent to nobody — and the difference
           * between 'public' and 'only you' is the whole reason the control
           * exists. Shown on every card, including other people's: knowing a
           * post is public is what tells you whether resharing it is
           * reasonable. */
          audienceBadge(m.visibility)
        ]),
        el('span', { class: 'mo-meta', text: [place(m), when(m.createdAtUTC)].filter(Boolean).join(' · ') })
      ]),
      el('button', {
        class: 'mo-icon mo-cardmore', type: 'button', html: ICONS.more,
        'aria-label': 'More', onclick: () => openMore(m, mine)
      })
    ])

    // A TEXT post has no media, so it must have no media slot — otherwise the
    // empty 4:5 black box renders as a huge void above the text (real drive).
    const mediaSlot = media ? el('div', { class: 'mo-media' }) : null
    /* Reserve the real box as soon as the server tells us the intrinsic size,
     * which is the same round-trip that hands over the URL — so the shape is
     * known BEFORE a byte of media decodes and the card never resizes under a
     * reader mid-scroll. The CSS holds a 4:5 default until then. */
    const reserve = (a) => {
      if (!a || !(a.width > 0) || !(a.height > 0)) return
      const ar = Math.min(AR_MAX, Math.max(AR_MIN, a.width / a.height))
      mediaSlot.style.aspectRatio = String(ar)
    }

    if (media) {
      if (media.kind === 'video') {
        const v = videoEl('mo-video')
        mediaSlot.appendChild(v)

        /* Tapping the media opens the reels viewer AT THIS POST and CONTINUES
         * from where the card had got to. Restarting at zero is the thing that
         * makes the viewer feel like a different video instead of the same one
         * getting bigger. */
        v.addEventListener('click', () => {
          openReels(items.filter((x) => (x.media || [])[0]?.kind === 'video'), m.id, v.currentTime || 0)
        })

        /* The sound control sits ON the media, because that is the thing it
         * governs, and it carries the tap that browsers require: audible
         * playback is only ever granted from a real gesture. */
        const sound = el('button', {
          class: 'mo-sound', type: 'button',
          html: isSoundOn() ? ICONS.soundOn : ICONS.soundOff,
          'aria-label': isSoundOn() ? 'Mute' : 'Unmute',
          onclick: (e) => {
            // Not a tap on the media — this must not also open the reels.
            e.stopPropagation()
            setSoundOn(!isSoundOn(), v)
            if (v.paused) playExclusive(v)
          }
        })
        mediaSlot.appendChild(sound)
        mediaSlot.appendChild(el('span', { class: 'mo-play', html: ICONS.play }))
        /* NO PLAY AFFORDANCE AT REST.
         *
         * A feed video is supposed to simply begin: muted autoplay over its
         * own poster, nothing on top. The glyph used to be painted on every
         * card and merely faded out once `playing` fired, so any clip that had
         * not started yet — including every clip in the deployed build, whose
         * source never loaded at all — sat under a play button. That is what
         * reads as lag: the control says "you have to do something", when in
         * fact the video is either about to start or is broken.
         *
         * So it is now strictly a FAILURE state. `failed` is set only when
         * playback was actually refused (iOS Low Power Mode, Android battery
         * saver) or the source errored, and it is cleared the moment anything
         * plays. At rest the reader sees the poster and nothing else. */
        const failed = (on) => mediaSlot.classList.toggle('failed', on)
        v.addEventListener('playing', () => { mediaSlot.classList.add('on'); failed(false) })
        v.addEventListener('pause', () => mediaSlot.classList.remove('on'))
        v.addEventListener('error', () => failed(true))

        assetFor(media.mediaId).then((a) => {
          if (!a || disposed) return
          reserve(a)
          /* POSTER, ALWAYS. The card must never be a black rectangle. The
           * transcode worker has written a poster frame for every clip since
           * M3 and the URL route simply never handed it back (fixed in the
           * same change as this). `#t=0.1` stays as the fallback for assets
           * with no poster — older uploads, and the clips whose poster step
           * failed — where nudging past frame zero is the only way to make
           * iOS decode and paint something under preload=metadata. */
          if (a.posterUrl) v.poster = a.posterUrl
          v.src = a.posterUrl ? a.url : `${a.url}#t=0.1`
          /* The observer almost always wins this race: the card is on screen
           * before its URL comes back. Calling play() then would be a play()
           * on a source-less element — a guaranteed rejection that leaves the
           * card frozen on its poster with nothing to retry it. So the arrival
           * of the source is itself a trigger. */
          if (inView.has(mediaSlot)) playExclusive(v).then((ok) => failed(!ok))
        })

        feedVids.push({ m, v, slot: mediaSlot })
      } else {
        const img = el('img', { class: 'mo-img', alt: media.alt || '', loading: 'lazy' })
        mediaSlot.appendChild(img)
        assetFor(media.mediaId).then((a) => {
          if (!a || disposed) return
          reserve(a)
          img.src = a.url
        })
      }
    }

    /* The action row. Reactions, NO counters — see the header note. */
    const acts = el('div', { class: 'mo-acts' })
    const reactBtn = el('button', {
      class: 'mo-icon mo-act' + (m.myReaction ? ' on' : ''), type: 'button',
      html: reactFace(m.myReaction),
      'aria-label': 'React', 'aria-pressed': m.myReaction ? 'true' : 'false',
      /* B1 — A TAP LIKES. Holding opens the full reaction picker.
       *
       * The picker used to be the ONLY way to react, so the commonest action
       * in the product cost a tap, a sheet, a read and a second tap. A like is
       * now the tap itself and the sheet is the deliberate path. */
      onclick: () => toggleLike(m, reactBtn),
      oncontextmenu: (e) => { e.preventDefault(); openReactions(m, reactBtn) }
    })
    acts.appendChild(reactBtn)
    acts.appendChild(el('button', {
      class: 'mo-icon mo-act', type: 'button', html: ICONS.comment,
      'aria-label': 'Comments', onclick: () => openComments(m)
    }))
    acts.appendChild(el('button', {
      class: 'mo-icon mo-act', type: 'button', html: ICONS.share,
      'aria-label': 'Share', onclick: () => shareMoment(m)
    }))

    /* B1 — DOUBLE-TAP THE MEDIA LIKES IT, with the burst centred on the tap.
     * Registered after the slot exists and left to the same optimistic path as
     * the button, so there is exactly one like implementation. */
    if (mediaSlot) onDoubleTap(mediaSlot, (origin) => toggleLike(m, reactBtn, origin))

    return el('article', { class: 'mo-card' }, [
      head,
      mediaSlot,
      m.text ? el('p', { class: `mo-text${media ? '' : ' only'}`, text: m.text }) : null,
      acts
    ].filter(Boolean))
  }

  /* ----------------------------------------------------------- reactions */

  /** Paint the button from `m.myReaction`. One place, so optimistic and
   *  reverted states cannot drift from each other. */
  function paintReact (m, btn) {
    btn.innerHTML = reactFace(m.myReaction)
    btn.className = 'mo-icon mo-act' + (m.myReaction ? ' on' : '')
    btn.setAttribute('aria-pressed', m.myReaction ? 'true' : 'false')
  }

  /**
   * B1 — LIKE, OPTIMISTICALLY.
   *
   * The fill and the burst happen on the tap, BEFORE the request is made. A
   * like that waits for a round-trip feels broken on a slow connection even
   * when it works, and it is the one interaction people do without looking.
   *
   * On failure the fill is REVERTED and said once. Reverting matters more than
   * the toast: a like that silently did not persist is worse than one that
   * visibly failed, because the reader believes a thing about the world that
   * is not true.
   */
  async function toggleLike (m, btn, origin = null) {
    const was = m.myReaction
    const liking = !was
    m.myReaction = liking ? 'like' : null
    paintReact(m, btn)
    if (liking) { likeBurst(btn, origin); tick() }
    try {
      if (liking) await M.react(m.id, 'like'); else await M.unreact(m.id)
    } catch (e) {
      m.myReaction = was
      paintReact(m, btn)
      ctx.toast(e.message || 'That like did not save')
    }
  }

  function openReactions (m, btn) {
    actionSheet(REACTIONS.map((r) => ({
      label: `${r.glyph}  ${r.key}`,
      fn: async () => {
        try {
          if (m.myReaction === r.key) { await M.unreact(m.id); m.myReaction = null } else { await M.react(m.id, r.key); m.myReaction = r.key }
          paintReact(m, btn)
        } catch (e) { ctx.toast(e.message || 'Could not react') }
      }
    })), 'React')
  }

  /* ------------------------------------------------------------ comments */

  function openComments (m) {
    const listEl = el('div', { class: 'mo-cmlist' }, [el('p', { class: 'mo-note', text: 'Loading…' })])
    const input = el('input', { class: 'mo-cminput', type: 'text', placeholder: 'Add a comment…', maxlength: '1000' })
    const send = async () => {
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      try { await M.addComment(m.id, text); await fill() } catch (e) { ctx.toast(e.message || 'Could not comment') }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send() } })

    async function fill () {
      try {
        const res = await M.comments(m.id)
        const rows = res?.results || res?.comments || []
        clear(listEl)
        if (!rows.length) { listEl.appendChild(el('p', { class: 'mo-note', text: 'No comments yet.' })); return }
        for (const c of rows) {
          listEl.appendChild(el('div', { class: 'mo-cm' }, [
            el('b', { text: c.author?.displayName || c.authorId || 'Someone' }),
            el('span', { text: c.text || '' })
          ]))
        }
      } catch (e) {
        clear(listEl)
        listEl.appendChild(el('p', { class: 'mo-note', text: e.message || 'Could not load comments.' }))
      }
    }

    const back = sheet([
      el('div', { class: 'mo-sheethead' }, [el('b', { text: 'Comments' })]),
      listEl,
      el('div', { class: 'mo-cmbar' }, [input, el('button', { class: 'pill ok', type: 'button', text: 'Send', onclick: send })])
    ])
    void back
    fill()
  }

  /* --------------------------------------------------------------- share */

  async function shareMoment (m) {
    // Sharing a post means sharing a LINK, never re-uploading the media.
    const url = `${location.origin}/#/posts?m=${encodeURIComponent(m.id)}`
    try {
      if (navigator.share) await navigator.share({ text: m.text || 'A post on Spot Me', url })
      else { await navigator.clipboard.writeText(url); ctx.toast('Link copied') }
    } catch { /* the user dismissed the share sheet — not an error */ }
  }

  /* ------------------------------------------------- more: follow/report */

  function openMore (m, mine) {
    const opts = []
    if (mine) {
      opts.push({
        label: 'Delete post',
        fn: async () => {
          try { await M.deleteMoment(m.id, m.version ?? 0); items = items.filter((x) => x.id !== m.id); draw(); ctx.toast('Deleted') } catch (e) { ctx.toast(e.message || 'Could not delete') }
        }
      })
    } else {
      opts.push({
        label: 'Follow ' + (m.author?.displayName || 'this person'),
        fn: async () => {
          try { await M.follow(m.author.userId); ctx.toast('Following') } catch (e) { ctx.toast(e.message || 'Could not follow') }
        }
      })
      opts.push({ label: 'Report post', fn: () => openReport(m) })
      opts.push({
        label: 'Block ' + (m.author?.displayName || 'this person'),
        fn: async () => {
          try {
            await M.block(m.author.userId)
            items = items.filter((x) => x.author?.userId !== m.author?.userId)
            draw(); ctx.toast('Blocked')
          } catch (e) { ctx.toast(e.message || 'Could not block') }
        }
      })
    }
    actionSheet(opts, mine ? 'Your post' : (m.author?.displayName || 'Post'))
  }

  function openReport (m) {
    actionSheet(REPORT_REASONS.map((r) => ({
      label: r.label,
      fn: async () => {
        try {
          await M.report({ targetKind: 'moment', targetId: m.id, reason: r.reason })
          // Honest copy: a report is recorded, and we do not promise review
          // speed the product cannot currently deliver (see D7).
          ctx.toast('Reported. Thanks — we record every report.')
        } catch (e) { ctx.toast(e.message || 'Could not report') }
      }
    })), 'Report this post')
  }

  /* ------------------------------------------------------------ composer */

  /**
   * Frames for the trim filmstrip, drawn off a hidden <video> onto a canvas.
   *
   * DEGRADES RATHER THAN FAILS. A browser that cannot decode the picked clip —
   * Chrome on Android meeting HEVC from an iPhone is the everyday case — throws
   * somewhere in here, and the composer falls back to a plain trim bar with no
   * thumbnails. Trimming still works; you just cannot see what you are cutting.
   * The alternative, an editor that refuses to open at all, is worse.
   */
  async function filmstrip (url, count = 4) {
    // Through the same factory as every other video, even though this one is
    // never shown: one place decides what a <video> is in this app, and an
    // offscreen exception is how that stops being true.
    //
    // `preload: 'metadata'`, NOT 'auto'. This element exists to be seeked, not
    // played, and 'auto' pulled the whole clip into memory on a phone that was
    // simultaneously reading the same file for the upload — two full copies of
    // a 50 MB video, which is where the composer stopped responding.
    const v = videoEl('mo-offscreen', { loop: false, preload: 'metadata' })
    v.muted = true
    v.src = url
    const shots = []
    /* A HARD CEILING ON THE WHOLE JOB, not just on each step. Eight frames at
     * a 1.2 s per-seek timeout was a 9.6 s worst case that read as a hang, and
     * every `toDataURL` in between blocks the main thread — so a slow decoder
     * produced a composer that looked frozen while it was merely working. Four
     * frames still describes the clip; the deadline bounds the rest. */
    const deadline = Date.now() + 6000
    try {
      await new Promise((res, rej) => {
        v.addEventListener('loadedmetadata', res, { once: true })
        v.addEventListener('error', () => rej(new Error('undecodable')), { once: true })
        setTimeout(() => rej(new Error('timeout')), 4000)
      })
      // A stream with no seekable duration (some phone recordings report
      // Infinity until fully buffered) cannot be sampled at all — bail to the
      // plain bar rather than seeking to Infinity eight times.
      if (!isFinite(v.duration) || v.duration <= 0) throw new Error('unseekable')
      const c = document.createElement('canvas')
      c.height = 56
      c.width = Math.max(1, Math.round(56 * ((v.videoWidth / v.videoHeight) || 0.56)))
      const g = c.getContext('2d')
      for (let i = 0; i < count; i++) {
        if (Date.now() > deadline) break          // keep what we have
        const t = (v.duration * (i + 0.5)) / count
        await new Promise((res) => {
          v.addEventListener('seeked', res, { once: true })
          // A seek that never lands must not hang the composer forever.
          setTimeout(res, 900)
          try { v.currentTime = Math.min(t, Math.max(0, v.duration - 0.05)) } catch { res() }
        })
        g.drawImage(v, 0, 0, c.width, c.height)
        shots.push(c.toDataURL('image/jpeg', 0.5))
        // Hand the main thread back between frames. drawImage + toDataURL are
        // synchronous and land on the same thread as the upload's progress and
        // every touch event — without this yield the trim window stops
        // responding for as long as the strip takes to build.
        await new Promise((r) => setTimeout(r, 0))
      }
    } catch { /* no thumbnails; the bar below still trims */ }
    v.removeAttribute('src')
    v.load()
    return shots
  }

  function openComposer ({ story = false } = {}) {
    let picked = null
    let uploaded = null
    let composerObjectUrl = null
    /** The in-flight upload, so a new pick can cancel the last one. */
    let uploadAbort = null
    /* Video edit state, in MILLISECONDS — the unit the edit route takes, and
     * fine enough that a chosen cover frame lands where it was chosen. */
    let durMs = 0
    let trimStartMs = 0
    let trimEndMs = 0
    let coverAtMs = 0

    const preview = el('div', { class: 'mo-prev' })
    const tools = el('div', { class: 'mo-tools' })
    const file = el('input', { type: 'file', accept: 'image/*,video/*', style: 'display:none' })
    let visibility = story ? 'friends' : 'nearby'
    const status = el('p', { class: 'mo-substatus', text: '' })

    /* Multiline, and it grows with what is written — a single-line input made
     * a caption of any length a peephole. It stops at four lines so the sheet
     * cannot walk off the bottom of the screen, and scrolls past that. */
    const caption = el('textarea', {
      class: 'mo-cap', rows: '1', maxlength: '4000', placeholder: 'Write a caption…'
    })
    const grow = () => {
      caption.style.height = 'auto'
      const line = parseFloat(getComputedStyle(caption).lineHeight) || 21
      caption.style.height = `${Math.min(caption.scrollHeight, line * 4 + 24)}px`
    }
    caption.addEventListener('input', grow)

    const visBtn = el('button', {
      class: 'pill', type: 'button', text: `Visible to: ${AUDIENCE[visibility].label}`,
      onclick: () => actionSheet(
        /* Three, not four — see AUDIENCE. `public` is still a valid stored
         * value; it is simply not offered until it means something different
         * from `nearby` to the person choosing. */
        PICKABLE.map((v) => ({
          label: `${AUDIENCE[v].label} — ${AUDIENCE[v].hint}`,
          fn: () => { visibility = v; visBtn.textContent = `Visible to: ${AUDIENCE[visibility].label}` }
        })), 'Who can see this?')
    })

    /** Send the currently-picked bytes. Called again after an edit replaces them. */
    async function upload () {
      /* A SECOND UPLOAD MUST CANCEL THE FIRST. Editing a photo re-uploads it,
       * and picking a new file while the last one is still going used to leave
       * two requests racing — whichever landed second won, so a cancelled pick
       * could overwrite the one on screen. */
      uploadAbort?.abort()
      const ac = new AbortController()
      uploadAbort = ac
      status.textContent = 'Uploading…'
      try {
        uploaded = await M.uploadMedia(picked, {
          signal: ac.signal,
          // Percent, not a spinner. The composer had no way to distinguish a
          // slow upload from a dead one, which is what made a large video read
          // as "stuck" — it was moving, and said nothing about it.
          onProgress: (p) => {
            if (ac.signal.aborted) return
            status.textContent = p >= 1 ? 'Finishing…' : `Uploading… ${Math.round(p * 100)}%`
          }
        })
        if (ac.signal.aborted) return
        /* ONE QUIET WORD. This line used to report the upload duration and
         * announce "location data removed" — processing detail and privacy
         * narration aimed at whoever wrote it, not at the person posting.
         * Stripping EXIF is what the product always does; saying so at the
         * moment of posting invites the reader to wonder when it does not.
         * The status exists to say the picture is ready, and nothing else. */
        status.textContent = 'Ready'
      } catch (e) {
        // A cancel is not a failure and must not paint one: the run that
        // cancelled this one owns the status line now.
        if (e.message === 'canceled' || ac.signal.aborted) return
        uploaded = null
        status.textContent = e.message === 'too-large' ? 'That file is too large.' : (e.message || 'Upload failed.')
      }
    }

    /**
     * Crop / rotate / draw on the picked photo, in THE CHAT EDITOR — the same
     * `openPhotoEditor` chat and profile already use, extended with the shape
     * presets rather than reimplemented here. One editor, three callers.
     *
     * It returns a canvas re-encode, so the bytes that go up are NOT the bytes
     * that came off the camera. That is the point (a canvas re-encode carries
     * no EXIF), but it also means the upload has to happen AGAIN with the new
     * bytes — the server strips and hashes what it is given, and what it was
     * given has changed.
     */
    async function editPhoto () {
      if (!picked) return
      try {
        const { dataURL } = await fileToDataURL(picked, MAX_IMAGE_BYTES)
        const res = await openPhotoEditor([dataURL])
        if (!res || !res.dataURL) return          // dismissed; keep the original
        picked = fileFromDataURL(res.dataURL, 'post.jpg')
        // The editor has its own caption line; honour it only if this one is
        // still empty, so editing never silently overwrites what was typed.
        if (res.caption && !caption.value.trim()) { caption.value = res.caption; grow() }
        showPicked(false)
        await upload()
      } catch (e) { status.textContent = e.message || 'Could not edit that photo.' }
    }

    /** Trim bar + cover picker for a video. Server applies both on Post. */
    async function videoTools (localUrl, pv) {
      const strip = el('div', { class: 'mo-strip' })
      const range = el('div', { class: 'mo-striprange' })
      const hA = el('span', { class: 'mo-handle a' })
      const hB = el('span', { class: 'mo-handle b' })
      const cover = el('span', { class: 'mo-covermark' })
      const readout = el('p', { class: 'mo-substatus', text: '' })
      strip.append(range, hA, hB, cover)
      tools.append(
        el('p', { class: 'mo-toollabel', text: 'Trim — drag the ends. Tap to set the cover.' }),
        strip, readout
      )

      const shots = await filmstrip(localUrl)
      if (shots.length) {
        strip.classList.add('shot')
        strip.style.backgroundImage = shots.map((s) => `url(${s})`).join(',')
        strip.style.backgroundSize = `${100 / shots.length}% 100%`
        strip.style.backgroundPosition = shots
          .map((_, i) => `${(i * 100) / (shots.length - 1 || 1)}% 0`).join(',')
      }

      const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
      const paint = () => {
        const pc = (ms) => `${durMs ? (ms / durMs) * 100 : 0}%`
        range.style.left = pc(trimStartMs)
        range.style.right = `${durMs ? 100 - (trimEndMs / durMs) * 100 : 0}%`
        hA.style.left = pc(trimStartMs)
        hB.style.left = pc(trimEndMs)
        cover.style.left = pc(coverAtMs)
        readout.textContent =
          `${secs(trimStartMs)} – ${secs(trimEndMs)}  ·  ${secs(trimEndMs - trimStartMs)} long  ·  cover at ${secs(coverAtMs)}`
      }

      const atX = (e) => {
        const r = strip.getBoundingClientRect()
        return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))) * durMs
      }
      let drag = null
      strip.addEventListener('pointerdown', (e) => {
        if (!durMs) return
        strip.setPointerCapture?.(e.pointerId)
        const t = atX(e)
        // Whichever handle is nearer takes the drag; a press anywhere else is
        // the cover, which is why the cover needs no handle of its own.
        const dA = Math.abs(t - trimStartMs)
        const dB = Math.abs(t - trimEndMs)
        const grab = durMs * 0.06
        drag = dA < dB && dA < grab ? 'a' : (dB < grab ? 'b' : 'cover')
        move(e)
      })
      const move = (e) => {
        if (!drag) return
        const t = atX(e)
        const min = 300      // a clip shorter than this is not a clip
        if (drag === 'a') trimStartMs = Math.min(t, trimEndMs - min)
        else if (drag === 'b') trimEndMs = Math.max(t, trimStartMs + min)
        else coverAtMs = t
        trimStartMs = Math.max(0, trimStartMs)
        trimEndMs = Math.min(durMs, trimEndMs)
        // The cover must stay inside the cut, or it points at a frame the
        // finished clip does not contain.
        coverAtMs = Math.max(trimStartMs, Math.min(coverAtMs, trimEndMs))
        pv.currentTime = (drag === 'cover' ? coverAtMs : (drag === 'a' ? trimStartMs : trimEndMs)) / 1000
        paint()
      }
      strip.addEventListener('pointermove', move)
      const lift = () => { drag = null }
      strip.addEventListener('pointerup', lift)
      strip.addEventListener('pointercancel', lift)
      paint()
    }

    /** Render the picked file, and the tools that belong to its kind. */
    function showPicked (fresh = true) {
      const isVideo = (picked.type || '').startsWith('video/')
      clear(preview)
      clear(tools)
      if (fresh && composerObjectUrl) { URL.revokeObjectURL(composerObjectUrl); composerObjectUrl = null }
      if (!composerObjectUrl || fresh) composerObjectUrl = URL.createObjectURL(picked)
      const localUrl = composerObjectUrl

      if (isVideo) {
        // Same inline guarantees as the feed: the composer preview must not be
        // the one <video> that still hijacks iOS into the native player.
        const pv = videoEl('mo-prevmedia', { loop: false })
        pv.setAttribute('controls', '')
        pv.src = localUrl
        preview.appendChild(pv)
        pv.addEventListener('loadedmetadata', () => {
          durMs = Math.max(0, Math.round((pv.duration || 0) * 1000))
          trimStartMs = 0
          trimEndMs = durMs
          coverAtMs = Math.min(1000, durMs)     // the worker's own default
          videoTools(localUrl, pv)
        }, { once: true })
      } else {
        preview.appendChild(el('img', { class: 'mo-prevmedia', src: localUrl, alt: '' }))
        tools.appendChild(el('button', {
          class: 'pill', type: 'button', text: 'Crop, rotate & draw', onclick: editPhoto
        }))
      }
    }

    file.addEventListener('change', async () => {
      const f = file.files?.[0]
      if (!f) return
      const isVideo = (f.type || '').startsWith('video/')
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
      if (f.size > cap) { status.textContent = `That file is ${(f.size / 1048576).toFixed(1)} MB — the limit is ${cap / 1048576} MB.`; return }
      picked = f
      showPicked(true)
      await upload()
    })

    const postWord = story ? 'Add to story' : 'Post'
    const postBtn = el('button', { class: 'mo-post', type: 'button', onclick: () => post() },
      [el('span', { text: postWord })])

    /* The spinner replaces the WORD, in place, and the button keeps its size.
     * A button that shrinks or disappears mid-tap is how a second Post gets
     * sent — and `disabled` is what actually prevents that, not the spinner. */
    const setBusy = (on) => {
      postBtn.disabled = on
      postBtn.classList.toggle('busy', on)
      clear(postBtn)
      postBtn.appendChild(on
        ? el('span', { class: 'mo-spin', role: 'status', 'aria-label': 'Posting' })
        : el('span', { text: postWord }))
    }

    const post = async () => {
      if (postBtn.disabled) return
      /* Say WHY, when a file is picked but not yet up. This used to fall
       * through to "A story needs a photo or video" while the reader was
       * looking at the photo they had just chosen — the app disagreeing with
       * the screen, which reads as the post being broken. */
      if (picked && !uploaded) { status.textContent = 'Still uploading — one moment.'; return }
      if (!uploaded && !caption.value.trim()) { status.textContent = 'Add a photo, a video, or something to say.'; return }
      if (story && !uploaded) { status.textContent = 'A story needs a photo or video.'; return }
      setBusy(true)
      try {
        /* Trim and cover go up BEFORE the moment is created, so the first
         * transcode already has them and the clip is never briefly published
         * at its untrimmed length. Only sent when they say something: an
         * untouched video must not look edited. */
        const isVideo = uploaded && (picked.type || '').startsWith('video/')
        if (isVideo && durMs && (trimStartMs > 0 || trimEndMs < durMs || coverAtMs !== Math.min(1000, durMs))) {
          await M.editMedia(uploaded.mediaId, {
            trimStartMs: trimStartMs > 0 ? trimStartMs : null,
            trimEndMs: trimEndMs < durMs ? trimEndMs : null,
            coverAtMs
          })
        }
        if (story) {
          await M.createStory({ mediaId: uploaded.mediaId, caption: caption.value.trim() || undefined })
          ctx.toast('Story added')
        } else {
          const kind = uploaded ? (isVideo ? 'video' : 'photo') : 'text'
          const location = (visibility === 'nearby' || visibility === 'public') ? await coarseFix() : null
          await M.createMoment({
            kind,
            text: caption.value.trim() || null,
            mediaIds: uploaded ? [uploaded.mediaId] : [],
            visibility,
            location
          })
          ctx.toast('Posted')
        }
        close()
        load(true)
      } catch (e) {
        setBusy(false)
        status.textContent = e.message || 'Could not post.'
      }
    }

    const close = sheet([
      el('div', { class: 'mo-sheethead' }, [el('b', { text: story ? 'New story' : 'New post' })]),
      preview,
      el('button', { class: 'pill', type: 'button', text: 'Choose photo or video', onclick: () => file.click() }),
      file,
      tools,
      caption,
      story ? null : visBtn,
      // The button leads; the upload note is secondary text underneath it.
      postBtn,
      status
    ].filter(Boolean), () => {
      // Dismissing the composer must stop the upload too. A 50 MB request left
      // running for a post that was abandoned costs the reader their data and
      // keeps the connection busy for whatever they do next.
      uploadAbort?.abort()
      if (composerObjectUrl) { URL.revokeObjectURL(composerObjectUrl); composerObjectUrl = null }
    })
  }

  /* -------------------------------------------------------------- reels */

  /**
   * Full-bleed vertical viewer. One card fills the screen, scroll-snap moves
   * between them, and only the ACTIVE video plays — the neighbours are
   * preloaded but paused, which is what keeps a scroll from stuttering.
   */
  function openReels (videos, startId, startAt = 0) {
    if (!videos.length) return
    const track = el('div', { class: 'mo-reeltrack' })
    const nodes = []
    const saved = readSaved()

    /* THE ACTION RAIL — icons only, hard right, vertically stacked.
     *
     * NO COUNTS, on any of them, for the same reason the feed card has none
     * (see the header note): a tally is what turns posting into scorekeeping.
     * The rail is react · comment · share · save · ⋯ and every one of them is
     * a glyph with an accessible name and nothing else. */
    const railFor = (m) => {
      const mine = m.author?.userId === db.profile()?.id
      const reactBtn = el('button', {
        class: 'mo-reelact' + (m.myReaction ? ' on' : ''), type: 'button',
        html: reactFace(m.myReaction), 'aria-label': 'React',
        'aria-pressed': m.myReaction ? 'true' : 'false',
        onclick: () => openReactions(m, reactBtn)
      })
      const saveBtn = el('button', {
        class: 'mo-reelact' + (saved.has(m.id) ? ' on' : ''), type: 'button',
        html: saved.has(m.id) ? ICONS.saveOn : ICONS.save,
        'aria-label': saved.has(m.id) ? 'Saved' : 'Save',
        'aria-pressed': saved.has(m.id) ? 'true' : 'false',
        onclick: () => {
          const on = !saved.has(m.id)
          if (on) saved.add(m.id); else saved.delete(m.id)
          writeSaved(saved)
          saveBtn.innerHTML = on ? ICONS.saveOn : ICONS.save
          saveBtn.classList.toggle('on', on)
          saveBtn.setAttribute('aria-label', on ? 'Saved' : 'Save')
          saveBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
          ctx.toast(on ? 'Saved' : 'Removed from saved')
        }
      })
      return el('div', { class: 'mo-reelrail' }, [
        reactBtn,
        el('button', {
          class: 'mo-reelact', type: 'button', html: ICONS.comment,
          'aria-label': 'Comments', onclick: () => openComments(m)
        }),
        el('button', {
          class: 'mo-reelact', type: 'button', html: ICONS.share,
          'aria-label': 'Share', onclick: () => shareMoment(m)
        }),
        saveBtn,
        el('button', {
          class: 'mo-reelact', type: 'button', html: ICONS.more,
          'aria-label': 'More', onclick: () => openMore(m, mine)
        })
      ])
    }

    for (const m of videos) {
      const v = videoEl('mo-reelvideo', { preload: 'none' })
      const media = (m.media || [])[0]
      /* Bottom-left identity: avatar, then name, then the caption underneath —
       * the same reading order as the feed card's header, so the post does not
       * re-introduce itself differently just because it got bigger. */
      const meta = el('div', { class: 'mo-reelmeta' }, [
        el('div', { class: 'mo-reelwho' }, [
          avatar({ name: m.author?.displayName || 'Someone', avatar: m.author?.avatar }, 32),
          el('b', { text: m.author?.displayName || 'Someone' })
        ]),
        m.text ? el('p', { text: m.text }) : null
      ].filter(Boolean))
      const pane = el('section', { class: 'mo-reel' }, [v, meta, railFor(m)])
      nodes.push({ m, v, pane, mediaId: media?.mediaId })
      track.appendChild(pane)
    }

    /* Where the viewer opens, and where it currently is. `startAt` is the card's
     * playhead handed over by the tap, so the clip CONTINUES instead of
     * restarting — a restart is what makes the viewer feel like a different
     * video rather than the same one filling the screen. */
    const startIdx = Math.max(0, nodes.findIndex((n) => n.m.id === startId))
    let activeIdx = startIdx
    let resumed = false

    const backBtn = el('button', {
      class: 'mo-reelback', type: 'button', html: ICONS.back,
      'aria-label': 'Back', onclick: () => closeReels()
    })
    /* The same shared sound state the cards use, so opening a reel from a card
     * you had already unmuted does not silently start over in silence. */
    const soundBtn = el('button', {
      class: 'mo-reelsound', type: 'button',
      html: isSoundOn() ? ICONS.soundOn : ICONS.soundOff,
      'aria-label': isSoundOn() ? 'Mute' : 'Unmute',
      onclick: () => {
        const on = !isSoundOn()
        setSoundOn(on, nodes[activeIdx]?.v)
        soundBtn.innerHTML = on ? ICONS.soundOn : ICONS.soundOff
        soundBtn.setAttribute('aria-label', on ? 'Mute' : 'Unmute')
      }
    })

    /* ------------------------------------------------------- transport */

    /* ⟲10 · ▶/❚❚ · 10⟳ over a scrub bar. Three rules shape this:
     *
     *  - 44px targets. Anything smaller is below the tap size everyone's
     *    accessibility guidance sets, and a 10-second skip that misses is
     *    worse than no skip at all.
     *  - AUTO-HIDE after 2.5s, because the point of a reel is the picture.
     *  - EXCEPT WHILE PAUSED. A paused video with hidden controls is a still
     *    image with no way out, which is the state people describe as frozen.
     */
    const HIDE_MS = 2500
    const mmss = (s) => {
      if (!(s >= 0) || !isFinite(s)) return '0:00'
      const m = Math.floor(s / 60)
      return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    }
    const elapsedEl = el('span', { class: 'mo-reeltime', text: '0:00' })
    const totalEl = el('span', { class: 'mo-reeltime', text: '0:00' })
    const scrub = el('input', {
      class: 'mo-reelscrub', type: 'range', min: '0', max: '1000', value: '0',
      'aria-label': 'Seek'
    })
    const playBtn = el('button', {
      class: 'mo-reelbig', type: 'button', html: ICONS.pause, 'aria-label': 'Pause'
    })
    const skip = (delta) => {
      const v = nodes[activeIdx]?.v
      if (!v || !isFinite(v.duration)) return
      v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration || 0)
      showControls()
    }
    const backSkip = el('button', {
      class: 'mo-reelskip', type: 'button', html: ICONS.back10,
      'aria-label': 'Back 10 seconds', onclick: () => skip(-10)
    })
    const fwdSkip = el('button', {
      class: 'mo-reelskip', type: 'button', html: ICONS.fwd10,
      'aria-label': 'Forward 10 seconds', onclick: () => skip(10)
    })
    const controls = el('div', { class: 'mo-reelctrls' }, [
      el('div', { class: 'mo-reeltransport' }, [backSkip, playBtn, fwdSkip]),
      el('div', { class: 'mo-reelbar' }, [elapsedEl, scrub, totalEl])
    ])

    let hideTimer = null
    const paused = () => !!nodes[activeIdx]?.v?.paused
    function showControls () {
      controls.classList.add('on')
      clearTimeout(hideTimer)
      // Paused keeps them up: there must always be a visible way to resume.
      if (!paused()) hideTimer = setTimeout(() => controls.classList.remove('on'), HIDE_MS)
    }
    playBtn.addEventListener('click', () => {
      const v = nodes[activeIdx]?.v
      if (!v) return
      if (v.paused) playExclusive(v); else pause(v)
      syncPlayBtn()
      showControls()
    })
    function syncPlayBtn () {
      const p = paused()
      playBtn.innerHTML = p ? ICONS.play : ICONS.pause
      playBtn.setAttribute('aria-label', p ? 'Play' : 'Pause')
      if (p) { clearTimeout(hideTimer); controls.classList.add('on') }
    }
    let scrubbing = false
    scrub.addEventListener('input', () => {
      scrubbing = true
      const v = nodes[activeIdx]?.v
      if (v && isFinite(v.duration)) elapsedEl.textContent = mmss((Number(scrub.value) / 1000) * v.duration)
      showControls()
    })
    scrub.addEventListener('change', () => {
      const v = nodes[activeIdx]?.v
      if (v && isFinite(v.duration)) v.currentTime = (Number(scrub.value) / 1000) * v.duration
      scrubbing = false
      showControls()
    })

    const layer = el('div', { class: 'mo-reellayer' }, [track, backBtn, soundBtn, controls])
    /* A tap on the picture reveals the controls (and hides them again), which
     * is how every video surface people already use behaves. The rail, the
     * transport and the meta block stop the event themselves, so this only
     * fires for taps on the video itself. */
    track.addEventListener('click', (e) => {
      if (e.target.closest('.mo-reelrail, .mo-reelctrls, .mo-reelmeta')) return
      if (controls.classList.contains('on') && !paused()) controls.classList.remove('on')
      else showControls()
    })
    root.appendChild(layer)
    const perf = perfHarness(layer)
    nodes.forEach((n, i) => perf.attach(n.v, `reel${i + 1}`))
    // Keep the app-shell pull-to-refresh from firing on a reel swipe-down.
    layer.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true })

    /* Only the visible pane plays; ±1 gets its bytes ready, the rest stay cold.
     * Built from the same `watchInView` factory the feed uses — one observer
     * implementation, two callers, no chance of the two surfaces disagreeing
     * about what "in view" means. */
    const paneAt = (target) => nodes.findIndex((n) => n.pane === target)
    const io = watchInView(
      (target) => { const i = paneAt(target); if (i >= 0) activate(i) },
      (target) => { const i = paneAt(target); if (i >= 0) pause(nodes[i].v) }
    )
    for (const n of nodes) io.observe(n.pane)

    async function ensureSrc (i, preload) {
      const n = nodes[i]
      if (!n || !n.mediaId) return
      if (!n.v.src) {
        const a = await assetFor(n.mediaId)
        if (!a || disposed) return
        // A poster here too: a reel that has not decoded yet is otherwise a
        // full black screen, which reads as broken rather than as loading.
        if (a.posterUrl) n.v.poster = a.posterUrl
        n.v.src = a.url
      }
      n.v.preload = preload
    }

    /** Continue from `t`, as soon as the element knows enough to seek. */
    function seekTo (v, t) {
      if (!(t > 0)) return
      const go = () => { try { v.currentTime = t } catch { /* seek refused */ } }
      if (v.readyState >= 1) go()
      else v.addEventListener('loadedmetadata', go, { once: true })
    }

    /* The transport follows whichever pane is active. Listeners are attached
     * ONCE per element (`wired`) — re-attaching on every activation is how a
     * scroll up and back leaves four `timeupdate` handlers fighting over one
     * scrub bar. */
    function wireTransport (v) {
      if (v.dataset.wired === '1') return
      v.dataset.wired = '1'
      const paint = () => {
        if (v !== nodes[activeIdx]?.v) return
        const d = isFinite(v.duration) ? v.duration : 0
        totalEl.textContent = mmss(d)
        if (!scrubbing) {
          elapsedEl.textContent = mmss(v.currentTime)
          scrub.value = String(d ? Math.round((v.currentTime / d) * 1000) : 0)
        }
      }
      v.addEventListener('timeupdate', paint)
      v.addEventListener('loadedmetadata', paint)
      v.addEventListener('durationchange', paint)
      v.addEventListener('play', () => { if (v === nodes[activeIdx]?.v) { syncPlayBtn(); showControls() } })
      v.addEventListener('pause', () => { if (v === nodes[activeIdx]?.v) syncPlayBtn() })
    }

    async function activate (i) {
      activeIdx = i
      perf.activated(`reel${i + 1}`)
      await ensureSrc(i, 'auto')
      // Neighbours: bytes ready, nothing playing.
      ensureSrc(i + 1, 'metadata'); ensureSrc(i - 1, 'metadata')
      const n = nodes[i]
      if (!n || !n.v.src) return
      wireTransport(n.v)
      // Only the pane the tap came from resumes, and only the first time it is
      // activated — scrolling back to it later should start it fresh.
      if (i === startIdx && !resumed) { resumed = true; seekTo(n.v, startAt) }
      const ok = await playExclusive(n.v)
      syncPlayBtn()
      showControls()
      if (!ok && !n.pane.querySelector('.mo-reeltap')) {
        // Autoplay refused even muted (iOS Low Power Mode / Android saver).
        // Offer a tap rather than a dead black screen; the tap is a user
        // gesture, which the same policy always allows.
        const tap = el('button', {
          class: 'mo-reeltap', type: 'button', html: ICONS.play,
          'aria-label': 'Play',
          onclick: () => { tap.remove(); playExclusive(n.v) }
        })
        n.pane.appendChild(tap)
      }
    }

    function closeReels () {
      io.disconnect()
      clearTimeout(hideTimer)
      for (const n of nodes) { pause(n.v); n.v.removeAttribute('src'); n.v.load() }
      layer.remove()
      reelsCleanup = null
    }
    reelsCleanup = closeReels

    nodes[startIdx]?.pane.scrollIntoView({ block: 'start' })
    activate(startIdx)
  }

  /**
   * A story, full-bleed on its own layer.
   *
   * Two things were wrong here and both produced the same empty rectangle.
   * The media URL arrives RELATIVE from the local storage adapter and was
   * assigned raw, so it resolved against the static host and never decoded
   * (fixed at the API boundary — see `assetUrl` in moments-api.js). And the
   * viewer only ever built an `<img>`, so a VIDEO story — which the composer
   * has always accepted — could not render at all.
   *
   * The rail row carries no `kind`, so the element is chosen from the asset
   * lookup's own `kind`, which is the only place the answer actually exists.
   * (`s.thumbnailUrl` used to be probed first; no server route has ever
   * returned that field, so it was dead weight hiding the real path.)
   */
  function openStory (s) {
    const who = handleOf(s.author)
    const stage = el('div', { class: 'mo-stostage' })
    const layer = el('div', { class: 'mo-stolayer' }, [
      stage,
      el('button', {
        class: 'mo-reelback', type: 'button', html: ICONS.back,
        'aria-label': 'Back', onclick: () => close()
      }),
      el('div', { class: 'mo-stowho' }, [
        avatar({ name: s.author?.displayName || who, avatar: s.author?.avatar }, 32),
        el('b', { text: who })
      ])
    ])
    let vid = null
    const close = () => { if (vid) pause(vid); layer.remove() }
    layer.addEventListener('click', (e) => { if (e.target === layer || e.target === stage) close() })
    root.appendChild(layer)

    if (!s.mediaId) return
    assetFor(s.mediaId).then((a) => {
      if (!a || !a.url || disposed) return
      if (a.kind === 'video') {
        vid = videoEl('mo-stovideo', { loop: false })
        if (a.posterUrl) vid.poster = a.posterUrl
        vid.src = a.url
        stage.appendChild(vid)
        playExclusive(vid)
      } else {
        stage.appendChild(el('img', { class: 'mo-stoimg', alt: '', src: a.url }))
      }
    })
  }

  /* --------------------------------------------------------------- sheet */

  /** Bottom sheet, same shape the rest of the app uses. Returns its closer.
   *  `onClose` runs exactly once on dismiss — used to revoke object URLs. */
  function sheet (children, onClose) {
    const back = el('div', { class: 'mo-back' })
    let closed = false
    const close = () => { if (closed) return; closed = true; back.remove(); if (typeof onClose === 'function') onClose() }
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    back.appendChild(el('div', { class: 'mo-sheet' }, children))
    root.appendChild(back)
    return close
  }

  load(true)

  return () => {
    disposed = true
    if (typeof reelsCleanup === 'function') reelsCleanup()
    // Leaving the screen must take the audio with it. Without this a video
    // that was playing keeps its sound running behind whatever comes next.
    if (feedIO) { feedIO.disconnect(); feedIO = null }
    if (unsubSound) { unsubSound(); unsubSound = null }
    pauseAll()
  }
}
