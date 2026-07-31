/**
 * Spot Me — the participant picker, shared by group creation and "Add members".
 *
 * WHY IT SEARCHES THE SERVER
 * The first version listed local contacts only. On a fresh device that list is
 * empty, so the picker showed "no contacts yet" with a disabled Next button and
 * group creation was simply impossible — you could name a group and then hit a
 * wall. WhatsApp avoids this by letting you type a phone number that is not in
 * your address book; the equivalent here is an @username, which the registry
 * can resolve. So: contacts first (fast, offline, no round trip), then an exact
 * handle lookup for anyone else.
 *
 * One picker for both callers on purpose. Two copies would drift, and the
 * "can I add a stranger" rule is exactly the kind that must not differ between
 * creating a group and growing one.
 */
import { db } from '../lib/db.js'
import { searchUsers } from '../lib/api.js'
import { el, clear, avatar } from '../lib/ui.js'

const LOOKUP_DEBOUNCE_MS = 350
/** One character is enough to search. This used to demand a COMPLETE 3-16 char
 *  handle before it would even ask the server, which is why @yuva was
 *  unreachable by typing "yu" — see searchUsers() in lib/api.js. */
const HANDLE_PREFIX = /^[a-z0-9_]{1,16}$/

/**
 * @param selected Map(userId -> {id,name,username,avatar}) — mutated in place
 *                 so the caller can read the picks without a callback dance.
 * @param exclude  Set(userId) already in the group; shown as "in", not tappable.
 * @param onChange fired after every add/remove so hosts can re-label buttons.
 */
export function buildPicker ({ selected, exclude = new Set(), onChange = () => {} }) {
  let lookupTimer = null
  let remotes = []           // everyone the registry matched on this prefix
  let searching = false

  const search = el('input', {
    class: 'gw-input',
    type: 'text',
    placeholder: 'Search contacts or type a @username',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false'
  })
  const chips = el('div', { class: 'gw-chips' })
  const list = el('div', { class: 'gw-list' })
  const node = el('div', { class: 'gw-picker' }, [search, chips, list])

  const toggle = (person) => {
    if (selected.has(person.id)) selected.delete(person.id)
    else selected.set(person.id, person)
    refresh()
    onChange()
  }

  /* Selected people ride at the top as removable chips — WhatsApp's pattern,
   * and the only way to see who you picked once the list is scrolled or the
   * search query has moved on to someone else. */
  function drawChips () {
    clear(chips)
    if (!selected.size) { chips.style.display = 'none'; return }
    chips.style.display = ''
    for (const person of selected.values()) {
      chips.appendChild(el('button', {
        class: 'gw-chip',
        type: 'button',
        'aria-label': `Remove ${person.name || person.username}`,
        onclick: () => toggle(person)
      }, [
        avatar(person, 22),
        el('span', { text: person.name || `@${person.username}` }),
        el('span', { class: 'gw-chip-x', text: '×' })
      ]))
    }
  }

  function row (person, { already = false } = {}) {
    const on = selected.has(person.id)
    return el('div', {
      class: 'gw-pick' + (on ? ' on' : '') + (already ? ' done' : ''),
      onclick: already ? undefined : () => toggle(person)
    }, [
      avatar(person, 40),
      el('div', { class: 'gw-pick-text' }, [
        el('span', { class: 'gw-pick-nm', text: person.name || 'Unknown' }),
        person.username ? el('span', { class: 'gw-pick-un', text: `@${person.username}` }) : null
      ]),
      el('span', { class: 'gw-tick', text: already ? 'in' : (on ? '✓' : '') })
    ])
  }

  function refresh () {
    const q = search.value.trim().toLowerCase().replace(/^@/, '')
    drawChips()
    clear(list)

    const contacts = db.contacts()
      .filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.username || '').includes(q))

    for (const c of contacts) list.appendChild(row(c, { already: exclude.has(c.id) }))

    // The registry search only ever ADDS rows; it never replaces contact
    // results, so a local match is never hidden by a slower network one.
    const fresh = remotes.filter((r) => !contacts.some((c) => c.id === r.id))
    if (fresh.length) {
      list.appendChild(el('div', { class: 'gw-sec', text: 'Found by username' }))
      for (const r of fresh) {
        list.appendChild(row(
          { id: r.id, name: r.name, username: r.username, avatar: r.avatarUrl },
          { already: exclude.has(r.id) }
        ))
      }
    }

    if (!list.children.length) {
      list.appendChild(el('p', {
        class: 'gw-hint',
        text: searching
          ? 'Searching…'
          : q
            ? (HANDLE_PREFIX.test(q)
                ? `No one found starting with “${q}”.`
                : 'Usernames are a-z, 0-9 and _ only.')
            : 'Start typing a name or @username to find people.'
      }))
    }
  }

  const normalise = (value) => String(value || '').trim().toLowerCase().replace(/^@+/, '')

  async function runLookup () {
    const q = normalise(search.value)
    if (!HANDLE_PREFIX.test(q)) { remotes = []; searching = false; refresh(); return }
    searching = true
    refresh()
    const found = await searchUsers(q, { excludeId: db.profile()?.id })
    // A slower reply from an earlier keystroke must not overwrite a newer one.
    if (normalise(search.value) !== q) return
    remotes = found
    searching = false
    refresh()
  }

  search.addEventListener('input', () => {
    refresh()
    clearTimeout(lookupTimer)
    lookupTimer = setTimeout(runLookup, LOOKUP_DEBOUNCE_MS)
  })

  refresh()
  return { node, refresh, dispose: () => clearTimeout(lookupTimer), focus: () => search.focus() }
}
