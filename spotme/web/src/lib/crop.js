/**
 * Spot Me — avatar crop modal (no dependencies).
 *
 * openCrop(dataURL) → Promise<string|null>
 * Fullscreen dark modal: square crop viewport with a circular mask preview,
 * image pans by drag (pointer events) and zooms by wheel or two-finger pinch,
 * always clamped so the viewport stays covered. "Choose" exports the viewport
 * region as a 256×256 JPEG data URL; Cancel, backdrop tap or Escape resolve
 * null. CSS lives in tokens.css under the .crop- namespace.
 */
import { el } from './ui.js'

const OUT_SIZE = 256
const OUT_QUALITY = 0.85
const MAX_ZOOM = 8
const VIEW_MAX_PX = 320
const VIEW_VW = 0.8
const WHEEL_SENSITIVITY = 0.0015

export function openCrop (dataURL) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onerror = () => resolve(null)
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) { resolve(null); return }
      mountModal(img, resolve)
    }
    img.src = dataURL
  })
}

function mountModal (img, resolve) {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  const view = Math.round(Math.min(window.innerWidth * VIEW_VW, VIEW_MAX_PX))
  const minScale = view / Math.min(iw, ih)     // cover: image never smaller than viewport

  let scale = minScale
  let x = (view - iw * scale) / 2              // image top-left in viewport coords
  let y = (view - ih * scale) / 2
  let settled = false

  const pic = el('img', { class: 'crop-img', src: img.src, alt: '', draggable: 'false' })
  const viewport = el('div', {
    class: 'crop-view',
    style: `width:${view}px;height:${view}px`
  }, [pic, el('div', { class: 'crop-mask', 'aria-hidden': 'true' })])

  const backdrop = el('div', { class: 'crop-backdrop', role: 'dialog', 'aria-label': 'Crop photo' }, [
    el('div', { class: 'crop-card' }, [
      viewport,
      el('div', { class: 'crop-hint', text: 'Drag to move · pinch or scroll to zoom' }),
      el('div', { class: 'crop-bar' }, [
        el('button', { class: 'crop-btn', type: 'button', text: 'Cancel', onclick: () => finish(null) }),
        el('button', { class: 'crop-btn crop-choose', type: 'button', text: 'Choose', onclick: () => finish(exportView()) })
      ])
    ])
  ])

  /* --------------------------------------------------------- geometry */

  function clampPan () {
    x = Math.min(0, Math.max(view - iw * scale, x))
    y = Math.min(0, Math.max(view - ih * scale, y))
  }

  function apply () {
    pic.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  /** Zoom keeping the viewport point (px, py) fixed on the same image spot. */
  function zoomAt (px, py, factor) {
    const next = Math.min(minScale * MAX_ZOOM, Math.max(minScale, scale * factor))
    const ratio = next / scale
    x = px - (px - x) * ratio
    y = py - (py - y) * ratio
    scale = next
    clampPan()
    apply()
  }

  /* --------------------------------------------- pan (drag) + pinch zoom */

  const pointers = new Map()
  let pinchDist = 0

  viewport.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    try { viewport.setPointerCapture(event.pointerId) } catch { /* unsupported */ }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    }
  })

  viewport.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    const prev = pointers.get(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) {
      x += event.clientX - prev.x
      y += event.clientY - prev.y
      clampPan()
      apply()
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist > 0 && dist > 0) {
        const rect = viewport.getBoundingClientRect()
        zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, dist / pinchDist)
      }
      pinchDist = dist
    }
  })

  const liftPointer = (event) => {
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinchDist = 0
  }
  viewport.addEventListener('pointerup', liftPointer)
  viewport.addEventListener('pointercancel', liftPointer)

  viewport.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = viewport.getBoundingClientRect()
    zoomAt(event.clientX - rect.left, event.clientY - rect.top,
      Math.exp(-event.deltaY * WHEEL_SENSITIVITY))
  }, { passive: false })

  /* ------------------------------------------------------ export & close */

  function exportView () {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = OUT_SIZE
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'                    // JPEG has no alpha — flatten on white
      ctx.fillRect(0, 0, OUT_SIZE, OUT_SIZE)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, -x / scale, -y / scale, view / scale, view / scale,
        0, 0, OUT_SIZE, OUT_SIZE)
      return canvas.toDataURL('image/jpeg', OUT_QUALITY)
    } catch {
      return null                               // caller treats null as "no change"
    }
  }

  function finish (value) {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    resolve(value)
  }

  const onKey = (event) => { if (event.key === 'Escape') finish(null) }
  document.addEventListener('keydown', onKey)
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) finish(null) })

  apply()
  document.body.appendChild(backdrop)
}
