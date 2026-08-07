/**
 * Spot Me — group roles and permissions.
 *
 * Every gate here mirrors groups.service.ts exactly. That duplication is
 * deliberate: the server is the authority and will refuse anything it does not
 * allow, but an action that appears and then fails reads as a broken app
 * rather than a rule. So the UI hides what the server would refuse, and still
 * shows the server's own words when a call is refused anyway.
 *
 * Server rules encoded below:
 *   name/avatar        rank >= ADMIN
 *   visibility, member defaults, per-member grants   OWNER only
 *   role changes       OWNER or canAddAdmin, never at or above your own rank
 *   ban/mute/remove    OWNER or the matching grant, target must rank lower
 *   transfer, delete   OWNER only
 */
import './groups.css'
import { db } from '../lib/db.js'
import { rooms } from '../lib/rooms.js'
import { groupsApi, may, outranks, ROLE_LABEL } from '../lib/groups-api.js'
import { buildPicker } from './member-picker.js'
import { el, clear, avatar, actionSheet } from '../lib/ui.js'
import { reactGroups } from './groups-island.js'

const MUTE_CHOICES = [
  { label: 'Mute for 1 hour', minutes: 60 },
  { label: 'Mute for 8 hours', minutes: 8 * 60 },
  { label: 'Mute for a day', minutes: 24 * 60 }
]

const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>'

const isMuted = (m) => Boolean(m.mutedUntil) && new Date(m.mutedUntil).getTime() > Date.now()

export function render (root, ctx, groupId) {
  { const island = reactGroups(root, ctx, 'manage', groupId); if (island) return island } // ADR-035 slice 3 flag branch
  let group = null
  let dead = false

  const listEl = el('div', { class: 'gm-list' })
  const titleEl = el('h1', { class: 'h1', text: 'Group' })
  const subEl = el('p', { class: 'gm-sub', text: 'Loading…' })
  const settingsEl = el('div', { class: 'gm-settings' })

  const wrap = el('div', { class: 'v-groups v-gm' }, [
    el('div', { class: 'bar' }, [
      el('button', {
        class: 'gm-back',
        type: 'button',
        'aria-label': 'Back',
        html: ICON_BACK,
        onclick: () => ctx.nav('#/groups')
      }),
      el('span', { class: 'sp' })
    ]),
    titleEl,
    subEl,
    el('div', { class: 'scroll-y' }, [settingsEl, listEl])
  ])

  /** Every mutation ends the same way: re-read the truth, or say why not. */
  async function run (fn) {
    try {
      await fn()
      await load()
    } catch (err) {
      ctx.toast(String(err?.message || 'That did not work'))
    }
  }

  /* ------------------------------------------------------------- settings */

  function toggle (label, key) {
    const on = Boolean(group.permissions?.[key])
    return el('div', {
      class: 'gw-toggle' + (on ? ' on' : ''),
      onclick: () => run(() => groupsApi.update(groupId, { [key]: !on }))
    }, [
      el('div', { class: 'gw-toggle-text' }, [el('span', { class: 'gw-toggle-nm', text: label })]),
      el('span', { class: 'gw-switch' })
    ])
  }

  /**
   * Add people after the group exists — the other half of creation, and the
   * thing group info is opened for most often. Mirrors the server rule in
   * groups.service.addMember: the owner, anyone holding canControlInvites, or
   * any member when the group allows members to add.
   */
  function canAddMembers () {
    return group.myRole === 'OWNER' ||
      Boolean(group.myGrants?.canControlInvites) ||
      Boolean(group.permissions?.membersCanAdd)
  }

  function openAddMembers () {
    const selected = new Map()
    // Everyone already on the roster is shown as "in" rather than hidden, so
    // it is obvious the person you are looking for is present, not missing.
    const exclude = new Set(group.members.map((m) => m.userId))
    const backdrop = el('div', { class: 'as-backdrop' })
    const addBtn = el('button', { class: 'pill ok', type: 'button', text: 'Add' })

    const relabel = () => {
      addBtn.textContent = selected.size ? `Add ${selected.size}` : 'Add'
      addBtn.disabled = selected.size === 0
    }
    const picker = buildPicker({ selected, exclude, onChange: relabel })

    const close = () => {
      picker.dispose()
      backdrop.classList.add('closing')
      setTimeout(() => backdrop.remove(), 160)
    }

    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true
      addBtn.textContent = 'Adding…'
      const failed = []
      // One call per person: a partial success must still land the people it
      // can, and name only the ones it could not.
      for (const userId of selected.keys()) {
        try { await groupsApi.addMember(groupId, userId) } catch { failed.push(userId) }
      }
      close()
      if (failed.length) ctx.toast(`Could not add ${failed.length} of ${selected.size}`)
      else ctx.toast(selected.size === 1 ? 'Member added' : `${selected.size} members added`)
      load()
    })

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
    backdrop.appendChild(el('div', { class: 'as-sheet gw' }, [
      el('div', { class: 'gw-title', text: 'Add members' }),
      el('p', { class: 'gw-hint', text: 'Pick from contacts, or find anyone by @username.' }),
      picker.node,
      el('div', { class: 'gw-actions' }, [
        el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: close }),
        addBtn
      ])
    ]))
    wrap.appendChild(backdrop)
    relabel()
    picker.focus()
  }

  /** Private groups travel by link: the key rides in the URL fragment, which
   *  browsers never send to a server. Nothing to share without the local key. */
  async function shareInvite () {
    const convo = db.convos().find((c) => c.groupId === groupId)
    if (!convo?.secret) { ctx.toast('No invite key on this device'); return }
    const url = `${location.origin}${location.pathname}#r=${convo.roomId}&k=${convo.secret}` +
      `&g=${encodeURIComponent(group.name)}`
    if (navigator.share) {
      try { await navigator.share({ title: 'Spot Me', text: `Join ${group.name} on Spot Me`, url }); return }
      catch (err) { if (err?.name === 'AbortError') return }
    }
    try { await navigator.clipboard.writeText(url); ctx.toast('Invite link copied') }
    catch { ctx.toast('Could not share the link') }
  }

  function drawSettings () {
    clear(settingsEl)

    settingsEl.appendChild(el('div', {
      class: 'gw-note',
      text: group.visibility === 'PUBLIC'
        ? `Public as @${group.username} — the server holds the key and can read this group.`
        : 'Private — the key never reaches the server.'
    }))

    const actions = el('div', { class: 'gm-actions' })
    if (canAddMembers()) {
      actions.appendChild(el('button', {
        class: 'pill ok', type: 'button', text: 'Add members', onclick: openAddMembers
      }))
    }
    actions.appendChild(el('button', {
      class: 'pill', type: 'button', text: 'Invite via link', onclick: shareInvite
    }))
    settingsEl.appendChild(actions)

    // Member defaults are owner-only server-side; showing them to an admin
    // would be showing a switch that always throws.
    if (group.myRole === 'OWNER') {
      settingsEl.appendChild(el('div', { class: 'gw-sec', text: 'Members can' }))
      settingsEl.appendChild(toggle('Add people', 'membersCanAdd'))
      settingsEl.appendChild(toggle('Send messages', 'membersCanMessage'))
      settingsEl.appendChild(toggle('Send photos and video', 'membersCanMedia'))
    }

    settingsEl.appendChild(el('div', { class: 'gw-sec', text: `Members · ${group.members.length}` }))
  }

  /* -------------------------------------------------------------- members */

  function memberMenu (m) {
    const items = []
    const canAct = outranks(group.myRole, m.role)

    if (canAct && may(group, 'canAddAdmin')) {
      for (const role of ['ADMIN', 'MODERATOR', 'MEMBER']) {
        // "at or above your own rank" is refused server-side; do not offer it.
        if (role === m.role || !outranks(group.myRole, role)) continue
        items.push({
          label: `Make ${ROLE_LABEL[role].toLowerCase()}`,
          fn: () => run(() => groupsApi.setRole(groupId, m.userId, role))
        })
      }
    }

    if (canAct && may(group, 'canMute')) {
      if (isMuted(m)) {
        items.push({ label: 'Unmute', fn: () => run(() => groupsApi.setMute(groupId, m.userId, null)) })
      } else {
        for (const choice of MUTE_CHOICES) {
          items.push({
            label: choice.label,
            fn: () => run(() => groupsApi.setMute(groupId, m.userId, choice.minutes))
          })
        }
      }
    }

    if (canAct && may(group, 'canBan')) {
      items.push(m.bannedAt
        ? { label: 'Lift ban', fn: () => run(() => groupsApi.setBan(groupId, m.userId, false)) }
        : { label: 'Ban from group', danger: true, fn: () => run(() => groupsApi.setBan(groupId, m.userId, true)) })
    }

    if (canAct && may(group, 'canRemove')) {
      items.push({
        label: 'Remove from group',
        danger: true,
        fn: () => run(() => groupsApi.removeMember(groupId, m.userId))
      })
    }

    if (group.myRole === 'OWNER' && m.role !== 'OWNER') {
      items.push({
        label: 'Transfer ownership',
        danger: true,
        fn: () => run(() => groupsApi.transfer(groupId, m.userId))
      })
    }

    if (!items.length) { ctx.toast('You cannot manage this member'); return }
    actionSheet(items, m.name || m.username || 'Member')
  }

  function drawMembers () {
    clear(listEl)
    for (const m of group.members) {
      const marks = []
      if (m.bannedAt) marks.push('banned')
      else if (isMuted(m)) marks.push('muted')

      listEl.appendChild(el('div', {
        class: 'gm-row' + (m.bannedAt ? ' out' : ''),
        onclick: () => memberMenu(m)
      }, [
        avatar({ name: m.name || m.username, avatar: m.avatarUrl }, 44),
        el('div', { class: 'mid' }, [
          el('div', { class: 'l1' }, [
            el('span', { class: 'nm', text: m.name || m.username || 'Member' }),
            el('span', { class: 'gm-role', text: ROLE_LABEL[m.role] || m.role })
          ]),
          el('div', { class: 'l2' }, [
            el('span', { class: 'pv', text: m.username ? `@${m.username}` : '' }),
            marks.length ? el('span', { class: 'gm-mark', text: marks.join(' · ') }) : null
          ])
        ])
      ]))
    }

    /* ------------------------------------------------------------ danger */

    const convo = db.convos().find((c) => c.groupId === groupId)
    const footer = el('div', { class: 'gm-danger' })

    footer.appendChild(el('button', {
      class: 'as-item danger',
      type: 'button',
      text: 'Leave group',
      onclick: () => run(async () => {
        await groupsApi.leave(groupId)
        if (convo) {
          try { rooms.leave(convo.roomId) } catch { /* never connected */ }
          db.removeConvo(convo.roomId)
        }
        ctx.toast('You left the group')
        ctx.nav('#/groups')
      })
    }))

    if (group.myRole === 'OWNER') {
      footer.appendChild(el('button', {
        class: 'as-item danger',
        type: 'button',
        text: 'Delete group',
        onclick: async () => {
          // actionSheet resolves with the chosen label, null on cancel.
          const ok = await actionSheet(
            [{ label: 'Delete for everyone', danger: true }],
            'Recoverable for 30 days, then gone'
          )
          if (!ok) return
          run(async () => {
            await groupsApi.remove(groupId)
            if (convo) db.removeConvo(convo.roomId)
            ctx.toast('Group deleted')
            ctx.nav('#/groups')
          })
        }
      }))
    }
    listEl.appendChild(footer)
  }

  /* ------------------------------------------------------------------ io */

  async function load () {
    try {
      const next = await groupsApi.getOne(groupId)
      if (dead) return
      group = next
      titleEl.textContent = group.name
      subEl.textContent = `${ROLE_LABEL[group.myRole] || 'Member'} · ${group.members.length} members`
      drawSettings()
      drawMembers()
    } catch (err) {
      if (dead) return
      subEl.textContent = String(err?.message || 'Could not load this group')
    }
  }

  root.appendChild(wrap)
  load()

  return () => { dead = true }
}
