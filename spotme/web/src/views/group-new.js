/**
 * Spot Me — three-step group creation, in WhatsApp's order.
 *
 * PEOPLE FIRST, THEN THE NAME. The first version asked for a name first, and a
 * device with no contacts then hit a member step with nothing in it and a
 * disabled Next — you could name a group and discover only afterwards that you
 * could not make one. Asking for people first means the wall, if there is one,
 * appears before any work is invested, and the picker can now resolve an
 * @username so there need not be a wall at all.
 *
 * Visibility stays on its own last step because it is the one choice that
 * decides whether the server can read the group. PRIVATE keeps the room key in
 * the invite-URL fragment, which browsers never send to a server; PUBLIC hands
 * the key over so anyone can join by @handle. The step says so in those words.
 */
import { db, randomHex } from '../lib/db.js'
import { rooms } from '../lib/rooms.js'
import { groupsApi } from '../lib/groups-api.js'
import { buildPicker } from './member-picker.js'
import { el, clear } from '../lib/ui.js'

const NAME_MAX = 40
/** The server refuses fewer (CreateGroupDto @ArrayMinSize(2)); asking for more
 *  here than the server does would be a second, invisible rule. */
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
    members: new Map(),        // userId -> person, shared with the picker
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
  let picker = null

  function close () {
    clearTimeout(checkTimer)
    picker?.dispose()
    backdrop.classList.add('closing')
    setTimeout(() => backdrop.remove(), CLOSE_MS)
  }

  const go = (step) => { state.step = step; draw() }

  /* ------------------------------------------------------------- create */

  async function create () {
    if (state.busy) return
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
      name: state.name.trim(),
      memberIds: [...state.members.keys()],
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
        title: payload.name,
        groupId: group.id,
        peer: { id: null, name: payload.name, avatar: null, lang: 'en' }
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

  /* ----------------------------------------------------- step 1: people */

  function stepMembers () {
    const nextBtn = el('button', { class: 'pill ok', type: 'button', text: 'Next' })

    const relabel = () => {
      const n = state.members.size
      nextBtn.textContent = n < MIN_MEMBERS
        ? `Add ${MIN_MEMBERS - n} more`
        : `Next · ${n}`
      nextBtn.disabled = n < MIN_MEMBERS
    }

    picker?.dispose()
    picker = buildPicker({ selected: state.members, onChange: relabel })
    nextBtn.addEventListener('click', () => { if (state.members.size >= MIN_MEMBERS) go(2) })

    body.appendChild(el('div', { class: 'gw-step' }, [
      el('div', { class: 'gw-title', text: 'Add members' }),
      el('p', { class: 'gw-hint', text: `Step 1 of 3 — pick at least ${MIN_MEMBERS} people.` }),
      picker.node,
      el('div', { class: 'gw-actions' }, [
        el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: close }),
        nextBtn
      ])
    ]))
    relabel()
    picker.focus()
  }

  /* ------------------------------------------------------- step 2: name */

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
      go(3)
    }
    input.addEventListener('input', () => { state.name = input.value.trim() })
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') next() })

    const who = [...state.members.values()]
      .map((p) => p.name || `@${p.username}`).join(', ')

    body.appendChild(el('div', { class: 'gw-step' }, [
      el('div', { class: 'gw-title', text: 'Name this group' }),
      el('p', { class: 'gw-hint', text: `Step 2 of 3 — ${state.members.size} members: ${who}` }),
      input,
      el('div', { class: 'gw-actions' }, [
        el('button', { class: 'as-item cancel', type: 'button', text: 'Back', onclick: () => go(1) }),
        el('button', { class: 'pill ok', type: 'button', text: 'Next', onclick: next })
      ])
    ]))
    input.focus()
  }

  /* ------------------------------------------------- step 3: visibility */

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
      autocapitalize: 'none',
      spellcheck: 'false',
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
    if (state.step === 1) stepMembers()
    else if (state.step === 2) stepName()
    else stepVisibility()
  }

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  backdrop.appendChild(el('div', { class: 'as-sheet gw' }, [body]))
  host.appendChild(backdrop)
  draw()

  return close
}
