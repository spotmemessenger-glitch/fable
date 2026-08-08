/**
 * Moments in React 19.2 — session 1 of 3.
 *
 * Mounted ONLY when localStorage['spotme.ui.moments'] === 'on'; the caller
 * gates before the dynamic import, so with the flag off this module never
 * loads and the legacy view renders untouched.
 *
 * REUSES, never rewrites: lib/moments-api.js (the real API client),
 * lib/video.js (the ONE exclusive-playback owner — playExclusive pauses the
 * current medium BEFORE the next starts, and React videos join the same
 * population as legacy ones), lib/burst.js (the like burst).
 *
 * DELIBERATELY ABSENT ON THIS BRANCH — the #139 base (e304d27) predates
 * master's #144/#143, so this API client has NO reaction/comment count fields,
 * NO audience-change call, NO share/save surface. The UI omits
 * them rather than promising what this branch's server contract lacks; they
 * arrive by REBASING #139, not by inventing fields here. Listed in the
 * report.
 */
import { useCallback, useEffect, useRef, useState, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import * as M from '../../lib/moments-api.js'
import { videoEl, watchInView, pause } from '../../lib/video.js'
import { likeBurst } from '../../lib/burst.js'

/* ------------------------------------------------------------- mount seam */

let root = null

export function mountMoments (host, ctx) {
  unmountMoments()
  root = createRoot(host)
  root.render(createElement(MomentsApp, { ctx }))
  return true
}

export function unmountMoments () {
  if (!root) return
  const r = root
  root = null
  Promise.resolve().then(() => r.unmount())
}

/* ------------------------------------------------------------------- tabs */

const TABS = [
  { mode: 'nearby', label: 'Nearby', empty: 'Nothing nearby yet. Posts from people around you land here.' },
  { mode: 'friends', label: 'Friends', empty: 'No posts from friends yet. Follow someone and their posts land here.' },
  { mode: 'city', label: 'Everyone', empty: 'Nothing here yet. Be the first to post.' }
]

export function MomentsApp ({ ctx }) {
  const [tab, setTab] = useState('friends')
  return (
    <section className="mo-react" aria-label="Posts">
      <div className="mo-tabs" role="tablist" aria-label="Feed">
        {TABS.map((t) => (
          <button
            key={t.mode} type="button" role="tab"
            aria-selected={tab === t.mode}
            className={tab === t.mode ? 'on' : undefined}
            onClick={() => setTab(t.mode)}
          >{t.label}</button>
        ))}
      </div>
      <Feed key={tab} mode={tab} ctx={ctx} />
    </section>
  )
}

/* ------------------------------------------------------------------- feed */

export function Feed ({ mode, ctx }) {
  const [items, setItems] = useState([])
  // loading | ok | end | error | unavailable | forbidden — the last two mirror
  // views/moments.js exactly; see the catch below for why they are distinct.
  const [state, setState] = useState('loading')
  const forbidden = useRef('')
  const cursorRef = useRef(null)
  const seen = useRef(new Set())
  const busy = useRef(false)

  const loadMore = useCallback(async (reset = false) => {
    if (busy.current) return
    busy.current = true
    try {
      const page = await M.feed({ mode, cursor: reset ? null : cursorRef.current })
      // NO DUPLICATES: cursor pages can overlap after a concurrent post; the
      // id set is the guarantee, not the cursor.
      const fresh = (page.results ?? []).filter((m) => !seen.current.has(m.id))
      for (const m of fresh) seen.current.add(m.id)
      setItems((prev) => reset ? fresh : [...prev, ...fresh])
      cursorRef.current = page.cursor ?? null
      setState(page.cursor ? 'ok' : 'end')
    } catch (err) {
      /* THE GATE MUST SURVIVE THE MIGRATION. A bare catch collapsed every
       * failure into "Could not load. Pull to retry." — so a served-but-not-
       * allowlisted account was told to retry something retrying cannot fix,
       * where the legacy view says plainly that the surface is off for them.
       * Same three states legacy distinguishes, from the same error classes. */
      if (err instanceof M.MomentsDisabledError) setState('unavailable')
      else if (err instanceof M.MomentsForbiddenError) { forbidden.current = err.message; setState('forbidden') }
      else setState('error')
    } finally {
      busy.current = false
    }
  }, [mode])

  useEffect(() => {
    seen.current = new Set()
    cursorRef.current = null
    setItems([])
    setState('loading')
    void loadMore(true)
  }, [mode, loadMore])

  // Infinite scroll: one sentinel and an IntersectionObserver, no scroll math.
  const sentinel = useRef(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || state === 'end' || state === 'error' || state === 'unavailable' || state === 'forbidden') return
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) void loadMore()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [state, loadMore])

  const empty = (TABS.find((t) => t.mode === mode) || {}).empty
  return (
    <div className="mo-feed">
      {items.map((m) => <MomentCard key={m.id} moment={m} ctx={ctx} />)}
      {state === 'loading' && items.length === 0 && <p className="mo-note" role="status">Loading…</p>}
      {state !== 'loading' && state !== 'error' && state !== 'unavailable' && state !== 'forbidden' &&
        items.length === 0 && <p className="mo-note">{empty}</p>}
      {state === 'unavailable' && (
        <div className="mo-note">
          <b>Posts aren’t switched on</b>
          <p>This surface is off for your account right now.</p>
        </div>
      )}
      {state === 'forbidden' && (
        <div className="mo-note">
          <b>Not available for this account</b>
          <p>{forbidden.current || 'Spot Me is for people 18 and over.'}</p>
        </div>
      )}
      {state === 'error' && <p className="mo-note">Could not load. Pull to retry.</p>}
      <div ref={sentinel} aria-hidden="true" />
    </div>
  )
}

/* ------------------------------------------------------------------- card */

export function MomentCard ({ moment, ctx }) {
  const m = moment
  const [myReaction, setMyReaction] = useState(m.myReaction ?? null)
  const [gone, setGone] = useState(false)
  const mediaRef = useRef(null)
  const likeRef = useRef(null)
  const say = (msg) => { if (ctx && ctx.toast) ctx.toast(msg) }

  // Media mounts through the SHARED factory so the exclusive-playback owner
  // sees React videos and legacy videos as one population: scrolling a feed
  // of videos can never produce two audible sources, because every play call
  // funnels through playExclusive(), which pauses the owner FIRST.
  useEffect(() => {
    const holder = mediaRef.current
    if (!holder || !m.media || m.media.length === 0) return
    let stopWatch = null
    let cancelled = false
    ;(async () => {
      const asset = m.media[0]
      const url = await M.assetUrl(asset.mediaId)
      if (cancelled || !url) return
      if (asset.kind === 'video') {
        const v = videoEl(url, { poster: asset.posterUrl || undefined })
        holder.replaceChildren(v)
        stopWatch = watchInView(v)
      } else {
        const img = document.createElement('img')
        img.src = url
        img.alt = ''
        img.className = 'mo-prevmedia'
        holder.replaceChildren(img)
      }
    })()
    return () => {
      cancelled = true
      const v = holder.querySelector('video')
      if (v) pause(v)
      if (stopWatch) stopWatch()
      holder.replaceChildren()
    }
  }, [m.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleLike () {
    const liking = !myReaction
    setMyReaction(liking ? 'like' : null)          // optimistic, instant
    if (liking && likeRef.current) likeBurst(likeRef.current)
    try {
      if (liking) await M.react(m.id, 'like')
      else await M.unreact(m.id)
    } catch {
      setMyReaction(liking ? null : 'like')        // revert with the fill
      say('Could not update the like.')
    }
  }

  async function del () {
    try {
      await M.deleteMoment(m.id, m.version)
      setGone(true)
    } catch {
      say('Could not delete.')
    }
  }

  if (gone) return null
  return (
    <article className="mo-card">
      <header className="mo-cardhead">
        <b>{(m.author && m.author.displayName) || 'Someone'}</b>
        {m.author && m.author.username && <span className="mo-handle">@{m.author.username}</span>}
      </header>
      {m.text && <p className="mo-text">{m.text}</p>}
      <div ref={mediaRef} className="mo-media" />
      <div className="mo-actions">
        <button ref={likeRef} type="button" className="mo-act" aria-pressed={!!myReaction}
          aria-label={myReaction ? 'Unlike' : 'Like'} onClick={toggleLike}>
          <span aria-hidden="true">{myReaction ? '❤️' : '🤍'}</span>
        </button>
        {m.mine
          ? (
            <button type="button" className="mo-act" aria-label="Delete post" onClick={del}>
              <span aria-hidden="true">🗑</span>
            </button>
            )
          : (
            <>
              <button type="button" className="mo-act" aria-label="Follow author"
                onClick={() => M.follow(m.author.userId).catch(() => say('Could not follow.'))}>
                <span aria-hidden="true">➕</span>
              </button>
              <button type="button" className="mo-act" aria-label="Report post"
                onClick={() => M.report({ targetKind: 'moment', targetId: m.id, reason: 'Inappropriate' })
                  .then(() => say('Reported.'))
                  .catch(() => say('Could not report.'))}>
                <span aria-hidden="true">⚑</span>
              </button>
              <button type="button" className="mo-act" aria-label="Block author"
                onClick={() => M.block(m.author.userId).catch(() => say('Could not block.'))}>
                <span aria-hidden="true">🚫</span>
              </button>
            </>
            )}
      </div>
    </article>
  )
}
