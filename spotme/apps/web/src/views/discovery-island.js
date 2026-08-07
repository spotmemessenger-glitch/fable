/**
 * Slice 5 — the Discovery flag branch, in exactly one place.
 *
 * `spotme.ui.discovery` (default OFF) is read HERE and nowhere else; legacy
 * views/discovery.js carries a one-line call to `reactDiscovery()` and is
 * otherwise unmodified (ADR-035 §(f) #1, #2). With the flag off this returns
 * null immediately — no dynamic import runs — and the caller renders the
 * legacy view. That is the whole of §(g) tier-1 rollback.
 *
 * ADR-024 (P0 privacy fence): the React path REUSES lib/discovery.js — the
 * same lobby singleton, the same coarse() broadcast, the same announce path
 * the coarse-broadcast test drives. This module adds NO outbound path: no
 * geolocation, no room join, no send. What crosses the port toward the React
 * package is coordinate-free by construction — formatted distance labels,
 * approximate metres, and RELATIVE offsets derived from the already-coarse
 * broadcast values. `computeDiscoverySnapshot` is exported (pure, helpers
 * injected) so test/discovery-coarse-broadcast.test.js can assert that against
 * the React path with the same precision-leak assertions as the legacy path.
 *
 * §(g) tier 3: the only persisted writes are db.setSettings({ rangeM }) and
 * db.setSettings({ showOnMap }) — the exact keys and shapes the legacy view
 * writes. Nothing new is persisted.
 */
import { uiFlag, mountIsland, unmountIsland } from '../lib/island.js'

const M_PER_DEG_LAT = 110540

/**
 * Build the coordinate-free snapshot the React package receives.
 *
 * Pure: everything it reads arrives as arguments, so the privacy fence test
 * can drive it in bare Node with the same PRECISE fix it feeds the lobby and
 * assert no coordinate — precise or coarse — survives into the result.
 *
 * @param {object} args
 * @param {{name?:string,avatar?:string,lang?:string}} args.profile
 * @param {{showOnMap?:boolean,rangeM?:number}} args.settings
 * @param {Array<object>} args.peers      lobby.peers() (coarse lat/lon by ADR-024)
 * @param {{lat:number,lon:number}|null} args.myPosition  PRECISE, device-local
 * @param {Set<string>} args.chatPeerIds  peers with an existing conversation
 * @param {{distanceM:Function,fmtDistance:Function,langName:Function}} args.helpers
 */
export function computeDiscoverySnapshot ({ profile, settings, peers, myPosition, chatPeerIds, helpers }) {
  const { distanceM, fmtDistance, langName } = helpers
  const at = myPosition
  const mPerDegLon = at ? 111320 * Math.cos(at.lat * Math.PI / 180) : 0
  return {
    me: { name: profile.name || 'Me', avatarUrl: profile.avatar || null },
    myLangLabel: langName(profile.lang || 'en') || profile.lang || 'en',
    visible: settings.showOnMap !== false,
    located: Boolean(at),
    rangeM: settings.rangeM || 100,
    peers: peers.map((p) => {
      const dist = at ? distanceM(at, p) : null
      const hasPos = at && p.lat != null && p.lon != null
      return {
        id: p.id,
        name: p.name || 'Someone',
        avatarUrl: p.avatar || null,
        langLabel: langName(p.lang) || p.lang || '?',
        distLabel: fmtDistance(dist),
        distM: dist,
        age: p.age ?? null,
        tags: Array.isArray(p.tags) ? p.tags : [],
        hasChat: chatPeerIds.has(p.id),
        // Relative metres from the viewer (east+, north+): the only spatial
        // information that crosses the port. No absolute coordinate survives.
        offsetM: hasPos
          ? {
              x: Math.round((p.lon - at.lon) * mPerDegLon),
              y: Math.round((p.lat - at.lat) * M_PER_DEG_LAT)
            }
          : null
      }
    })
  }
}

/**
 * @param {HTMLElement} root
 * @param {{ openThread(id:string):void, toast(m:string):void }} ctx
 * @returns {null | (() => void)} null when the flag is off (render legacy).
 */
export function reactDiscovery (root, ctx) {
  if (!uiFlag('discovery')) return null
  mount(root, ctx)
  return () => { void unmountIsland() }
}

async function mount (root, ctx) {
  try {
    // Loaded only on the opted-in path: the flag-off cost of this module is zero.
    const [{ db }, disc, { reach }, { langName }] = await Promise.all([
      import('../lib/db.js'),
      import('../lib/discovery.js'),
      import('../lib/reach.js'),
      import('../lib/translate.js')
    ])
    const { lobby, distanceM, fmtDistance } = disc
    const helpers = { distanceM, fmtDistance, langName }

    let snap = null
    const listeners = new Set()
    const invalidate = () => { snap = null; listeners.forEach((fn) => fn()) }
    const myId = () => (db.profile() || {}).id

    const compute = () => {
      const chatPeerIds = new Set()
      for (const c of db.convos()) if (c.peer?.id) chatPeerIds.add(c.peer.id)
      return computeDiscoverySnapshot({
        profile: db.profile() || {},
        settings: db.settings(),
        peers: lobby.peers().filter((p) => p.id !== myId()),
        myPosition: lobby.myPosition(),
        chatPeerIds,
        helpers
      })
    }

    const findPeer = (id) => lobby.peers().find((p) => p.id === id)
    const findConvo = (id) => db.convos().find((c) => c.peer && c.peer.id === id) || null
    const open = (peer, text, kind) => {
      const existing = findConvo(peer.id)
      if (existing) { ctx.openThread(existing.roomId); return }
      try { ctx.openThread(reach.reach(peer, text, kind)) } catch { ctx.toast('Could not start that chat') }
    }

    const port = {
      subscribe (fn) {
        listeners.add(fn)
        const unsubs = [db.subscribe(invalidate), lobby.subscribe(invalidate)]
        return () => { listeners.delete(fn); unsubs.forEach((u) => u()) }
      },
      snapshot: () => (snap ??= compute()),
      /* Legacy keys, legacy shapes (§(g) tier 3). */
      setRange (m) { db.setSettings({ rangeM: m }) },
      setVisible (on) {
        db.setSettings({ showOnMap: on })
        try { lobby.announce() } catch { /* lobby not up yet */ }
        if (!on) ctx.toast('You are hidden from the map. You can still message people.')
      },
      locate () {
        try { lobby.refreshPosition() } catch { /* geolocation unavailable */ }
        ctx.toast('Updating your position')
      },
      openChat (id) {
        const existing = findConvo(id)
        if (existing) ctx.openThread(existing.roomId)
      },
      wave (id) {
        const peer = findPeer(id)
        if (peer) open(peer, '\u{1F44B}', 'nearby')
      },
      sendRequest (id, text) {
        const peer = findPeer(id)
        if (peer) open(peer, text || '\u{1F44B}', 'nearby')
      }
    }

    const host = document.createElement('div')
    host.className = 'island-host'
    root.appendChild(host)
    await mountIsland('discovery', host, (mod) => mod.__mountDiscoveryLive(port))
  } catch {
    root.textContent = 'This screen could not load. Turn the preview flag off to restore the classic view.'
  }
}
