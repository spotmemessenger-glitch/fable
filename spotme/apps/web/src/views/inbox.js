/**
 * Spot Me — Home / Messages view (#/chat route).
 *
 * Locked design: spotme/design/01-messages.html, reworked to the owner's
 * home-screen reference: avatar top-left (→ settings), plus opens a New chat
 * sheet, tabs Chats | Nearby | Bluetooth with amber unread pips. The old
 * General overview moved to Notifications (#/notifications). The shell owns
 * the bottom nav — never rendered here.
 */
import './inbox.css'
import { db, randomHex } from '../lib/db.js'
import { lobby } from '../lib/discovery.js'
import { reach } from '../lib/reach.js'
import { rooms } from '../lib/rooms.js'
import { el, clear, avatar, fmtDay, actionSheet } from '../lib/ui.js'
import { reactInbox } from './inbox-island.js'

const LONG_PRESS_MS = 420
const SWIPE_COMMIT_PX = 60
const SWIPE_OPEN_PX = 84
const DRAG_SLOP_PX = 8
const SEARCH_DEBOUNCE_MS = 350
const GHOST_CLICK_MS = 400     // swallow synthesized clicks right after a sheet mounts
const SHEET_CLOSE_MS = 160
const GROUP_NAME_MAX = 40
const PULL_REVEAL_PX = 48      // pull-down distance that reveals the Archived row
const USERNAME_RE = /^[a-z0-9_]{2,}$/
import { API_BASE as REGISTRY_API } from '../lib/api.js'

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4-4" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>',
  archBox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg>',
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  at: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12.5l4.5 4.5 9-10"/><path d="M9.5 16.5l2.5 2.5 10.5-11"/></svg>'
}

/* Three tabs, one per transport family. The old General overview lives on
 * the Notifications screen now (#/notifications). */
const TABS = [
  { key: 'chats', label: 'Chats' },
  { key: 'nearby', label: 'Nearby' },
  { key: 'bt', label: 'Bluetooth' }
]

const EMPTY_COPY = {
  chats: { text: 'No chats yet — search a username above or find people in Discovery.', btn: 'Find people', nav: '#/discovery' },
  nearby: { text: 'No nearby chats yet — say hi to someone in Discovery.', btn: 'Find people', nav: '#/discovery' },
  bt: { text: 'No Bluetooth chats yet — start one from the Bluetooth screen.', btn: 'Open Bluetooth', nav: '#/bluetooth' }
}

/* Once revealed by a pull-down, the Archived row stays revealed for the whole
 * session — across view remounts — matching the WhatsApp reference. */
let archivedRevealed = false

const convoName = (convo) => convo.title || convo.peer?.name || 'Chat'

function tabOf (convo) {
  if (convo.mode === 'nearby') return 'nearby'
  if (convo.mode === 'bluetooth') return 'bt'
  return 'chats'                       // 'meet' (incl. groups) and anything unlabelled
}

/** "@yuv" / "yuv" → "yuv" when it looks like a username, else null. */
function usernameQuery (raw) {
  const q = raw.trim().replace(/^@/, '').toLowerCase()
  return USERNAME_RE.test(q) ? q : null
}

function exportLine (message) {
  const when = new Date(message.ts).toLocaleString()
  const who = message.name || 'Unknown'
  let body = message.text || ''
  if (message.kind === 'image') body = '[photo]'
  else if (message.kind === 'voice') body = `[voice note ${message.dur || 0}s]`
  else if (message.kind === 'file') body = `[file] ${message.fileName || ''}`.trim()
  else if (message.kind === 'location') body = '[location]'
  return `[${when}] ${who}: ${body}`
}

export function render (root, ctx) {
  const island = reactInbox(root, ctx) // ADR-035 slice 6, default OFF
  if (island) return island
  root.classList.add('v-inbox')

  let tab = 'chats'
  let query = ''
  let archivedMode = false        // list shows ONLY archived chats while true
  let newChatEl = null            // backdrop of the New chat sheet while open
  let openSwipe = null            // {row, del} — the one row with Delete revealed
  let pressTimer = null
  let searchTimer = null
  let searchSeq = 0               // bumping it invalidates in-flight registry lookups
  let searchResults = []
  let dropOpen = false

  /* ------------------------------------------------------------- actions */

  function confirmDelete (convo) {
    actionSheet([{
      label: 'Delete conversation',
      danger: true,
      fn () {
        rooms.leave(convo.roomId)
        db.removeConvo(convo.roomId)
        ctx.toast('Conversation deleted')
      }
    }], `Delete your chat with ${convoName(convo)}? Messages on this device are removed.`)
  }

  function blockPeer (convo) {
    const name = convoName(convo)
    db.block(convo.peer.id, name)
    rooms.leave(convo.roomId)
    db.removeConvo(convo.roomId)
    ctx.toast(`${name} blocked`)
  }

  function exportChat (convo) {
    try {
      const conn = rooms.ensure(convo.roomId)
      const messages = conn ? conn.store.list() : []
      if (!messages.length) { ctx.toast('Nothing to export yet'); return }
      const blob = new Blob([messages.map(exportLine).join('\n') + '\n'], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const safe = convoName(convo).replace(/[^\w\- ]+/g, '').trim() || 'chat'
      const link = el('a', { href: url, download: `${safe}.txt` })
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch { ctx.toast('Could not export this chat') }
  }

  function rowMenu (convo) {
    const name = convoName(convo)
    actionSheet([
      {
        label: convo.archived ? 'Unarchive' : 'Archive',
        fn () {
          db.setArchived(convo.roomId, !convo.archived)
          ctx.toast(convo.archived ? 'Unarchived' : 'Archived')
        }
      },
      { label: 'Export chat', fn: () => exportChat(convo) },
      convo.peer?.id ? { label: `Block ${name}`, fn: () => blockPeer(convo) } : null,
      { label: 'Delete conversation', danger: true, fn: () => confirmDelete(convo) }
    ].filter(Boolean), name)
  }

  /* -------------------------------------------------------- new chat sheet */

  function createGroup (nameInput, close) {
    const name = nameInput.value.trim()
    if (!name) { ctx.toast('Give the group a name first'); nameInput.focus(); return }
    try {
      const roomId = randomHex(8)
      const secret = randomHex(16)
      db.upsertConvo({
        roomId,
        secret,
        kind: 'group',
        mode: 'meet',
        title: name,
        peer: { id: null, name, avatar: null, lang: 'en' }
      })
      rooms.ensure(roomId)
      close()
      ctx.openThread(roomId)
    } catch { ctx.toast('Could not create the group') }
  }

  function openNewChat () {
    if (newChatEl) return
    const back = el('div', { class: 'as-backdrop' })
    const close = () => {
      newChatEl = null
      back.classList.add('closing')
      setTimeout(() => back.remove(), SHEET_CLOSE_MS)
    }
    // Ghost-click armour: a click synthesized from the press that opened the
    // sheet must neither dismiss it nor activate an item.
    const mounted = Date.now()
    back.addEventListener('click', (event) => {
      if (Date.now() - mounted < GHOST_CLICK_MS) { event.stopPropagation(); event.preventDefault() }
    }, true)
    back.addEventListener('click', (event) => { if (event.target === back) close() })

    const nameInput = el('input', {
      class: 'ncInput',
      type: 'text',
      maxlength: String(GROUP_NAME_MAX),
      placeholder: 'Group name',
      autocomplete: 'off',
      onkeydown (event) { if (event.key === 'Enter') createGroup(nameInput, close) }
    })
    const groupForm = el('div', { class: 'ncGroup', style: 'display:none' }, [
      nameInput,
      el('button', { class: 'pill ok', type: 'button', text: 'Create', onclick: () => createGroup(nameInput, close) })
    ])

    const item = (icon, label, sub, fn) => el('button', { class: 'ncItem', type: 'button', onclick: fn }, [
      el('span', { class: 'ncIc', html: icon }),
      el('span', { class: 'ncW' }, [
        el('b', { text: label }),
        sub ? el('span', { text: sub }) : null
      ])
    ])

    back.appendChild(el('div', { class: 'as-sheet ncSheet' }, [
      el('div', { class: 'ncTitle', text: 'New chat' }),
      item(ICON.group, 'New group', 'A shared room — everyone with the link is in', () => {
        groupForm.style.display = ''
        nameInput.focus()
      }),
      groupForm,
      /* THE DOORS TO TWO WHOLE SCREENS THAT NOTHING NAVIGATED TO.
       *
       * `#/groups` (the list, the create wizard with roster and per-role
       * permissions, join-by-public-@handle, share invite link, manage members,
       * roles, bans, transfer ownership) was only ever reachable FROM
       * `#/group/:id`, which is only reachable from `#/groups` — a closed loop
       * with no way in. `#/contacts` had no `nav()` call anywhere at all. Both
       * were registered in ROUTES and shipped in the bundle; ~1400 lines of
       * finished feature that a user could not open.
       *
       * The local "New group" above still works and is still simpler, but it
       * makes a room with no roster and no server-side group, so it is not a
       * substitute for the wizard. */
      item(ICON.group, 'Groups', 'Create with roles, or join by @handle', () => { close(); ctx.nav('#/groups') }),
      item(ICON.at, 'Contacts', 'Everyone you have talked to', () => { close(); ctx.nav('#/contacts') }),
      item(ICON.pin, 'Find people nearby', null, () => { close(); ctx.nav('#/discovery') }),
      item(ICON.at, 'Search by username', null, () => { close(); searchInput.focus() }),
      item(ICON.archBox, 'Archived chats', null, () => {
        close()
        setArchivedMode(true)
      }),
      item(ICON.read, 'Mark all as read', null, () => {
        for (const convo of db.convos()) db.clearUnread(convo.roomId)
        ctx.toast('All caught up')
        close()
      }),
      el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: () => close() })
    ]))
    root.appendChild(back)
    newChatEl = back
  }

  /* ------------------------------------------------------ static skeleton */

  const meBtn = el('button', { class: 'me', type: 'button', 'aria-label': 'My profile', onclick: () => ctx.nav('#/settings') })

  // Wordmark replaces the old "Messages" title: it sits between the profile
  // pic and the plus, so the list starts right under the search field.
  const bar = el('div', { class: 'bar' }, [
    meBtn,
    el('span', { class: 'sp' }),
    el('span', { class: 'wm', text: 'Spot Me' }),
    el('span', { class: 'sp' }),
    el('button', { class: 'plus', type: 'button', 'aria-label': 'New chat', html: ICON.plus, onclick: openNewChat })
  ])

  const searchInput = el('input', {
    placeholder: 'Search users...',
    autocomplete: 'off',
    oninput () {
      query = searchInput.value.trim().toLowerCase()
      renderList()                               // local convo matches, always
      hideDrop()                                 // query changed — stale dropdown goes
      clearTimeout(searchTimer)
      const uname = usernameQuery(searchInput.value)
      if (uname) searchTimer = setTimeout(() => lookupUsername(uname), SEARCH_DEBOUNCE_MS)
      else searchSeq += 1                        // cancel any in-flight lookup
    }
  })
  const dropEl = el('div', { class: 'udrop', style: 'display:none' })
  const searchWell = el('div', { class: 'search' }, [
    el('span', { class: 'ic', html: ICON.search }),
    searchInput,
    dropEl
  ])

  /* ------------------------------------------------- username search */

  async function lookupUsername (uname) {
    const seq = ++searchSeq
    try {
      const res = await fetch(`${REGISTRY_API}/api/username?q=${encodeURIComponent(uname)}`)
      if (!res.ok) throw new Error(`registry ${res.status}`)
      const data = await res.json()
      if (seq !== searchSeq) return              // a newer query superseded this one
      const myId = db.profile()?.id
      searchResults = (Array.isArray(data?.results) ? data.results : [])
        .filter((match) => match?.username && match.id !== myId)
      showDrop()
    } catch {
      if (seq === searchSeq) hideDrop()          // silent — never toast while typing
    }
  }

  function pickResult (match) {
    hideDrop()
    const convo = db.convos().find((c) => c.kind === 'dm' && c.peer?.id === match.id)
    if (convo) { ctx.openThread(convo.roomId); return }
    openRequestSheet(match)
  }

  /**
   * Let them write the first line before the chat opens.
   *
   * Tapping a search result used to fire a message instantly with a canned
   * "Hi! Found you by username" — so merely looking someone up messaged them,
   * and the person on the other end got a greeting nobody wrote. The text
   * typed here is what both sides see as the first message once the chat
   * opens (immediately, on both devices — no approval step).
   */
  function openRequestSheet (match) {
    const who = match.name || match.username
    const input = el('input', {
      class: 'reqmsg', type: 'text', maxlength: '300',
      placeholder: 'Say something…', value: 'Hi!'
    })

    let sending = false
    const send = () => {
      if (sending) return
      sending = true
      // Addressed, so it reaches them anywhere in the lobby — not only if our
      // peer list already happens to hold them.
      // Match on username FIRST: the registry id is the one recorded when the
      // name was claimed, so it is stale for anyone who reinstalled, and
      // looking them up by it misses the very person standing in the lobby.
      const live = lobby.peers().find((p) => match.username && p.username === match.username) ||
        lobby.peers().find((p) => p.id === match.id)
      const peer = (live ? { ...live, username: match.username } : null) ||
        { id: match.id, name: who, username: match.username, avatar: null, lang: 'en' }
      const text = input.value.trim().slice(0, 300) || 'Hi!'
      try {
        const roomId = reach.reach(peer, text, 'meet')
        close()
        ctx.openThread(roomId)
      } catch {
        sending = false
        ctx.toast('Could not start that chat')
      }
    }

    const back = el('div', { class: 'reqback' })
    const close = () => back.remove()
    back.addEventListener('click', (e) => { if (e.target === back) close() })

    back.appendChild(el('div', { class: 'reqsheet' }, [
      el('div', { class: 'reqhead' }, [
        avatar({ name: who }, 46),
        el('div', {}, [
          el('b', { text: who }),
          el('span', { class: 'requn', text: '@' + match.username })
        ])
      ]),
      el('p', { class: 'reqhint', text: 'This opens the chat and sends them your first message.' }),
      input,
      el('div', { class: 'reqbtns' }, [
        el('button', { class: 'reqcancel', type: 'button', text: 'Cancel', onclick: close }),
        el('button', { class: 'reqsend', type: 'button', text: 'Start chat', onclick: send })
      ])
    ]))
    root.appendChild(back)
    input.focus()
    input.select()
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
  }

  function renderDrop () {
    clear(dropEl)
    if (!searchResults.length) {
      dropEl.appendChild(el('div', { class: 'uEmpty', text: 'No one found' }))
      return
    }
    const online = new Set(lobby.peers().map((p) => p.id))
    for (const match of searchResults) {
      dropEl.appendChild(el('button', {
        class: 'uRow', type: 'button',
        onclick: () => pickResult(match)
      }, [
        avatar({ name: match.name || match.username }, 38, { dot: online.has(match.id) }),
        el('div', { class: 'uW' }, [
          el('b', { text: '@' + match.username }),
          el('span', { text: match.name || '' })
        ])
      ]))
    }
  }

  function showDrop () { dropOpen = true; renderDrop(); dropEl.style.display = '' }
  function hideDrop () { dropOpen = false; dropEl.style.display = 'none' }

  /* --------------------------------- archived row + archived mode */

  const archCount = el('span', { class: 'apCount' })
  const archRow = el('div', { class: 'archPull' }, [
    el('button', {
      class: 'apBtn', type: 'button',
      onclick: () => setArchivedMode(true)
    }, [
      el('span', { class: 'apIc', html: ICON.archBox }),
      el('span', { class: 'apLb', text: 'Archived' }),
      archCount
    ])
  ])

  const archHead = el('div', { class: 'archHead', style: 'display:none' }, [
    el('button', {
      class: 'ahBack', type: 'button', 'aria-label': 'Back to chats',
      onclick: () => setArchivedMode(false)
    }, [
      el('span', { class: 'ahIc', html: ICON.back }),
      el('span', { text: 'Archived' })
    ])
  ])

  /** Collapsed until revealed; gone entirely in archived mode or when
   *  nothing is archived. Count keeps itself fresh on every render. */
  function renderArchRow () {
    const count = db.convos().filter((c) => c.archived).length
    archCount.textContent = String(count)
    // Only meaningful once something is archived — but the pull itself is no
    // longer silent when it is empty: the refresh indicator answers the drag.
    archRow.style.display = count > 0 && !archivedMode ? '' : 'none'
    archRow.classList.toggle('reveal', archivedRevealed)
  }

  function setArchivedMode (on) {
    if (archivedMode === on) return
    archivedMode = on
    archHead.style.display = on ? '' : 'none'
    tabsEl.style.display = on ? 'none' : ''
    renderList()
  }

  function setTab (key) {
    tab = key
    for (const b of tabsEl.querySelectorAll('.tb')) {
      b.setAttribute('aria-selected', String(b.dataset.t === tab))
    }
    renderList()
  }

  const tabsEl = el('div', { class: 'tabs', role: 'tablist' }, TABS.map((t) =>
    el('button', {
      class: 'tb', type: 'button', role: 'tab', 'data-t': t.key,
      'aria-selected': t.key === tab ? 'true' : 'false',
      onclick: () => setTab(t.key)
    }, [
      el('span', { class: 'tbLb' }, [
        t.label,
        el('span', { class: 'tbCt', 'data-ct': t.key, 'aria-hidden': 'true', style: 'display:none' })
      ])
    ])
  ))

  /** Amber unread pips inside the tab pills — sum of unread across the tab's
   *  non-archived conversations; hidden at zero; live via db.subscribe. */
  function renderTabCounts () {
    const counts = { chats: 0, nearby: 0, bt: 0 }
    for (const convo of db.convos()) {
      if (convo.archived) continue
      counts[tabOf(convo)] += convo.unread || 0
    }
    for (const badge of tabsEl.querySelectorAll('.tbCt')) {
      const count = counts[badge.dataset.ct] || 0
      badge.textContent = count > 99 ? '99+' : String(count)
      badge.style.display = count > 0 ? '' : 'none'
    }
  }

  const chatsHead = el('h3', { class: 'h2', text: 'Chats' })
  const listEl = el('div')
  const scroll = el('div', { class: 'scroll' }, [
    chatsHead,
    listEl
  ])

  /* Pull-to-reveal: dragging down past the threshold while the list sits at
   * the very top slides the Archived row in — once, then it stays. */
  let pullStartY = null

  function revealArchived () {
    if (archivedRevealed) return
    archivedRevealed = true
    renderArchRow()
  }

  scroll.addEventListener('touchstart', (event) => {
    pullStartY = scroll.scrollTop <= 0 ? event.touches[0].clientY : null
  }, { passive: true })
  scroll.addEventListener('touchmove', (event) => {
    if (pullStartY == null || archivedRevealed) return
    if (scroll.scrollTop > 0) { pullStartY = null; return }
    // Do NOT clear pullStartY after revealing: the same drag continues into
    // the refresh gesture, and zeroing it here cancelled the longer pull.
    if (event.touches[0].clientY - pullStartY > PULL_REVEAL_PX) revealArchived()
  }, { passive: true })
  scroll.addEventListener('wheel', (event) => {
    if (scroll.scrollTop <= 0 && event.deltaY < 0) revealArchived()
  }, { passive: true })

  /* ------------------------------------------------------------ chat list */

  function matchesQuery (convo) {
    if (!query) return true
    return convoName(convo).toLowerCase().includes(query) ||
      (convo.last?.text || '').toLowerCase().includes(query)
  }

  /** Archived/search filter shared by every tab (mode filtering is separate).
   *  Archived chats never show here — they live in archived mode only. */
  function convoVisible (convo) {
    if (convo.archived) return false
    return matchesQuery(convo)
  }

  function matches (convo) {
    if (!convoVisible(convo)) return false
    return tab === 'chats' ? true : tabOf(convo) === tab
  }

  function buildEmpty () {
    if (query) {
      return el('div', { class: 'empty', text: `No matches for "${searchInput.value.trim()}"` })
    }
    const copy = EMPTY_COPY[tab]
    return el('div', { class: 'empty' }, [
      el('span', { text: copy.text }),
      el('button', { class: 'pill ok', type: 'button', text: copy.btn, onclick: () => ctx.nav(copy.nav) })
    ])
  }

  function renderList () {
    openSwipe = null
    clear(listEl)
    renderArchRow()
    const online = new Set(lobby.peers().map((p) => p.id))
    if (archivedMode) {
      chatsHead.style.display = 'none'
      const rows = db.convos().filter((c) => c.archived && matchesQuery(c))
      if (!rows.length) {
        listEl.appendChild(el('div', { class: 'empty', text: 'No archived chats.' }))
        return
      }
      rows.forEach((convo, i) => listEl.appendChild(buildRow(convo, online, i)))
      return
    }
    chatsHead.style.display = ''
    chatsHead.textContent = TABS.find((t) => t.key === tab)?.label || 'Chats'
    const rows = db.convos().filter(matches)
    /* The scanner's ONLY entrance was the empty state below — so it closed the
     * moment the first Bluetooth chat existed, and `bluetooth.js`'s own back
     * button goes to `#/chat`, leaving no way back in either. One chat and the
     * whole 300-line screen became unreachable for good. */
    if (tab === 'bt') {
      listEl.appendChild(el('button', {
        class: 'pill ok btscan', type: 'button', text: 'Scan for people nearby',
        onclick: () => ctx.nav('#/bluetooth')
      }))
    }
    if (!rows.length) { listEl.appendChild(buildEmpty()); return }
    rows.forEach((convo, i) => listEl.appendChild(buildRow(convo, online, i)))
  }

  function buildRow (convo, online, index) {
    const name = convoName(convo)
    const isOnline = convo.kind === 'demo' ||
      (convo.peer?.id != null && online.has(convo.peer.id))
    const unread = convo.unread || 0

    const del = el('button', {
      class: 'swipeDel', type: 'button', 'aria-label': 'Delete conversation', html: ICON.trash,
      onclick (event) { event.stopPropagation(); confirmDelete(convo) }
    })
    const arch = el('div', { class: 'swipeArch', html: ICON.archBox, 'aria-hidden': 'true' })

    const preview = el('span', {
      class: 'pv',
      text: convo.last ? `${convo.last.fromMe ? 'You: ' : ''}${convo.last.text}` : 'No messages yet'
    })

    const row = el('div', {
      class: 'row' + (unread > 0 ? ' unread' : ''),
      style: `animation-delay:${Math.min(index, 12) * 32}ms`,
      role: 'button', tabindex: '0',
      onkeydown (event) { if (event.key === 'Enter') ctx.openThread(convo.roomId) }
    }, [
      avatar(convo.peer || { name }, 52, { dot: isOnline }),
      el('div', { class: 'mid' }, [
        el('div', { class: 'l1' }, [
          el('span', { class: 'nm', text: name }),
          convo.kind === 'demo' ? el('span', { class: 'chip', text: 'demo' }) : null,
          convo.archived ? el('span', { class: 'chip', text: 'Archived' }) : null,
          el('span', { class: 'tm', text: fmtDay(convo.last?.ts || convo.created) })
        ]),
        el('div', { class: 'l2' }, [
          preview,
          unread > 0 ? el('span', { class: 'bdg', text: unread > 99 ? '99+' : String(unread) }) : null
        ])
      ])
    ])

    const wrap = el('div', { class: 'rowWrap' }, [arch, del, row])
    attachGestures(wrap, row, del, arch, convo)
    return wrap
  }

  /* ------------------------------------- gestures: swipe, tap, long-press */

  function closeOpenSwipe () {
    if (!openSwipe) return
    openSwipe.row.style.transition = 'transform .18s ease'
    openSwipe.row.style.transform = 'translateX(0)'
    openSwipe.del.classList.remove('show')
    openSwipe = null
  }

  function attachGestures (wrap, row, del, arch, convo) {
    let startX = 0
    let startY = 0
    let dx = 0
    let pressed = false
    let dragging = false
    let longFired = false

    const settle = (offset) => {
      row.style.transition = 'transform .18s ease'
      row.style.transform = `translateX(${offset}px)`
    }

    wrap.addEventListener('pointerdown', (event) => {
      if (event.button > 0) return
      if (del.contains(event.target)) return       // Delete button handles itself
      pressed = true; dragging = false; longFired = false; dx = 0
      startX = event.clientX; startY = event.clientY
      clearTimeout(pressTimer)
      pressTimer = setTimeout(() => {
        if (pressed && !dragging) { longFired = true; rowMenu(convo) }
      }, LONG_PRESS_MS)
      try { wrap.setPointerCapture(event.pointerId) } catch { /* unsupported */ }
    })

    wrap.addEventListener('pointermove', (event) => {
      if (!pressed) return
      const mx = event.clientX - startX
      const my = event.clientY - startY
      if (!dragging) {
        if (Math.abs(mx) > DRAG_SLOP_PX && Math.abs(mx) > Math.abs(my)) {
          dragging = true
          clearTimeout(pressTimer)
          row.style.transition = 'none'
        } else if (Math.abs(my) > DRAG_SLOP_PX) {
          pressed = false                          // vertical scroll wins
          clearTimeout(pressTimer)
          return
        } else return
      }
      dx = mx
      const base = openSwipe && openSwipe.row === row ? -SWIPE_OPEN_PX : 0
      const offset = Math.max(-SWIPE_OPEN_PX - 26, Math.min(SWIPE_OPEN_PX + 12, base + dx))
      row.style.transform = `translateX(${offset}px)`
      arch.classList.toggle('show', offset > 6)
      del.classList.toggle('show', offset < -6)
    })

    const finish = (event) => {
      clearTimeout(pressTimer)
      if (!pressed) return
      pressed = false
      const wasOpen = openSwipe && openSwipe.row === row
      if (dragging) {
        const offset = (wasOpen ? -SWIPE_OPEN_PX : 0) + dx
        arch.classList.remove('show')
        if (offset <= -SWIPE_COMMIT_PX) {
          if (openSwipe && openSwipe.row !== row) closeOpenSwipe()
          settle(-SWIPE_OPEN_PX)
          del.classList.add('show')
          openSwipe = { row, del }
        } else if (dx >= SWIPE_COMMIT_PX && !wasOpen) {
          settle(0)
          del.classList.remove('show')
          const target = !convo.archived
          db.setArchived(convo.roomId, target)
          ctx.toast(target ? 'Archived' : 'Unarchived')
        } else {
          settle(0)
          del.classList.remove('show')
          if (wasOpen) openSwipe = null
        }
      } else if (!longFired && event.type === 'pointerup') {
        if (openSwipe) { closeOpenSwipe(); return } // tap closes a revealed row
        ctx.openThread(convo.roomId)
      }
    }
    wrap.addEventListener('pointerup', finish)
    wrap.addEventListener('pointercancel', finish)
  }

  /* ----------------------------------------------------- live wiring */

  function update () {
    clear(meBtn)
    meBtn.appendChild(avatar(db.profile() || {}, 34))
    renderTabCounts()
    renderList()
    if (dropOpen) renderDrop()      // keep presence dots in the dropdown live
  }

  root.appendChild(bar)
  root.appendChild(searchWell)
  root.appendChild(archRow)
  root.appendChild(tabsEl)
  root.appendChild(archHead)
  root.appendChild(scroll)

  update()

  const onDocPointerDown = (event) => {
    if (!searchWell.contains(event.target)) hideDrop()   // outside tap dismisses
  }
  document.addEventListener('pointerdown', onDocPointerDown)

  const unsubDb = db.subscribe(update)
  const unsubLobby = lobby.subscribe(update)

  return () => {
    unsubDb()
    unsubLobby()
    document.removeEventListener('pointerdown', onDocPointerDown)
    clearTimeout(pressTimer)
    clearTimeout(searchTimer)
    searchSeq += 1                  // any in-flight registry response is dropped
    if (newChatEl) { newChatEl.remove(); newChatEl = null }
    root.classList.remove('v-inbox')
  }
}
