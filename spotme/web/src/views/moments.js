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

const FEED_MODES = [
  { key: 'nearby', label: 'Nearby' },
  { key: 'friends', label: 'Friends' }
]
/** The closed reaction registry — same list the server accepts. */
const REACTIONS = [
  { key: 'like', glyph: '👍' }, { key: 'love', glyph: '❤️' }, { key: 'laugh', glyph: '😂' },
  { key: 'wow', glyph: '😮' }, { key: 'support', glyph: '🫶' }
]
const REPORT_REASONS = ['Nudity or sexual content', 'Violence', 'Harassment', 'Spam or scam', 'Something else']
/** Beyond this a video is a long clip, and the poster/preload story changes. */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

export function render (root, ctx) {
  let mode = 'nearby'
  let items = []
  let stories = []
  let cursor = null
  let state = 'loading'        // loading | ok | empty | unavailable | forbidden | failed
  let detail = ''
  const assetCache = new Map() // mediaId -> resolved URL
  let disposed = false
  let reelsCleanup = null

  const head = el('div', { class: 'mo-head' })
  const railWrap = el('div', { class: 'mo-rail' })
  const list = el('div', { class: 'mo-list' })
  const wrap = el('div', { class: 'mo-wrap scroll-y' }, [head, railWrap, list])
  root.appendChild(wrap)

  /* ------------------------------------------------------------- helpers */

  /** Resolve one asset to a short-lived URL, once. */
  async function urlFor (mediaId) {
    if (assetCache.has(mediaId)) return assetCache.get(mediaId)
    const p = M.assetUrl(mediaId).then((r) => r?.url || null).catch(() => null)
    assetCache.set(mediaId, p)
    return p
  }

  const when = (ts) => {
    const mins = Math.max(0, Math.round((Date.now() - Number(ts)) / 60000))
    if (mins < 1) return 'now'
    if (mins < 60) return `${mins}m`
    if (mins < 1440) return `${Math.round(mins / 60)}h`
    return `${Math.round(mins / 1440)}d`
  }

  /* ---------------------------------------------------------------- load */

  async function load (reset = true) {
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

  /** A coarse fix, or null. Never the precise one — see discovery.js. */
  function coarseFix () {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null)
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { timeout: 6000, maximumAge: 300000 }
      )
    })
  }

  /* ---------------------------------------------------------------- draw */

  function drawHead () {
    clear(head)
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
      const who = s.author?.displayName || s.author?.userId || 'Someone'
      railWrap.appendChild(el('button', { class: 'mo-ring', type: 'button', onclick: () => openStory(s) }, [
        el('span', { class: 'mo-ringimg live' }, [avatar({ name: who }, 56)]),
        el('span', { class: 'mo-ringname', text: who })
      ]))
    }
  }

  function drawList () {
    clear(list)
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
    if (state === 'empty') {
      list.appendChild(el('div', { class: 'mo-note' }, [
        el('b', { text: 'Nothing here yet' }),
        el('p', { text: mode === 'nearby' ? 'No posts nearby. Be the first.' : 'Posts from people you follow show up here.' }),
        el('button', { class: 'pill ok', type: 'button', text: 'Create a post', onclick: () => openComposer() })
      ]))
      return
    }
    for (const m of items) list.appendChild(card(m))
    if (cursor) {
      list.appendChild(el('button', {
        class: 'pill mo-more', type: 'button', text: 'Load more', onclick: () => load(false)
      }))
    }
  }

  function draw () { if (!disposed) { drawHead(); drawRail(); drawList() } }

  /* ---------------------------------------------------------------- card */

  function card (m) {
    const who = m.author?.displayName || m.author?.userId || 'Someone'
    const mine = m.author?.userId === db.profile()?.id
    const media = (m.media || [])[0]

    const mediaSlot = el('div', { class: 'mo-media' })
    if (media) {
      if (media.kind === 'video') {
        // Poster first, player on demand: a feed of autoplaying videos is the
        // thing that makes scrolling stutter (M3 tunes this properly).
        const v = el('video', {
          class: 'mo-video', muted: '', playsinline: '', loop: '', preload: 'metadata',
          onclick: () => openReels(items.filter((x) => (x.media || [])[0]?.kind === 'video'), m.id)
        })
        v.muted = true
        v.playsInline = true
        mediaSlot.appendChild(v)
        urlFor(media.mediaId).then((u) => { if (u && !disposed) v.src = u })
        mediaSlot.appendChild(el('span', { class: 'mo-play', text: '▶' }))
      } else {
        const img = el('img', { class: 'mo-img', alt: media.alt || '', loading: 'lazy' })
        mediaSlot.appendChild(img)
        urlFor(media.mediaId).then((u) => { if (u && !disposed) img.src = u })
      }
    }

    const acts = el('div', { class: 'mo-acts' })
    // Reactions, NO counters — see the header note.
    const reactBtn = el('button', {
      class: 'mo-act' + (m.myReaction ? ' on' : ''), type: 'button',
      text: m.myReaction ? (REACTIONS.find((r) => r.key === m.myReaction)?.glyph || '👍') : '🤍',
      'aria-label': 'React',
      onclick: () => openReactions(m, reactBtn)
    })
    acts.appendChild(reactBtn)
    acts.appendChild(el('button', {
      class: 'mo-act', type: 'button', text: '💬', 'aria-label': 'Comments',
      onclick: () => openComments(m)
    }))
    acts.appendChild(el('button', {
      class: 'mo-act', type: 'button', text: '↗', 'aria-label': 'Share',
      onclick: () => shareMoment(m)
    }))
    acts.appendChild(el('span', { class: 'mo-spacer' }))
    acts.appendChild(el('button', {
      class: 'mo-act', type: 'button', text: '⋯', 'aria-label': 'More',
      onclick: () => openMore(m, mine)
    }))

    return el('article', { class: 'mo-card' }, [
      el('header', { class: 'mo-cardhead' }, [
        avatar({ name: who }, 34),
        el('div', { class: 'mo-whowrap' }, [
          el('b', { class: 'mo-who', text: who }),
          el('span', { class: 'mo-meta', text: [m.coarseCellLabel, m.author?.distanceBand, when(m.createdAtUTC)].filter(Boolean).join(' · ') })
        ])
      ]),
      mediaSlot,
      m.text ? el('p', { class: 'mo-text', text: m.text }) : null,
      acts
    ].filter(Boolean))
  }

  /* ----------------------------------------------------------- reactions */

  function openReactions (m, btn) {
    actionSheet(REACTIONS.map((r) => ({
      label: `${r.glyph}  ${r.key}`,
      fn: async () => {
        try {
          if (m.myReaction === r.key) { await M.unreact(m.id); m.myReaction = null } else { await M.react(m.id, r.key); m.myReaction = r.key }
          btn.textContent = m.myReaction ? r.glyph : '🤍'
          btn.className = 'mo-act' + (m.myReaction ? ' on' : '')
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
    actionSheet(REPORT_REASONS.map((reason) => ({
      label: reason,
      fn: async () => {
        try {
          await M.report({ targetKind: 'moment', targetId: m.id, reason })
          // Honest copy: a report is recorded, and we do not promise review
          // speed the product cannot currently deliver (see D7).
          ctx.toast('Reported. Thanks — we record every report.')
        } catch (e) { ctx.toast(e.message || 'Could not report') }
      }
    })), 'Report this post')
  }

  /* ------------------------------------------------------------ composer */

  function openComposer ({ story = false } = {}) {
    let picked = null
    let uploaded = null
    const preview = el('div', { class: 'mo-prev' })
    const caption = el('input', { class: 'mo-cap', type: 'text', placeholder: story ? 'Add a caption…' : 'Say something…', maxlength: '4000' })
    const file = el('input', { type: 'file', accept: 'image/*,video/*', style: 'display:none' })
    let visibility = story ? 'friends' : 'nearby'
    const status = el('p', { class: 'mo-note', text: '' })

    const visBtn = el('button', {
      class: 'pill', type: 'button', text: `Visible to: ${visibility}`,
      onclick: () => actionSheet(
        ['nearby', 'friends', 'public', 'private'].map((v) => ({
          label: v, fn: () => { visibility = v; visBtn.textContent = `Visible to: ${visibility}` }
        })), 'Who can see this?')
    })

    file.addEventListener('change', async () => {
      const f = file.files?.[0]
      if (!f) return
      const isVideo = (f.type || '').startsWith('video/')
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
      if (f.size > cap) { status.textContent = `That file is ${(f.size / 1048576).toFixed(1)} MB — the limit is ${cap / 1048576} MB.`; return }
      picked = f
      clear(preview)
      const localUrl = URL.createObjectURL(f)
      preview.appendChild(isVideo
        ? el('video', { class: 'mo-prevmedia', src: localUrl, muted: '', playsinline: '', controls: '' })
        : el('img', { class: 'mo-prevmedia', src: localUrl, alt: '' }))
      status.textContent = 'Uploading…'
      try {
        const t0 = performance.now()
        uploaded = await M.uploadMedia(f)
        const ms = Math.round(performance.now() - t0)
        // The stripping claim is the SERVER's, echoed only when it says so.
        status.textContent = uploaded?.exifStripped
          ? `Ready — location data removed (${ms} ms).`
          : `Ready (${ms} ms).`
      } catch (e) {
        uploaded = null
        status.textContent = e.message === 'too-large' ? 'That file is too large.' : (e.message || 'Upload failed.')
      }
    })

    const post = async () => {
      if (!uploaded && !caption.value.trim()) { status.textContent = 'Add a photo, a video, or something to say.'; return }
      if (story && !uploaded) { status.textContent = 'A story needs a photo or video.'; return }
      try {
        if (story) {
          await M.createStory({ mediaId: uploaded.mediaId, caption: caption.value.trim() || undefined })
          ctx.toast('Story added')
        } else {
          const kind = uploaded ? ((picked.type || '').startsWith('video/') ? 'video' : 'photo') : 'text'
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
      } catch (e) { status.textContent = e.message || 'Could not post.' }
    }

    const close = sheet([
      el('div', { class: 'mo-sheethead' }, [el('b', { text: story ? 'New story' : 'New post' })]),
      preview,
      el('button', { class: 'pill', type: 'button', text: 'Choose photo or video', onclick: () => file.click() }),
      file,
      caption,
      story ? null : visBtn,
      status,
      el('button', { class: 'pill ok', type: 'button', text: story ? 'Add to story' : 'Post', onclick: post })
    ].filter(Boolean))
  }

  /* -------------------------------------------------------------- reels */

  /**
   * Full-bleed vertical viewer. One card fills the screen, scroll-snap moves
   * between them, and only the ACTIVE video plays — the neighbours are
   * preloaded but paused, which is what keeps a scroll from stuttering.
   */
  function openReels (videos, startId) {
    if (!videos.length) return
    const track = el('div', { class: 'mo-reeltrack' })
    const nodes = []
    for (const m of videos) {
      const v = el('video', { class: 'mo-reelvideo', muted: '', playsinline: '', loop: '', preload: 'none' })
      v.muted = true
      v.playsInline = true
      const media = (m.media || [])[0]
      const pane = el('section', { class: 'mo-reel' }, [
        v,
        el('div', { class: 'mo-reelmeta' }, [
          el('b', { text: m.author?.displayName || 'Someone' }),
          m.text ? el('p', { text: m.text }) : null
        ].filter(Boolean))
      ])
      nodes.push({ m, v, pane, mediaId: media?.mediaId })
      track.appendChild(pane)
    }

    const closeBtn = el('button', { class: 'mo-reelclose', type: 'button', text: '✕', onclick: () => closeReels() })
    const layer = el('div', { class: 'mo-reellayer' }, [track, closeBtn])
    root.appendChild(layer)

    // Only the visible pane plays; ±1 gets its bytes ready, the rest stay cold.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = nodes.findIndex((n) => n.pane === e.target)
        if (i < 0) continue
        if (e.isIntersecting && e.intersectionRatio > 0.6) {
          activate(i)
        } else {
          nodes[i].v.pause()
        }
      }
    }, { threshold: [0, 0.6, 1] })
    for (const n of nodes) io.observe(n.pane)

    async function ensureSrc (i, preload) {
      const n = nodes[i]
      if (!n || !n.mediaId) return
      if (!n.v.src) {
        const u = await urlFor(n.mediaId)
        if (!u || disposed) return
        n.v.src = u
      }
      n.v.preload = preload
    }
    async function activate (i) {
      await ensureSrc(i, 'auto')
      // Neighbours: bytes ready, nothing playing.
      ensureSrc(i + 1, 'metadata'); ensureSrc(i - 1, 'metadata')
      const n = nodes[i]
      if (n && n.v.src) { try { await n.v.play() } catch { /* autoplay refused — the poster stays */ } }
    }

    function closeReels () {
      io.disconnect()
      for (const n of nodes) { n.v.pause(); n.v.removeAttribute('src'); n.v.load() }
      layer.remove()
      reelsCleanup = null
    }
    reelsCleanup = closeReels

    const startIdx = Math.max(0, nodes.findIndex((n) => n.m.id === startId))
    nodes[startIdx]?.pane.scrollIntoView({ block: 'start' })
    activate(startIdx)
  }

  function openStory (s) {
    const img = el('img', { class: 'mo-storyimg', alt: '' })
    const close = sheet([
      el('div', { class: 'mo-sheethead' }, [el('b', { text: s.author?.displayName || 'Story' })]),
      img
    ])
    void close
    if (s.thumbnailUrl) img.src = s.thumbnailUrl
    else if (s.mediaId) urlFor(s.mediaId).then((u) => { if (u) img.src = u })
  }

  /* --------------------------------------------------------------- sheet */

  /** Bottom sheet, same shape the rest of the app uses. Returns its closer. */
  function sheet (children) {
    const back = el('div', { class: 'mo-back' })
    const close = () => back.remove()
    back.addEventListener('click', (e) => { if (e.target === back) close() })
    back.appendChild(el('div', { class: 'mo-sheet' }, children))
    root.appendChild(back)
    return close
  }

  load(true)

  return () => {
    disposed = true
    if (typeof reelsCleanup === 'function') reelsCleanup()
  }
}
