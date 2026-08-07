/**
 * Spot Me — Groups. Same design grammar as the inbox
 * (design/01-messages.html): header bar, big title, search well, rows with
 * 78px-indented dividers and blue unread state.
 *
 * A group is a room with a roster. The roster, the roles and the bans live on
 * the server (it never sees message content); the room key lives here. So this
 * list is the union of two truths: the server's groups, and the local convo
 * that holds unread counts, the last line, and — for a private group — the key
 * without which the room cannot be opened at all.
 *
 * A server group with no local convo is one this device has been added to but
 * has no key for yet. It is shown, and says so, because hiding it would leave
 * someone waiting for an invite that already arrived.
 */
import './groups.css'
import { db } from '../lib/db.js'
import { lobby } from '../lib/discovery.js'
import { rooms } from '../lib/rooms.js'
import { groupsApi } from '../lib/groups-api.js'
import { openGroupWizard } from './group-new.js'
import { el, clear, avatar, actionSheet, fmtDay } from '../lib/ui.js'

const STAGGER_MS = 32
const STAGGER_CAP = 12
const EXPLAINER = 'A group is a shared room. Roles and bans are enforced by the server; your messages are not read by it.'

const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4-4" stroke-linecap="round"/></svg>'
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>'

const groupLink = (convo) =>
  `${location.origin}${location.pathname}#r=${convo.roomId}&k=${convo.secret}` +
  `&g=${encodeURIComponent(convo.title || 'Group')}`

/** navigator.share when available, clipboard otherwise. Never throws. */
async function shareLink (url, toast) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Spot Me', text: 'Join our group on Spot Me', url })
      return
    } catch (err) {
      if (err && err.name === 'AbortError') return
      /* share unavailable mid-flight — fall through to clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    toast('Invite link copied')
  } catch {
    toast('Could not share the link')
  }
}

export function render (root, ctx) {
  let closeWizard = null
  let serverGroups = []
  let loadError = null
  let dead = false

  /* ------------------------------------------------------------- actions */

  function groupMenu (entry) {
    const { group, convo } = entry
    const items = []

    if (group) {
      items.push({ label: 'Manage group', fn: () => ctx.nav(`#/group/${group.id}`) })
    }
    if (convo) {
      items.push({ label: 'Share invite link', fn: () => shareLink(groupLink(convo), ctx.toast) })
      items.push({
        label: 'Archive',
        fn () { db.setArchived(convo.roomId, true); ctx.toast('Group archived') }
      })
    }
    items.push({
      label: 'Leave group',
      danger: true,
      async fn () {
        // Server first: dropping it locally while the roster still holds you is
        // the state where a group you "left" keeps waking your phone.
        if (group) {
          try {
            await groupsApi.leave(group.id)
          } catch (err) {
            ctx.toast(String(err?.message || 'Could not leave'))
            return
          }
        }
        if (convo) {
          try { rooms.leave(convo.roomId) } catch { /* room may never have connected */ }
          db.removeConvo(convo.roomId)
        }
        ctx.toast('You left the group')
        loadServer()
      }
    })

    actionSheet(items, group?.name || convo?.title || 'Group')
  }

  /** Join a public group by @handle — the response carries the room key. */
  async function joinByHandle () {
    const handle = await promptHandle()
    if (!handle) return
    try {
      const joined = await groupsApi.joinPublic(handle)
      const roomId = joined.roomId ?? joined.group?.roomId
      const secret = joined.secretKey ?? joined.key ?? joined.group?.secretKey
      if (!roomId || !secret) {
        // Joined the roster but got no key: the group is reachable for
        // management, not for reading. Say so rather than opening a dead room.
        ctx.toast('Joined, but the server sent no key for this group')
        loadServer()
        return
      }
      const name = joined.name ?? joined.group?.name ?? `@${handle}`
      db.upsertConvo({
        roomId,
        secret,
        kind: 'group',
        mode: 'meet',
        title: name,
        groupId: joined.id ?? joined.group?.id,
        peer: { id: null, name, avatar: null, lang: 'en' }
      })
      rooms.ensure(roomId)
      ctx.openThread(roomId)
    } catch (err) {
      ctx.toast(String(err?.message || 'Could not join that group'))
    }
  }

  /** Tiny one-field sheet; the wizard is overkill for a single handle. */
  function promptHandle () {
    return new Promise((resolve) => {
      const input = el('input', {
        class: 'gw-input',
        type: 'text',
        maxlength: '16',
        placeholder: 'group_handle',
        autocomplete: 'off'
      })
      const backdrop = el('div', { class: 'as-backdrop' })
      const close = (value) => {
        backdrop.classList.add('closing')
        setTimeout(() => { backdrop.remove(); resolve(value) }, 160)
      }
      const submit = () => close(input.value.trim().toLowerCase().replace(/^@/, '') || null)
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null) })
      backdrop.appendChild(el('div', { class: 'as-sheet gw' }, [
        el('div', { class: 'gw-title', text: 'Join a public group' }),
        el('p', { class: 'gw-hint', text: 'Public groups are joinable by handle. The server holds their key.' }),
        input,
        el('button', { class: 'pill ok', type: 'button', text: 'Join', onclick: submit }),
        el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: () => close(null) })
      ]))
      wrap.appendChild(backdrop)
      input.focus()
    })
  }

  function openWizard () {
    if (closeWizard) return
    const close = openGroupWizard(wrap, ctx)
    closeWizard = () => { close(); closeWizard = null }
  }

  /* ------------------------------------------------------------ skeleton */

  const search = el('input', { type: 'text', placeholder: 'Search groups...', autocomplete: 'off' })
  const listEl = el('div', { class: 'list' })

  const wrap = el('div', { class: 'v-groups' }, [
    el('div', { class: 'bar' }, [
      el('button', { class: 'pill', type: 'button', text: 'Join', onclick: joinByHandle }),
      el('span', { class: 'sp' }),
      el('button', { class: 'pill ok', type: 'button', text: 'New group', onclick: openWizard })
    ]),
    el('h1', { class: 'h1', text: 'Groups' }),
    el('div', { class: 'search', html: ICON_SEARCH }, [search]),
    el('div', { class: 'scroll-y' }, [listEl])
  ])

  /* ---------------------------------------------------------------- draw */

  /** One row per group, keyed by roomId so the two sources line up. */
  function entries () {
    const convos = new Map(
      db.convos().filter((c) => c.kind === 'group' && !c.archived).map((c) => [c.roomId, c])
    )
    const rows = serverGroups.map((group) => {
      const convo = convos.get(group.roomId) || null
      convos.delete(group.roomId)
      return { group, convo, roomId: group.roomId, title: group.name }
    })
    // Groups made before the server existed, or made offline, still show.
    for (const convo of convos.values()) {
      rows.push({ group: null, convo, roomId: convo.roomId, title: convo.title || 'Group' })
    }
    return rows.sort((a, b) =>
      (b.convo?.last?.ts || b.convo?.created || 0) - (a.convo?.last?.ts || a.convo?.created || 0))
  }

  function draw () {
    const q = search.value.trim().toLowerCase()
    const rows = entries().filter((r) => !q || r.title.toLowerCase().includes(q))

    clear(listEl)

    if (!rows.length) {
      const bits = [el('p', { text: q ? 'No group matches your search.' : (loadError || EXPLAINER) })]
      if (!q) {
        bits.push(el('button', { class: 'pill ok', type: 'button', text: 'New group', onclick: openWizard }))
      }
      listEl.appendChild(el('div', { class: 'empty' }, bits))
      return
    }

    rows.forEach((entry, i) => {
      const { group, convo, title } = entry
      const unread = convo?.unread || 0
      const preview = convo?.last
        ? `${convo.last.fromMe ? 'You: ' : ''}${convo.last.text}`
        : (convo ? 'No messages yet' : 'Invite pending — open the invite link to get the key')

      listEl.appendChild(el('div', {
        class: 'row' + (unread ? ' unread' : '') + (convo ? '' : ' pending'),
        style: `animation-delay:${Math.min(i, STAGGER_CAP) * STAGGER_MS}ms`,
        onclick: () => {
          if (convo) ctx.openThread(convo.roomId)
          else if (group) ctx.nav(`#/group/${group.id}`)
        }
      }, [
        avatar({ name: title, avatar: group?.avatarUrl }, 52),
        el('div', { class: 'mid' }, [
          el('div', { class: 'l1' }, [
            el('span', { class: 'nm', text: title }),
            convo?.last ? el('span', { class: 'tm', text: fmtDay(convo.last.ts) }) : null
          ]),
          el('div', { class: 'l2' }, [
            el('span', { class: 'pv', text: preview }),
            group?.visibility === 'PUBLIC'
              ? el('span', { class: 'gm-mark', text: `@${group.username}` })
              : null,
            unread ? el('span', { class: 'bdg', text: unread > 99 ? '99+' : String(unread) }) : null
          ])
        ]),
        el('button', {
          class: 'more',
          type: 'button',
          'aria-label': 'Group options',
          html: ICON_MORE,
          onclick (e) { e.stopPropagation(); groupMenu(entry) }
        })
      ]))
    })
  }

  /* ---------------------------------------------------------------- wire */

  async function loadServer () {
    try {
      const list = await groupsApi.listMine()
      if (dead) return
      serverGroups = Array.isArray(list) ? list : []
      loadError = null
    } catch {
      if (dead) return
      // Local groups still render; only the server half is missing.
      loadError = 'Could not reach the group server — showing what is on this device.'
    }
    draw()
  }

  const unsubDb = db.subscribe(draw)
  const unsubLobby = lobby.subscribe(draw)
  search.addEventListener('input', draw)

  root.appendChild(wrap)
  draw()
  loadServer()

  return () => {
    dead = true
    unsubDb()
    unsubLobby()
    if (closeWizard) closeWizard()
  }
}
