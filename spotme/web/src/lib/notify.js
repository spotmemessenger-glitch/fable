/**
 * Spot Me — device notifications (web tier).
 *
 * Honest scope: the browser Notification API fires only while a Spot Me tab
 * is open (foreground or background). Closed-app push needs the native app's
 * push service. Alerts here fire only when the tab is hidden — the in-app
 * bell covers the visible case.
 */

const DEFAULT_THROTTLE_MS = 3 * 60_000
const recent = new Map()   // tag -> last fired ts, so one person can't spam

export const canNotify = () => typeof Notification !== 'undefined'

export const notifyState = () => (canNotify() ? Notification.permission : 'unsupported')

export async function enableNotify () {
  if (!canNotify()) return 'unsupported'
  try { return await Notification.requestPermission() } catch { return Notification.permission }
}

export function pushNote (title, body, tag, { throttleMs = DEFAULT_THROTTLE_MS } = {}) {
  if (!canNotify() || Notification.permission !== 'granted') return
  if (!document.hidden) return
  if (tag) {
    const last = recent.get(tag) || 0
    if (Date.now() - last < throttleMs) return
    recent.set(tag, Date.now())
  }
  try {
    new Notification(title, { body: String(body || '').slice(0, 160), tag })
  } catch { /* blocked by the platform — the in-app bell still has it */ }
}
