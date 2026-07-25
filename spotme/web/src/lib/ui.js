/**
 * Spot Me — tiny DOM toolkit shared by every view. No framework: the app is
 * small enough that direct DOM work stays clearer than a render loop.
 */

export const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value   // trusted, app-authored markup only (icons)
    else if (key === 'style') node.style.cssText = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value !== null && value !== undefined) node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild) }

export function toast (message) {
  document.querySelector('.toast')?.remove()
  const node = el('div', { class: 'toast', text: message })
  document.body.appendChild(node)
  setTimeout(() => node.remove(), 2600)
}

/** Stable, pleasant gradient per name for people without photos. */
const GRADS = [
  ['#6366f1', '#06b6d4'], ['#f59e0b', '#ef4444'], ['#10b981', '#3b82f6'],
  ['#8b5cf6', '#ec4899'], ['#0ea5e9', '#22c55e'], ['#f43f5e', '#f97316']
]

/**
 * Avatar element per the locked design: photo when available, gradient
 * initials otherwise, optional green presence dot.
 */
export function avatar (person = {}, size = 40, { dot = false } = {}) {
  const wrap = el('span', { class: 'av', style: `--s:${size}px` })
  if (person.avatar) {
    wrap.appendChild(el('img', { src: person.avatar, alt: '' }))
  } else {
    let h = 0
    for (const ch of String(person.name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    const [a, b] = GRADS[h % GRADS.length]
    wrap.appendChild(el('span', {
      class: 'init',
      style: `background:linear-gradient(135deg,${a},${b})`,
      text: (person.name || '?').trim().charAt(0).toUpperCase()
    }))
  }
  if (dot) wrap.appendChild(el('span', { class: 'dot' }))
  return wrap
}

export const fmtTime = (ts) => new Date(ts)
  .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function fmtDay (ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return fmtTime(ts)
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * Bottom action sheet for long-press menus. Items: {label, danger?, fn}.
 * Resolves after the sheet closes, whichever way.
 */
export function actionSheet (items, title = '') {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'as-backdrop' })
    const close = (value) => {
      backdrop.classList.add('closing')
      setTimeout(() => { backdrop.remove(); resolve(value) }, 160)
    }
    // Sheets often open mid-long-press; the click the browser synthesizes on
    // finger-lift would otherwise land on the backdrop (instant dismiss) or a
    // sheet item. Swallow anything within 400ms of mounting.
    const mounted = Date.now()
    backdrop.addEventListener('click', (e) => {
      if (Date.now() - mounted < 400) { e.stopPropagation(); e.preventDefault() }
    }, true)
    const sheet = el('div', { class: 'as-sheet' }, [
      title ? el('div', { class: 'as-title', text: title }) : null,
      ...items.map((item) => el('button', {
        class: 'as-item' + (item.danger ? ' danger' : ''),
        type: 'button',
        text: item.label,
        onclick () { close(item.label); item.fn?.() }
      })),
      el('button', { class: 'as-item cancel', type: 'button', text: 'Cancel', onclick: () => close(null) })
    ])
    backdrop.appendChild(sheet)
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null) })
    document.body.appendChild(backdrop)
  })
}
