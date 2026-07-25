/**
 * Spot Me — Discovery view (#/discovery).
 *
 * The centrepiece is now a LIVE Google map: real peer positions in real time,
 * restyled to the locked palette, with the radar rings + sweep and people as
 * face markers layered over it. The locked design's hand-drawn street plan
 * stays in this module as the offline/bad-key fallback AND the placeholder
 * while tiles arrive — the map area is never blank.
 * People = live lobby peers, nothing else. The distance dropdown filters map
 * and list together without rebuilding the view.
 */
import './discovery.css'
import { db } from '../lib/db.js'
import { lobby, distanceM, fmtDistance } from '../lib/discovery.js'
import { langName } from '../lib/translate.js'
import { el, clear, avatar } from '../lib/ui.js'

const WAVE = '\u{1F44B}'
/** Design reference map centre (the locked screen's Whitechapel) — used only
 *  to anchor the map/radar before geolocation says otherwise. */
const FALLBACK_CENTRE = { lat: 51.5152, lon: -0.0716 }
const RING_BASES = [58, 104, 152, 196]        // drawn-ring diameters at full range (design)
const M_PER_DEG_LAT = 110540
const AGE_BUCKETS = {
  all: null,
  '18-24': [18, 24],
  '25-34': [25, 34],
  '35+': [35, 200]
}

/* -------------------------------------------------------- Google Maps API */

/* Client-side key by design — the user referrer-restricts it in the console. */
/* Browser Maps keys are necessarily visible in the shipped bundle, but they
 * are still billable — so the value lives in .env.local (gitignored) and is
 * injected at build time rather than sitting in source control.
 * Restrict it by HTTP referrer in the Google Cloud console. */
const GMAPS_KEY = import.meta.env.VITE_GMAPS_KEY || ''
const GMAPS_CB = '__spotmeGmapsReady'
/** Live radar-circle radii as fractions of rangeM (outer → inner). */
const RING_F = [1, 2 / 3, 1 / 3]
/** Fraction of the map's short edge the outer radar ring should span. */
const RING_FIT = 1.15
const EQUATOR_M_PER_PX = 156543.03392         // metres per pixel at zoom 0
const ZOOM_MIN = 3
const ZOOM_MAX = 21

/* Classic 'styles' restyle (deliberately NO mapId — a mapId would override
 * styles): light minimal look matching the locked palette. */
const GMAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#eceef2' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9aa0ad' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#ffffff' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#eceef2' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#eceef2' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#dfeede' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d6e4f0' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] }
]

/** Resolve the accent token at call time (Maps API needs a literal colour;
 *  the fallback mirrors tokens.css --blue). */
function accent () {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--blue').trim() || '#1b8a9d'
}

let gmapsLoad = null       // module singleton: the script is fetched at most once
let gmapsAuthFailed = false
let onGmapsAuthFail = null // the open view's "drop to drawn map" hook
let mapCache = null        // { maps, map, div, ready } — Map instances are reused across visits
let DomMarker = null       // class, built once the API is available

/* Google calls this when the key/referrer is rejected AFTER the script loads. */
window.gm_authFailure = () => {
  gmapsAuthFailed = true
  if (onGmapsAuthFail) onGmapsAuthFail()
}

function loadGoogleMaps () {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps)
  if (gmapsLoad) return gmapsLoad
  gmapsLoad = new Promise((resolve, reject) => {
    window[GMAPS_CB] = () => {
      delete window[GMAPS_CB]
      resolve(window.google.maps)
    }
    const s = document.createElement('script')
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + GMAPS_KEY +
      '&v=weekly&loading=async&libraries=marker&callback=' + GMAPS_CB
    s.async = true
    s.onerror = () => {
      delete window[GMAPS_CB]
      s.remove()
      gmapsLoad = null       // offline now ≠ offline forever: next visit retries
      reject(new Error('maps-load-failed'))
    }
    document.head.appendChild(s)
  })
  return gmapsLoad
}

/**
 * Custom-DOM marker for a map WITHOUT a mapId (classic 'styles' rules out
 * AdvancedMarkerElement). Lives in the overlayMouseTarget pane so taps reach
 * the element; draw() positions it via fromLatLngToDivPixel.
 */
function makeDomMarker (maps) {
  return class extends maps.OverlayView {
    constructor (pos, element) {
      super()
      this.pos = pos                 // { lat, lng }
      this.element = element
    }

    onAdd () { this.getPanes().overlayMouseTarget.appendChild(this.element) }

    draw () {
      const proj = this.getProjection()
      if (!proj) return
      const pt = proj.fromLatLngToDivPixel(new maps.LatLng(this.pos.lat, this.pos.lng))
      if (!pt) return
      this.element.style.left = `${pt.x}px`
      this.element.style.top = `${pt.y}px`
    }

    onRemove () { this.element.remove() }

    move (pos) {
      this.pos = pos
      this.draw()
    }
  }
}

/* Street plan lifted verbatim from the locked design — offline fallback. */
const PLAN_SVG = `
<svg class="plan" viewBox="0 0 372 268" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <rect width="372" height="268" fill="#eceef2"/>
  <rect x="0" y="188" width="104" height="80" fill="#dfeede"/>
  <rect x="286" y="0" width="86" height="66" fill="#d6e4f0"/>
  <g stroke="#ffffff" stroke-linecap="square">
    <path d="M0 62h372M0 132h372M0 206h372" stroke-width="15"/>
    <path d="M58 0v268M148 0v268M232 0v268M312 0v268" stroke-width="13"/>
    <path d="M0 96h372M0 168h372" stroke-width="7"/>
    <path d="M104 0v268M196 0v268M272 0v268" stroke-width="6"/>
  </g>
  <path d="M-10 152 L120 148 L196 108 L300 104 L382 70" stroke="#c3cdf0"
        stroke-width="11" fill="none" stroke-linecap="round"/>
  <g fill="#9aa0ad" font-family="system-ui,sans-serif" font-size="7.5" font-weight="600">
    <text x="8" y="59">LEMAN ST</text>
    <text x="8" y="129">WHITECHAPEL RD</text>
    <text x="8" y="203">COMMERCIAL RD</text>
    <text x="62" y="262" transform="rotate(-90 62 262)">A13</text>
    <text x="236" y="262" transform="rotate(-90 236 262)">B134</text>
    <text x="14" y="232" fill="#7f9a7c">ALTAB ALI PARK</text>
  </g>
</svg>`

const ICON_GHOST = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a8 8 0 00-8 8v11.1c0 .7.8 1.1 1.4.7l2.1-1.5c.3-.2.7-.2 1 0l1.9 1.4c.4.3.9.3 1.2 0l1.9-1.4c.3-.2.7-.2 1 0l2.1 1.5c.6.4 1.4 0 1.4-.7V10a8 8 0 00-8-8zm-3 9.2a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm6 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z"/></svg>'
const ICON_LOCATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3" stroke-linecap="round"/></svg>'
const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>'
const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'

export function render (root, ctx) {
  root.classList.add('v-disc')

  const my = db.profile() || { id: '', name: '', lang: 'en' }
  let rangeM = db.settings().rangeM
  let ageFilter = 'all'
  let overlay = null
  const timers = new Set()

  const myLang = () => langName(my.lang) || my.lang
  const theirLang = (p) => langName(p.lang) || p.lang || '?'

  /* ------------------------------------------------------------ header */

  const toggleLabel = el('span', { text: 'Visible' })
  const toggle = el('button', {
    class: 'ghost',
    type: 'button',
    'aria-pressed': 'true',
    'aria-label': 'Show me on the map',
    html: ICON_GHOST,
    onclick: onToggle
  }, [toggleLabel, el('span', { class: 'sw' })])

  const bar = el('div', { class: 'bar' }, [
    avatar(my, 34),
    el('h1', { text: 'Discovery' }),
    toggle
  ])

  /* --------------------------------------------------------------- map */

  const countLabel = el('span', { text: '0 nearby' })
  const ringEls = [el('i'), el('i'), el('i'), el('i')]
  const you = el('div', { class: 'you' })
  const mkLayer = el('div', { class: 'mklayer' })
  const locChip = el('button', {
    class: 'locchip',
    type: 'button',
    text: 'Location off — distances approximate',
    onclick: locate
  })

  /* Drawn plan layer: fallback + placeholder. The live .gmap div is inserted
   * right after it once (if) the Maps API arrives. */
  const drawnLayer = el('div', { class: 'drawn', html: PLAN_SVG }, [
    el('div', { class: 'rings' }, ringEls),
    mkLayer,
    you
  ])

  const mapEl = el('div', { class: 'map' }, [
    drawnLayer,
    el('div', { class: 'count' }, [el('i'), countLabel]),
    el('div', { class: 'mapb' }, [
      el('button', {
        class: 'mb', type: 'button', html: ICON_LOCATE,
        'aria-label': 'Update my position', title: 'Update my position',
        onclick: locate
      })
    ]),
    locChip,
    el('span', { class: 'hidechip', text: 'HIDDEN FROM MAP' }),
    el('div', { class: 'sweep' })
  ])

  /* ----------------------------------------------------------- filters */

  const RANGE_OPTS = [5, 10, 25, 50, 100, 200, 500]

  const distSel = el('select', { 'aria-label': 'Distance filter' },
    RANGE_OPTS.map((m) => el('option', { value: String(m), text: `${m} m` })))
  distSel.addEventListener('change', () => {
    // Same update path the old slider drove: rings + zoom + markers + list.
    rangeM = Number(distSel.value)
    drawRings()
    updatePeople()
    db.setSettings({ rangeM })
    syncRangeSel()
  })

  /** Keep the dropdown honest about rangeM: legacy values (the old slider
   *  allowed any 5 m step) get their own option, pruned once deselected. */
  function syncRangeSel () {
    const want = String(rangeM)
    for (const o of [...distSel.options]) {
      if (!RANGE_OPTS.includes(Number(o.value)) && o.value !== want) o.remove()
    }
    if (![...distSel.options].some((o) => o.value === want)) {
      const after = [...distSel.options].find((o) => Number(o.value) > rangeM)
      distSel.insertBefore(el('option', { value: want, text: `${rangeM} m` }), after || null)
    }
    distSel.value = want
  }

  const ageSel = el('select', { 'aria-label': 'Age filter' },
    ['all', '18-24', '25-34', '35+'].map((v) =>
      el('option', { value: v, text: v === 'all' ? 'All' : v.replace('-', '–') })))
  ageSel.addEventListener('change', () => { ageFilter = ageSel.value; updatePeople() })

  const genderSel = el('select', { 'aria-label': 'Sex filter' },
    [el('option', { value: 'all', text: 'All' })])

  const chev = () => el('span', { class: 'chev', html: ICON_CHEV })
  const chip = (label, sel) =>
    el('label', { class: 'chip' }, [el('b', { text: label }), sel, chev()])

  const filters = el('div', { class: 'chips' }, [
    chip('Distance', distSel),
    chip('Age', ageSel),
    chip('Sex', genderSel),
    el('button', {
      class: 'loc', type: 'button', html: ICON_LOCATE,
      'aria-label': 'Locate me', onclick: locate
    })
  ])
  syncRangeSel()

  /* -------------------------------------------------------------- list */

  const listCount = el('span', { class: 'n', text: '· 0' })
  const listEl = el('div')
  const emptyEl = el('p', { class: 'empty' })

  root.appendChild(bar)
  root.appendChild(mapEl)
  root.appendChild(filters)
  root.appendChild(el('div', { class: 'lhead' }, [el('h2', { text: 'Nearby Users' }), listCount]))
  root.appendChild(el('div', { class: 'scroll-y' }, [listEl, emptyEl]))

  /* ------------------------------------------------------------- radar */

  function centre () { return lobby.myPosition() || FALLBACK_CENTRE }
  function centreLL () { const c = centre(); return { lat: c.lat, lng: c.lon } }
  function ringScale () { return 0.45 + 0.55 * (rangeM / 500) }
  function outerRadiusPx () { return (RING_BASES[3] * ringScale()) / 2 }

  function drawRings () {
    ringEls.forEach((ring, k) => {
      const size = Math.round(RING_BASES[k] * ringScale())
      ring.style.width = `${size}px`
      ring.style.height = `${size}px`
    })
    if (gm) {
      gm.circles.forEach((c, i) => c.setRadius(Math.max(rangeM, 1) * RING_F[i]))
      gm.map.setZoom(zoomForRange(centre().lat))
    }
  }

  /* --------------------------------------------------- live google map */

  let gm = null            // active Google-map state, or null → drawn fallback
  let disposed = false

  /**
   * Zoom that makes the outer radar circle (radius rangeM metres) span
   * RING_FIT × the map's short edge. From metres-per-pixel at this latitude,
   * mpp(z) = EQUATOR_M_PER_PX · cos(lat) / 2^z — solve for z with log2
   * (≈15 at 500 m, clamped near max zoom at 5 m; no lookup table).
   */
  function zoomForRange (lat) {
    const w = (gm && gm.div.clientWidth) || 372
    const h = (gm && gm.div.clientHeight) || 268
    const targetPx = (Math.min(w, h) * RING_FIT) / 2
    const mpp = Math.max(rangeM, 1) / targetPx
    const z = Math.log2(EQUATOR_M_PER_PX * Math.cos(lat * Math.PI / 180) / mpp)
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
  }

  function initGoogleMap (maps) {
    if (disposed || gmapsAuthFailed || gm) return
    if (!DomMarker) DomMarker = makeDomMarker(maps)
    const ll = centreLL()

    if (!mapCache) {
      const div = el('div', { class: 'gmap' })
      drawnLayer.after(div)
      const map = new maps.Map(div, {
        center: ll,
        zoom: 16,
        disableDefaultUI: true,      // Google logo + attribution remain (ToS)
        gestureHandling: 'greedy',   // one-finger pan on mobile
        clickableIcons: false,
        keyboardShortcuts: false,
        styles: GMAP_STYLES          // classic styles — mapId would override them
      })
      mapCache = { maps, map, div, ready: false }
    } else {
      drawnLayer.after(mapCache.div)
    }

    const map = mapCache.map
    const youEl = el('div', {
      class: 'you',
      style: 'left:-999px;top:-999px;pointer-events:none'
    })
    const youMarker = new DomMarker(ll, youEl)
    youMarker.setMap(map)
    const accentCol = accent()
    const circles = RING_F.map((f) => new maps.Circle({
      map,
      center: ll,
      radius: Math.max(rangeM, 1) * f,
      strokeColor: accentCol,
      strokeOpacity: 0.35,
      strokeWeight: 1,
      fillColor: accentCol,
      fillOpacity: 0.05,
      clickable: false
    }))

    gm = {
      map,
      div: mapCache.div,
      you: youMarker,
      youEl,
      circles,
      peerMarkers: new Map(),      // peer id → DomMarker (diffed, never rebuilt)
      lastC: null,
      active: false
    }
    syncMapCentre(true)
    if (mapCache.ready) activateGoogle()
    else maps.event.addListenerOnce(map, 'tilesloaded', () => { mapCache.ready = true; activateGoogle() })
  }

  /** First tiles are in — fade the live map over the drawn plan. */
  function activateGoogle () {
    if (disposed || !gm || gm.active) return
    gm.active = true
    mapEl.classList.add('gmode')
    gm.div.classList.add('on')
    paintToggle()
    updatePeople()
  }

  /** Key/referrer rejected after load — silently return to the drawn map. */
  function dropGoogle () {
    if (!gm) return
    teardownGoogle()
    mapEl.classList.remove('gmode')
    drawRings()
    updatePeople()
  }

  function teardownGoogle () {
    if (!gm) return
    for (const mk of gm.peerMarkers.values()) mk.setMap(null)
    gm.you.setMap(null)
    for (const c of gm.circles) c.setMap(null)
    gm.div.classList.remove('on')
    gm.div.remove()              // detach the cached map div for the next visit
    gm = null
  }

  /** Recentre on my position whenever it changes (or forced). */
  function syncMapCentre (force) {
    if (!gm) return
    const c = centre()
    if (!force && gm.lastC && gm.lastC.lat === c.lat && gm.lastC.lon === c.lon) return
    gm.lastC = c
    const ll = { lat: c.lat, lng: c.lon }
    gm.map.setCenter(ll)
    gm.map.setZoom(zoomForRange(c.lat))
    for (const circle of gm.circles) circle.setCenter(ll)
    gm.you.move(ll)
  }

  /* ------------------------------------------------------------ people */

  function computePeople () {
    const at = centre()
    const people = lobby.peers().filter((p) => p.id !== my.id).map((p) => ({ ...p }))
    for (const p of people) p.dist = distanceM(at, p)
    const hadAny = people.length > 0
    const bucket = AGE_BUCKETS[ageFilter]
    let filtered = people
    if (bucket) {
      // Real peers don't announce an age — the filter only bites where one exists.
      filtered = filtered.filter((p) => p.age == null || (p.age >= bucket[0] && p.age <= bucket[1]))
    }
    // Range filters map and list together; people withholding position stay
    // in the list — they cannot be distance-filtered honestly.
    filtered = filtered.filter((p) => p.dist == null || p.dist <= rangeM)
    filtered.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))
    return { people: filtered, hadAny }
  }

  function updatePeople () {
    const { people, hadAny } = computePeople()
    countLabel.textContent = `${people.length} nearby`
    listCount.textContent = `· ${people.length}`
    drawMarkers(people)
    drawList(people, hadAny)
  }

  function drawMarkers (people) {
    if (gm) drawMarkersLive(people)
    if (!gm || !gm.active) drawMarkersDrawn(people)
  }

  /** Live map: diff by peer id — move existing, add new, remove gone. */
  function drawMarkersLive (people) {
    const seen = new Set()
    for (const p of people) {
      if (p.lat == null || p.lon == null) continue
      seen.add(p.id)
      const ll = { lat: p.lat, lng: p.lon }
      const away = fmtDistance(p.dist)
      const label = away ? `${p.name}, ${away} away` : p.name
      let mk = gm.peerMarkers.get(p.id)
      if (mk) {
        if (mk.person.name !== p.name || mk.person.avatar !== p.avatar) {
          clear(mk.element)
          mk.element.appendChild(avatar(p, 42))
        }
        mk.person = p
        mk.element.setAttribute('aria-label', label)
        mk.move(ll)
      } else {
        const btn = el('button', {
          class: 'mk',
          type: 'button',
          'aria-label': label,
          style: 'left:-999px;top:-999px'
        }, [avatar(p, 42)])
        mk = new DomMarker(ll, btn)
        mk.person = p
        btn.addEventListener('click', () => openProfile(mk.person))
        mk.setMap(gm.map)
        gm.peerMarkers.set(p.id, mk)
      }
    }
    for (const [id, mk] of gm.peerMarkers) {
      if (!seen.has(id)) {
        mk.setMap(null)
        gm.peerMarkers.delete(id)
      }
    }
  }

  /**
   * Drawn fallback: linear projection centred on me — rangeM maps to the
   * outer ring radius, markers past the maths clamp at the edge.
   */
  function drawMarkersDrawn (people) {
    clear(mkLayer)
    const at = centre()
    const outer = outerRadiusPx()
    const scale = outer / Math.max(rangeM, 1)
    const mPerDegLon = 111320 * Math.cos(at.lat * Math.PI / 180)
    for (const p of people) {
      if (p.lat == null || p.lon == null) continue
      let x = (p.lon - at.lon) * mPerDegLon * scale
      let y = -((p.lat - at.lat) * M_PER_DEG_LAT * scale)
      const r = Math.hypot(x, y)
      if (r > outer) { x = (x / r) * outer; y = (y / r) * outer }
      const away = fmtDistance(p.dist)
      mkLayer.appendChild(el('button', {
        class: 'mk',
        type: 'button',
        style: `left:calc(50% + ${x.toFixed(1)}px);top:calc(50% + ${y.toFixed(1)}px)`,
        'aria-label': away ? `${p.name}, ${away} away` : p.name,
        onclick: () => openProfile(p)
      }, [avatar(p, 42)]))
    }
  }

  function drawList (people, hadAny) {
    clear(listEl)
    if (!people.length) {
      emptyEl.textContent = hadAny
        ? 'Nobody within this radius. Widen the distance to see more.'
        : 'No one nearby yet. Keep this screen open — people appear the moment they come online.'
      emptyEl.classList.add('on')
      return
    }
    emptyEl.classList.remove('on')
    people.forEach((p, i) => {
      const dist = fmtDistance(p.dist)
      listEl.appendChild(el('div', {
        class: 'row',
        style: `animation-delay:${i * 32}ms`,
        onclick: () => openProfile(p)
      }, [
        avatar(p, 48, { dot: true }),
        el('div', { class: 'mid' }, [
          el('div', { class: 'nm' }, [el('span', { text: p.name })]),
          el('div', { class: 'st', text: `${theirLang(p)} → ${myLang()} · online now` })
        ]),
        dist ? el('span', { class: 'dpill', html: ICON_PIN }, [dist]) : null,
        el('button', {
          class: 'pill ok mini',
          type: 'button',
          text: 'Message',
          onclick: (e) => { e.stopPropagation(); startMessage(p) }
        })
      ]))
    })
  }

  /* -------------------------------------------------------- chat flows */

  function findConvo (peerId) {
    return db.convos().find((c) => c.peer && c.peer.id === peerId) || null
  }

  function startMessage (p) {
    closeOverlay()
    const existing = findConvo(p.id)
    if (existing) { ctx.openThread(existing.roomId); return }
    openRequestSheet(p)
  }

  function sendWave (p) {
    closeOverlay()
    const existing = findConvo(p.id)
    if (existing) { ctx.openThread(existing.roomId); return }
    try {
      const roomId = lobby.request(p, WAVE, 'nearby')
      ctx.toast('Request sent')
      ctx.openThread(roomId)
    } catch { ctx.toast('Could not send the request') }
  }

  function openRequestSheet (p) {
    closeOverlay()
    const input = el('input', { type: 'text', placeholder: 'Say hi — any language', maxlength: '300' })
    const send = () => {
      try {
        const roomId = lobby.request(p, input.value.trim(), 'nearby')
        closeOverlay()
        ctx.toast('Request sent')
        ctx.openThread(roomId)
      } catch { ctx.toast('Could not send the request') }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
    overlay = el('div', { class: 'ov bottom' }, [
      el('div', { class: 'sheet' }, [
        el('div', { class: 'shead' }, [
          avatar(p, 40, { dot: true }),
          el('div', { class: 'stitle' }, [
            el('b', { text: p.name }),
            el('span', { text: `${theirLang(p)} → ${myLang()} · messages translate both ways` })
          ])
        ]),
        input,
        el('button', { class: 'pill ok', type: 'button', text: 'Send request', onclick: send })
      ])
    ])
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay() })
    root.appendChild(overlay)
    input.focus()
  }

  /* ------------------------------------------------------ profile card */

  function openProfile (p) {
    closeOverlay()
    const dist = fmtDistance(p.dist)
    // Already connected (or already asked)? Never offer Wave / say-hi again —
    // the card states the relationship and opens the existing chat instead.
    const convo = findConvo(p.id)
    let actions
    if (!convo) {
      actions = [el('div', { class: 'pacts' }, [
        el('button', { class: 'wavebtn', type: 'button', text: `${WAVE} Wave`, onclick: () => sendWave(p) }),
        el('button', { class: 'pill ok', type: 'button', text: 'Message', onclick: () => startMessage(p) })
      ])]
    } else if (convo.pending) {
      actions = [el('div', {
        class: 'plang', style: 'margin-top:14px', text: 'Request sent — waiting'
      })]
    } else {
      actions = [
        el('div', { class: 'plang', style: 'margin-top:14px', text: 'Connected' }),
        el('div', { class: 'pacts' }, [
          el('button', {
            class: 'pill ok',
            type: 'button',
            text: 'Open chat',
            onclick: () => { closeOverlay(); ctx.openThread(convo.roomId) }
          })
        ])
      ]
    }
    overlay = el('div', { class: 'ov center' }, [
      el('div', { class: 'pcard' }, [
        avatar(p, 76, { dot: true }),
        el('div', { class: 'pname' }, [
          el('span', { text: p.age ? `${p.name} · ${p.age}` : p.name })
        ]),
        el('div', { class: 'plang', text: `${theirLang(p)} → ${myLang()}` }),
        dist ? el('span', { class: 'dpill', html: ICON_PIN }, [dist]) : null,
        p.tags && p.tags.length
          ? el('div', { class: 'tags' }, p.tags.map((t) => el('span', { class: 'tag', text: t })))
          : null,
        ...actions
      ])
    ])
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay() })
    root.appendChild(overlay)
  }

  function closeOverlay () {
    if (overlay) { overlay.remove(); overlay = null }
  }

  /* ---------------------------------------------------------- controls */

  function onToggle () {
    const next = !db.settings().showOnMap
    db.setSettings({ showOnMap: next })
    try { lobby.announce() } catch { /* lobby not up yet */ }
    if (!next) ctx.toast('You are hidden from the map. You can still send requests.')
    paintToggle()
  }

  function paintToggle () {
    const on = db.settings().showOnMap
    toggle.setAttribute('aria-pressed', String(on))
    toggleLabel.textContent = on ? 'Visible' : 'Hidden'
    mapEl.classList.toggle('hidden', !on)
    if (gm) {
      // Circles cannot dash their stroke — fade it to the hidden treatment
      // instead; the HIDDEN FROM MAP chip appears via .map.hidden CSS.
      for (const c of gm.circles) c.setOptions({ strokeOpacity: on ? 0.35 : 0.15 })
    }
  }

  function locate () {
    try { lobby.refreshPosition() } catch { /* geolocation unavailable */ }
    ctx.toast('Updating your position')
    const dots = gm ? [you, gm.youEl] : [you]
    for (const dot of dots) {
      dot.classList.remove('ping')
      void dot.offsetWidth
      dot.classList.add('ping')
    }
    const t = setTimeout(() => {
      you.classList.remove('ping')
      if (gm) gm.youEl.classList.remove('ping')
      timers.delete(t)
    }, 2000)
    timers.add(t)
  }

  /* -------------------------------------------------------------- sync */

  function sync () {
    const settings = db.settings()
    if (settings.rangeM !== rangeM) {
      rangeM = settings.rangeM
      syncRangeSel()
      drawRings()
    }
    paintToggle()
    locChip.classList.toggle('on', !lobby.myPosition())
    syncMapCentre()
    updatePeople()
  }

  const unsubDb = db.subscribe(sync)
  const unsubLobby = lobby.subscribe(sync)

  drawRings()
  sync()

  /* Try the live map; every failure path silently keeps the drawn plan. */
  onGmapsAuthFail = dropGoogle
  if (!gmapsAuthFailed) {
    loadGoogleMaps()
      .then((maps) => { try { initGoogleMap(maps) } catch { /* drawn map stays */ } })
      .catch(() => { /* offline or blocked — drawn map stays */ })
  }

  return function cleanup () {
    disposed = true
    if (onGmapsAuthFail === dropGoogle) onGmapsAuthFail = null
    teardownGoogle()
    unsubDb()
    unsubLobby()
    for (const t of timers) clearTimeout(t)
    closeOverlay()
    root.classList.remove('v-disc')
  }
}
