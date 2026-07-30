/**
 * Spot Me — three-step group creation.
 *
 * Steps exist because the three questions have different stakes. Naming is
 * throwaway, choosing members is social, and the visibility choice is the one
 * that decides whether the server can read the group at all — putting that on
 * the same screen as a name field is how people pick it without reading it.
 *
 * PRIVATE keeps the room key on the devices; the invite link carries it in the
 * URL fragment, which browsers never send to a server. PUBLIC hands the key to
 * the server so anyone can join by @username. Step 3 says so in plain words.
 */
import { db, randomHex } from '../lib/db.js'
import { rooms } from '../lib/rooms.js'
import { groupsApi } from '../lib/groups-api.js'
import { el, clear, avatar } from '../lib/ui.js'

const NAME_MAX = 40
const MIN_MEMBERS = 2
const CHECK_DEBOUNCE_MS = 400
const CLOSE_MS = 160
const USERNAME_RE = /^[a-z0-9_]{3,16}$/

/**
 * Opens the wizard. Returns a close() so the caller can tear it down on
 * unmount — a sheet outliving its view is a ghost that still writes to the db.
 */
export function openGroupWizard (host, ctx) {
  const state = {
    step: 1,
    name: '',
    members: new Set(),
    visibility: 'PRIVATE',
    username: '',
    usernameOk: false,
    membersCanAdd: true,
    membersCanMessage: true,
    membersCanMedia: true,
    busy: false
  }

  const body = el('div', { class: 'gw-body' })
  const backdrop = el('div', { class: 'as-backdrop' })
  let checkTimer = null

  function close () {
    clearTimeout(checkTimer)
    backdrop.classList.add('closing')
    setTimeout(() => backdrop.remove(), CLOSE_MS)
  }

  const go = (step) => { state.step = step; draw() }

  /* ------------------------------------------------------------- create */

  async function create () {
    if (state.busy) return
    const name = state.name.trim()
    const memberIds = [...state.members]
    if (state.visibility === 'PUBLIC' && !state.usernameOk) {
      ctx.toast('Pick an available @username first')
      return
    }
    state.busy = true
    draw()

    const roomId = randomHex(16)
    const secret = randomHex(16)
    const payload = {
      roomId,
      name,
      memberIds,
      visibility: state.visibility,
      membersCanAdd: state.membersCanAdd,
      membersCanMessage: state.membersCanMessage,
      membersCanMedia: state.membersCanMedia
    }
    // The key is sent ONLY for public groups. Sending it for a private one
    // would quietly destroy the property the private option is chosen for.
    if (state.visibility === 'PUBLIC') {
      payload.username = state.username
      payload.secretKey = secret
    }

    try {
      const group = await groupsApi.create(payload)
      db.upsertConvo({
        roomId,
        secret,
        kind: 'group',
        mode: 'meet',
        title: name,
        groupId: group.id,
        peer: { id: null, name, avatar: null, lang: 'en' }
      })
      rooms.ensure(roomId)
      close()
      ctx.openThread(roomId)
    } catch (err) {
      state.busy = false
      draw()
      // Server messages here are written for people ("that username is taken",
      // "unknown or deactivated user(s): …"), so they are shown as-is.
      ctx.toast(String(err?.message || 'Could not create the group'))
    }
  }

  /* -------------------------------------------------------------- step 1 */

  function stepName () {
    const input = el('input', {
      class: 'gw-input',
      type: 'text',
      maxlength: String(NAME_MAX),
      placeholder: 'Group name',
      autocomplete: 'off',
      value: state.name
    })
    const next = () => {
      state.name = input.value.trim()
      if (!state.name) { ctx.toast('Give the group a name first'); input.focus(); return }
      go(2)
    }
    input.addEventListener('input', () => { state.name = input.value.trim() })
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') next() })

    body.appendChild(el('div', { class: 'gw-step' }, [
      el('div', { class: 'gw-title', text: 'New group' }),
      el('p', { class: 'gw-hint', text: 'Step 1 of 3 — what is it called?' }),
      input,
      el('div', { class: 'gw-actions' }, [
        el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: close }),
        el('button', { class: 'pill ok', type: 'button', text: 'Next', onclick: next })
      ])
    ]))
    input.focus()
  }

  /* -------------------------------------------------------------- step 2 */

  function stepMembers () {
    const contacts = db.contacts()
    const search = el('input', {
      class: 'gw-input',
      type: 'text',
      placeholder: 'Search contacts...',
      autocomplete: 'off'
    })
    const list = el('div', { class: 'gw-list' })
    const nextBtn = el('button', { class: 'pill ok', type: 'button', text: 'Next' })

    const refresh = () => {
      const q = search.value.trim().toLowerCase()
      clear(list)
      const shown = contacts.filter((c) => !q || (c.name || '').toLowerCase().includes(q))
      if (!shown.length) {
        list.appendChild(el('p', {
          class: 'gw-hint',
          text: contacts.length
            ? 'Nobody matches that search.'
            : 'No contacts yet — meet someone first, then make a group.'
        }))
      }
      shown.forEach((c) => {
        const on = state.members.has(c.id)
        list.appendChild(el('div', {
          class: 'gw-pick' + (on ? ' on' : ''),
          onclick () {
            if (state.members.has(c.id)) state.members.delete(c.id)
            else state.members.add(c.id)
            refresh()
          }
        }, [
          avatar(c, 40),
          el('span', { class: 'gw-pick-nm', text: c.name || 'Unknown' }),
          el('span', { class: 'gw-tick', text: on ? '✓' : '' })
        ]))
      })
      const n = state.members.size
      nextBtn.textContent = n < MIN_MEMBERS ? `Pick ${MIN_MEMBERS - n} more` : `Next · ${n}`
      nextBtn.disabled = n < MIN_MEMBERS
    }

    nextBtn.addEventListener('click', () => { if (state.members.size >= MIN_MEMBERS) go(3) })
    search.addEventListener('input', refresh)

    body.appendChild(el('div', { class: 'gw-step' }, [
      el('div', { class: 'gw-title', text: state.name }),
      el('p', { class: 'gw-hint', text: `Step 2 of 3 — add at least ${MIN_MEMBERS} people.` }),
      search,
      list,
      el('div', { class: 'gw-actions' }, [
        el('button', { class: 'as-item cancel', type: 'button', text: 'Back', onclick: () => go(1) }),
        nextBtn
      ])
    ]))
    refresh()
  }

  /* -------------------------------------------------------------- step 3 */

  function toggleRow (label, key, note) {
    const on = state[key]
    return el('div', {
      class: 'gw-toggle' + (on ? ' on' : ''),
      onclick () { state[key] = !state[key]; draw() }
    }, [
      el('div', { class: 'gw-toggle-text' }, [
        el('span', { class: 'gw-toggle-nm', text: label }),
        note ? el('span', { class: 'gw-toggle-note', text: note }) : null
      ]),
      el('span', { class: 'gw-switch' })
    ])
  }

  function stepVisibility () {
    const status = el('p', { class: 'gw-hint', text: '' })
    const handle = el('input', {
      class: 'gw-input',
      type: 'text',
      maxlength: '16',
      placeholder: 'group_handle',
      autocomplete: 'off',
      value: state.username
    })

    const check = async () => {
      const value = handle.value.trim().toLowerCase()
      state.username = value
      state.usernameOk = false
      if (!USERNAME_RE.test(value)) {
        status.textContent = value ? '3-16 characters: a-z, 0-9, _' : ''
        return
      }
      status.textContent = 'Checking…'
      try {
        const { available, reason } = await groupsApi.usernameAvailable(value)
        // Late replies from an earlier keystroke must not overwrite a newer one.
        if (handle.value.trim().toLowerCase() !== value) return
        state.usernameOk = Boolean(available)
        status.textContent = available ? `@${value} is free` : (reason || `@${value} is taken`)
      } catch {
        status.textContent = 'Could not check that handle'
      }
    }
    handle.addEventListener('input', () => {
      clearTimeout(checkTimer)
      checkTimer = setTimeout(check, CHECK_DEBOUNCE_MS)
    })

    const pick = (value) => () => { state.visibility = value; draw() }
    const isPublic = state.visibility === 'PUBLIC'

    body.appendChild(el('div', { class: 'gw-step' }, [
      el('div', { class: 'gw-title', text: state.name }),
      el('p', { class: 'gw-hint', text: 'Step 3 of 3 — who can get in?' }),

      el('div', { class: 'gw-seg' }, [
        el('button', {
          class: 'gw-seg-b' + (isPublic ? '' : ' on'),
          type: 'button',
          text: 'Private',
          onclick: pick('PRIVATE')
        }),
        el('button', {
          class: 'gw-seg-b' + (isPublic ? ' on' : ''),
          type: 'button',
          text: 'Public',
          onclick: pick('PUBLIC')
        })
      ]),
      el('p', {
        class: 'gw-note',
        text: isPublic
          ? 'Anyone can find and join with the @handle. The server holds the key, so it can read this group.'
          : 'Invite-link only. The key never leaves your devices — the server cannot read this group.'
      }),

      isPublic ? handle : null,
      isPublic ? status : null,

      el('div', { class: 'gw-sec', text: 'Members can' }),
      toggleRow('Add people', 'membersCanAdd'),
      toggleRow('Send messages', 'membersCanMessage', 'Off makes it announce-only'),
      toggleRow('Send photos and video', 'membersCanMedia'),

      el('div', { class: 'gw-actions' }, [
        el('button', { class: 'as-item cancel', type: 'button', text: 'Back', onclick: () => go(2) }),
        el('button', {
          class: 'pill ok',
          type: 'button',
          text: state.busy ? 'Creating…' : 'Create',
          disabled: state.busy,
          onclick: create
        })
      ])
    ]))
  }

  /* ---------------------------------------------------------------- draw */

  function draw () {
    clear(body)
    if (state.step === 1) stepName()
    else if (state.step === 2) stepMembers()
    else stepVisibility()
  }

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  backdrop.appendChild(el('div', { class: 'as-sheet gw' }, [body]))
  host.appendChild(backdrop)
  draw()

  return close
}
