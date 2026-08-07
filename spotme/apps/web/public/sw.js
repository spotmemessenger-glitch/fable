/**
 * Spot Me — service worker (push receiver).
 *
 * Registered from main.js at boot. No fetch handler here — this worker never
 * caches or serves app assets, only push/notification events. A stuck-on-old-
 * version bug would not come from this file.
 *
 * WHY A SERVICE WORKER AT ALL
 * A notification for a CLOSED app cannot come from page JavaScript — there is
 * no page. The browser wakes this worker instead. It is the only way to show
 * anything when Spot Me is not on screen.
 *
 * WHAT THIS CAN AND CANNOT SAY
 * Push payloads travel through a push service (Apple's or Google's). Spot Me's
 * whole point is that no server reads messages, so the payload here carries NO
 * message text — only "someone sent you something" and where to go. The real
 * content is fetched peer-to-peer after the user taps and the app opens.
 * Putting message text in a push would hand it to Apple and Google, which is
 * exactly what the rest of this codebase refuses to do.
 */

/* Take over as soon as installed rather than waiting for every tab to close —
 * a push subscription is useless until a worker is actually controlling. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/**
 * A push arrived. The payload is intentionally thin — see the header.
 *
 * Malformed or bodyless pushes still show something: browsers penalise a push
 * that displays no notification at all (Chrome substitutes its own "site was
 * updated in the background"), so there is no silent path here.
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    /* Not JSON. Fall through to the generic notification below rather than
     * throwing, which would count as a push that showed nothing. */
  }

  const title = data.title || 'Spot Me'
  const options = {
    body: data.body || 'You have something new',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    /* Same tag replaces rather than stacks: ten messages from one person
     * should be one line in the shade, not ten. */
    tag: data.tag || 'spotme',
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' }
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

/**
 * Tapping the notification. Focus an existing tab when there is one — opening
 * a second copy of a P2P app means a second lobby connection and a confusing
 * duplicate identity view.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of all) {
      if ('focus' in client) {
        if ('navigate' in client && target !== '/') {
          try { await client.navigate(target) } catch { /* closed or cross-origin */ }
        }
        return client.focus()
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target)
  })())
})
