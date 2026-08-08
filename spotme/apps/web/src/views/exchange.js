/**
 * Exchange route — the React island's only entry into the live app.
 *
 * Unlike every other slice, Exchange is GREENFIELD: there is no legacy
 * `views/exchange.js` screen to keep alive. So with the flag off this route
 * renders an explicit "not enabled" note rather than a legacy fallback, and
 * the surface is simply absent -- which is exactly today's behaviour.
 *
 * ADR-035 §(g) tier 1: flipping `spotme.ui.exchange` off restores that state
 * on the next render. Nothing here persists anything.
 */
import { mountIsland, unmountIsland, uiFlag } from '../lib/island.js'

/* Re-exported for main.js's bar filter (the Exchange tab shows only on an
 * opted-in device). main.js reads the flag through THIS view rather than the
 * island host directly, so the slice-2 parity fence's claim — main.js carries
 * no island wiring — stays true. */
export { uiFlag }
import { buildExchangePort } from '../lib/exchange-api.js'
import { el, clear } from '../lib/ui.js'

export function render (root) {
  clear(root)
  const host = el('div', { class: 'x-host' })
  root.appendChild(host)

  if (!uiFlag('exchange')) {
    host.appendChild(el('p', {
      class: 'x-note',
      text: 'Exchange is not enabled on this device.'
    }))
    return
  }

  // Dynamic: the surface is a separate chunk, fetched only when opted in.
  // LIVE port: the island talks to /api/v1/exchange through this adapter.
  mountIsland('exchange', host, (mod) => mod.__mountExchange(buildExchangePort())).catch(() => {
    clear(host)
    host.appendChild(el('p', { class: 'x-note', text: 'Exchange could not load.' }))
  })
}

export function teardown () { void unmountIsland() }
