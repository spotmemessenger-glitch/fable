/**
 * Spot Me — WhatsApp-grammar photo editor (no dependencies).
 *
 * openPhotoEditor(dataURL | dataURL[]) →
 *   Promise<{photos:[{dataURL, caption}], dataURL, caption, privatePhoto}|null>
 * (dataURL/caption mirror photos[0] for single-photo compat callers.)
 *
 * Fullscreen dark editor: the photo sits fit-contained on ONE canvas that is
 * recomposited after every change — base image (crop + rotation baked in),
 * then freehand strokes, then text/emoji layers. Tools per the reference:
 * CROP/ROTATE, STICKER (emoji), Aa (text: 3 font styles + colours), PENCIL.
 * Layers drag with a pointer, scale with wheel or two-finger pinch, and a
 * trash affordance deletes the selected one. With several photos a thumbnail
 * strip above the caption bar switches between them; every edit (crop,
 * rotation, strokes, layers, caption) is kept PER PHOTO, while the ① private
 * and HD toggles are global for the batch. Send flattens each photo to a
 * bounded JPEG (std 1280 q .82, HD 2048 q .9 — presets live in media.js).
 * X asks a confirm sheet once anything was edited — never a silent discard.
 *
 * All gestures are pointer-events based; the editor is a fixed overlay so
 * page scroll outside it is never touched. CSS lives in chat.css under .pe-.
 */
import { el } from './ui.js'
import { PHOTO_STD, PHOTO_HD } from './media.js'
const TAP_SLOP_PX = 6
const TEXT_SIZE_FRAC = 0.085       // new text size as a fraction of base width
const EMOJI_SIZE_FRAC = 0.22
const MIN_LAYER_SCALE = 0.25
const MAX_LAYER_SCALE = 8
const WHEEL_SENSITIVITY = 0.0015
const PEN_WIDTHS_PX = [3, 6, 11]   // screen px — converted to image px at stroke start
const MIN_CROP_PX = 24             // image px

/* Original first, because it is the default and the one that needs no thought.
 * Then the three shapes a feed actually uses: square, the 4:5 portrait that is
 * the tallest a column can carry without one post owning the screen, and 16:9
 * for anything shot landscape. `null` means freeform. */
const CROP_RATIOS = [
  { label: 'Original', value: null },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '16:9', value: 16 / 9 }
]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const teal = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() || '#1b8a9d'

/** White, ink, teal var(--blue), red, yellow — the locked editor palette. */
const palette = () => ['#ffffff', '#0f0f10', teal(), '#e5342b', '#ffd60a']

const FONTS = [
  { id: 'sans', label: 'Bold', css: (px) => `800 ${px}px Sora, 'Plus Jakarta Sans', -apple-system, sans-serif` },
  { id: 'serif', label: 'Serif', css: (px) => `700 ${px}px Georgia, 'Times New Roman', serif` },
  { id: 'mono', label: 'Mono', css: (px) => `700 ${px}px 'Courier New', monospace` }
]

const STICKERS = [
  '😀', '😁', '😂', '🥹', '😊', '😍', '😘', '😜',
  '🤪', '🤔', '😴', '🥱', '😷', '🤒', '🥳', '😎',
  '😭', '😱', '😡', '🤯', '🙃', '🤗', '👍', '👏',
  '🙏', '💪', '🤝', '❤️', '🔥', '✨', '🎉', '💯'
]

const IC = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 002 2h14"/><path d="M2 6h14a2 2 0 012 2v14"/></svg>',
  sticker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 007 0"/><path d="M9 9.5h.01M15 9.5h.01"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-9-9"/><path d="M21 3v5h-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 5v2"/><path d="M18.5 7l-1 12.6a2 2 0 01-2 1.9h-7a2 2 0 01-2-1.9L5.5 7"/><path d="M10 11.5v5M14 11.5v5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>'
}

/* Only one editor at a time; the chat view closes it on unmount. */
let activeCancel = null

export function closePhotoEditor () { activeCancel?.() }

export function openPhotoEditor (dataURLs) {
  return new Promise((resolve) => {
    closePhotoEditor()
    const urls = (Array.isArray(dataURLs) ? dataURLs : [dataURLs]).filter(Boolean)
    if (!urls.length) { resolve(null); return }
    // Load every photo up front; unreadable ones are dropped, an empty batch
    // resolves null (matching the old single-photo failure behaviour).
    Promise.all(urls.map((url) => new Promise((done) => {
      const img = new Image()
      img.onerror = () => done(null)
      img.onload = () => done(img.naturalWidth && img.naturalHeight ? img : null)
      img.src = url
    }))).then((loaded) => {
      const imgs = loaded.filter(Boolean)
      if (!imgs.length) { resolve(null); return }
      mountEditor(imgs, resolve)
    })
  })
}

function mountEditor (imgs, resolve) {
  /* ---------------------------------------------------------------- state */
  // One state per photo; `base` holds the committed image (crop + rotation
  // already baked in). The pointers below always alias states[cur].
  const states = imgs.map((img) => {
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    c.getContext('2d').drawImage(img, 0, 0)
    return {
      base: c,
      baseEdited: false,
      strokes: [],   // { color, width(image px), pts:[{x,y}] }
      layers: [],    // { type:'text'|'emoji', text, font?, color?, x, y, scale, size }
      caption: ''
    }
  })
  let cur = 0
  let base = states[0].base
  let strokes = states[0].strokes
  let layers = states[0].layers

  let selected = null
  let tool = null             // 'pencil' | null (crop/sticker/text track their own overlay)
  let privatePhoto = false    // global for the batch
  let hd = false              // global for the batch
  let settled = false
  let penColor = '#ffffff'
  let penWidth = PEN_WIDTHS_PX[1]
  let cropMode = false
  let pendingRot = 0          // 0/90/180/270, preview-only until Apply
  let cropRect = null         // in rotated-image coords
  /* Locked crop shape, or null for freeform. Presets exist because a feed is a
   * COLUMN: a post that is 1:1 or 4:5 sits in the same rhythm as the ones above
   * and below it, and eyeballing that by dragging corners is something nobody
   * gets right twice. `null` stays the default — the photo someone took is the
   * photo they meant, until they say otherwise. */
  let cropRatio = null
  let stickerOpen = false
  let textTarget = null       // layer being re-edited, or null for a new one
  let tFont = 'sans'
  let tColor = '#ffffff'
  const view = { scale: 1, ox: 0, oy: 0 }
  let dpr = 1

  const dirty = () =>
    privatePhoto || Boolean(capInput.value.trim()) ||
    states.some((s) => s.baseEdited || s.strokes.length > 0 ||
      s.layers.length > 0 || Boolean(s.caption.trim()))

  /* ------------------------------------------------------------ geometry */
  function effSize () {
    if (cropMode && pendingRot % 180) return { w: base.height, h: base.width }
    return { w: base.width, h: base.height }
  }

  function computeFit () {
    const { w, h } = effSize()
    const cw = stage.clientWidth || 1
    const ch = stage.clientHeight || 1
    view.scale = Math.min(cw / w, ch / h)
    view.ox = (cw - w * view.scale) / 2
    view.oy = (ch - h * view.scale) / 2
  }

  function toImage (e) {
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - view.ox) / view.scale,
      y: (e.clientY - rect.top - view.oy) / view.scale
    }
  }

  /* ----------------------------------------------------------- painting */
  const meas = document.createElement('canvas').getContext('2d')

  const fontSpec = (l, px) => l.type === 'emoji'
    ? `${px}px sans-serif`
    : (FONTS.find((f) => f.id === l.font) || FONTS[0]).css(px)

  function layerBox (l) {
    const px = l.size * l.scale
    meas.font = fontSpec(l, px)
    const w = Math.max(px * 0.6, meas.measureText(l.text).width)
    const h = px * 1.25
    return { x: l.x - w / 2, y: l.y - h / 2, w, h }
  }

  function drawStrokes (c, list = strokes) {
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (const s of list) {
      const pts = s.pts
      if (!pts.length) continue
      c.strokeStyle = s.color
      c.lineWidth = s.width
      c.beginPath()
      c.moveTo(pts[0].x, pts[0].y)
      if (pts.length < 3) {
        c.lineTo(pts[pts.length - 1].x + 0.01, pts[pts.length - 1].y + 0.01)
      } else {
        // Quadratic smoothing through segment midpoints.
        for (let i = 1; i < pts.length - 1; i++) {
          c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2)
        }
        c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
      }
      c.stroke()
    }
  }

  function drawLayers (c, list = layers) {
    for (const l of list) {
      const px = l.size * l.scale
      c.save()
      c.translate(l.x, l.y)
      c.font = fontSpec(l, px)
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      if (l.type === 'text') {
        // A soft shadow keeps text readable over any photo.
        c.shadowColor = 'rgba(0,0,0,.45)'
        c.shadowBlur = px * 0.12
        c.fillStyle = l.color
      }
      c.fillText(l.text, 0, 0)
      c.restore()
    }
  }

  function drawSelection (c) {
    if (!selected) return
    const b = layerBox(selected)
    const pad = 6 / view.scale
    c.save()
    c.strokeStyle = 'rgba(255,255,255,.85)'
    c.lineWidth = 1.5 / view.scale
    c.setLineDash([6 / view.scale, 5 / view.scale])
    c.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
    c.restore()
  }

  function drawRotatedBase (c) {
    c.save()
    if (pendingRot === 90) { c.translate(base.height, 0); c.rotate(Math.PI / 2) } else if (pendingRot === 180) { c.translate(base.width, base.height); c.rotate(Math.PI) } else if (pendingRot === 270) { c.translate(0, base.width); c.rotate(-Math.PI / 2) }
    c.drawImage(base, 0, 0)
    c.restore()
  }

  function repaint () {
    const c = canvas.getContext('2d')
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, canvas.width, canvas.height)
    computeFit()
    c.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy)
    if (cropMode) { drawRotatedBase(c); return }   // strokes/layers return remapped after Apply
    c.drawImage(base, 0, 0)
    drawStrokes(c)
    drawLayers(c)
    drawSelection(c)
  }

  function resizeCanvas () {
    dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(stage.clientWidth * dpr))
    canvas.height = Math.max(1, Math.round(stage.clientHeight * dpr))
    repaint()
    if (cropMode) syncCropUI()
  }

  /* ---------------------------------------------------------------- DOM */
  const canvas = el('canvas', { class: 'pe-canvas', 'aria-label': 'Photo' })

  const toolBtn = (icon, label) => el('button', {
    class: 'pe-tb', type: 'button', 'aria-label': label,
    ...(icon.startsWith('<svg') ? { html: icon } : { text: icon })
  })
  const cropBtn = toolBtn(IC.crop, 'Crop and rotate')
  const stickerBtn = toolBtn(IC.sticker, 'Add sticker')
  const textBtn = toolBtn('Aa', 'Add text')
  const pencilBtn = toolBtn(IC.pencil, 'Draw')

  function setRing (name) {
    const rings = { crop: cropBtn, sticker: stickerBtn, text: textBtn, pencil: pencilBtn }
    for (const [k, b] of Object.entries(rings)) b.classList.toggle('on', k === name)
  }

  /* HD toggle (WhatsApp badge grammar): outlined when off, filled
   * white-on-ink with a tick when on. One choice for the whole batch. */
  const hdBtn = el('button', {
    class: 'pe-hd', type: 'button', text: 'HD',
    'aria-label': 'Send in HD quality', 'aria-pressed': 'false'
  })
  hdBtn.addEventListener('click', () => {
    hd = !hd
    hdBtn.classList.toggle('on', hd)
    hdBtn.textContent = hd ? '✓HD' : 'HD'
    hdBtn.setAttribute('aria-pressed', String(hd))
  })

  const xBtn = el('button', { class: 'pe-x', type: 'button', 'aria-label': 'Discard photo', html: IC.x })
  const top = el('div', { class: 'pe-top' }, [
    xBtn,
    el('div', { class: 'pe-tools' }, [hdBtn, cropBtn, stickerBtn, textBtn, pencilBtn])
  ])

  /* crop overlay */
  const cropHandles = ['tl', 'tr', 'bl', 'br'].map((c) =>
    el('span', { class: `pe-ch pe-ch-${c}`, 'data-c': c }))
  const cropBox = el('div', { class: 'pe-cropbox', style: 'display:none' }, cropHandles)

  /* trash affordance for the selected layer */
  const trashBtn = el('button', {
    class: 'pe-trash', type: 'button', 'aria-label': 'Delete layer',
    html: IC.trash, style: 'display:none'
  })
  trashBtn.addEventListener('click', () => {
    const i = layers.indexOf(selected)
    if (i >= 0) layers.splice(i, 1)
    selected = null
    updateTrash()
    repaint()
  })
  function updateTrash () { trashBtn.style.display = selected ? '' : 'none' }

  /* text overlay */
  const tInput = el('input', { class: 'pe-tinput', type: 'text', placeholder: 'Type…', autocomplete: 'off' })
  const fontChips = FONTS.map((f) => el('button', {
    class: 'pe-chip', type: 'button', text: f.label,
    onclick () { tFont = f.id; applyTStyle() }
  }))
  const tDots = palette().map((c) => el('button', {
    class: 'pe-dot', type: 'button', 'aria-label': 'Text colour', style: `background:${c}`,
    onclick () { tColor = c; applyTStyle() }
  }))
  const tDone = el('button', { class: 'pe-tdone', type: 'button', text: 'Done', onclick: commitText })
  const textUI = el('div', { class: 'pe-textui', style: 'display:none' }, [
    tDone,
    tInput,
    el('div', { class: 'pe-fontrow' }, fontChips),
    el('div', { class: 'pe-colorrow' }, tDots)
  ])
  textUI.addEventListener('click', (e) => { if (e.target === textUI) commitText() })
  tInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitText() })

  function applyTStyle () {
    const f = FONTS.find((x) => x.id === tFont) || FONTS[0]
    tInput.style.font = f.css(30)
    tInput.style.color = tColor
    fontChips.forEach((c, i) => c.classList.toggle('on', FONTS[i].id === tFont))
    const pal = palette()
    tDots.forEach((d, i) => d.classList.toggle('on', pal[i] === tColor))
  }

  function openTextUI (layer) {
    closePanels()
    textTarget = layer || null
    tFont = layer?.font || 'sans'
    tColor = layer?.color || '#ffffff'
    tInput.value = layer?.text || ''
    applyTStyle()
    textUI.style.display = 'flex'
    setRing('text')
    setTimeout(() => tInput.focus(), 30)
  }

  function commitText () {
    const text = tInput.value.trim()
    textUI.style.display = 'none'
    setRing(tool === 'pencil' ? 'pencil' : null)
    if (!text) {
      // Clearing the text of an existing layer deletes it.
      const i = layers.indexOf(textTarget)
      if (i >= 0) { layers.splice(i, 1); selected = null; updateTrash() }
      textTarget = null
      repaint()
      return
    }
    if (textTarget) {
      textTarget.text = text
      textTarget.font = tFont
      textTarget.color = tColor
      selected = textTarget
    } else {
      const layer = {
        type: 'text',
        text,
        font: tFont,
        color: tColor,
        x: base.width / 2,
        y: base.height / 2,
        scale: 1,
        size: Math.max(18, base.width * TEXT_SIZE_FRAC)
      }
      layers.push(layer)
      selected = layer
    }
    textTarget = null
    updateTrash()
    repaint()
  }

  /* sticker overlay */
  const stickerUI = el('div', { class: 'pe-stickers', style: 'display:none' }, [
    el('div', { class: 'pe-stgrid' }, STICKERS.map((s) => el('button', {
      type: 'button', text: s, 'aria-label': `Sticker ${s}`,
      onclick () {
        const layer = {
          type: 'emoji',
          text: s,
          x: base.width / 2,
          y: base.height / 2,
          scale: 1,
          size: Math.max(28, base.width * EMOJI_SIZE_FRAC)
        }
        layers.push(layer)
        selected = layer
        toggleStickers(false)
        updateTrash()
        repaint()
      }
    })))
  ])

  function toggleStickers (on) {
    stickerOpen = on ?? !stickerOpen
    stickerUI.style.display = stickerOpen ? '' : 'none'
    setRing(stickerOpen ? 'sticker' : (tool === 'pencil' ? 'pencil' : null))
  }

  const stage = el('div', { class: 'pe-stage' }, [canvas, cropBox, trashBtn, stickerUI, textUI])

  /* pencil sub-bar */
  const penDots = palette().map((c, i) => el('button', {
    class: 'pe-dot' + (i === 0 ? ' on' : ''), type: 'button', 'aria-label': 'Pen colour',
    style: `background:${c}`,
    onclick () { penColor = c; penDots.forEach((d, j) => d.classList.toggle('on', j === i)) }
  }))
  const widthDots = PEN_WIDTHS_PX.map((w, i) => el('button', {
    class: 'pe-w' + (i === 1 ? ' on' : ''), type: 'button', 'aria-label': `Pen width ${w}px`,
    onclick () { penWidth = w; widthDots.forEach((d, j) => d.classList.toggle('on', j === i)) }
  }, [el('span', { style: `width:${w + 3}px;height:${w + 3}px` })]))
  const penbar = el('div', { class: 'pe-penbar', style: 'display:none' }, [
    ...penDots,
    el('span', { class: 'pe-gap' }),
    ...widthDots,
    el('button', { class: 'pe-undo', type: 'button', text: 'Undo', onclick () { strokes.pop(); repaint() } })
  ])

  /* crop sub-bar */
  const cropbar = el('div', { class: 'pe-cropbar', style: 'display:none' }, [
    el('button', {
      class: 'pe-rot', type: 'button', 'aria-label': 'Rotate 90°', html: IC.rotate,
      onclick () {
        pendingRot = (pendingRot + 90) % 360
        repaint()
        // Re-fit rather than reset: a chosen shape survives a rotation, which
        // is the whole reason someone rotates while cropping.
        setCropRatio(cropRatio)
      }
    }),
    /* Their own row. Four chips plus rotate, Cancel and Apply do not fit on
     * one 390px line — cramming them pushed Apply off the screen entirely,
     * which a drive at that width caught. */
    el('div', { class: 'pe-ratios' }, CROP_RATIOS.map((r) => el('button', {
      class: 'pe-ratio', type: 'button', text: r.label, 'data-ratio': r.label,
      onclick () { setCropRatio(r.value) }
    }))),
    el('span', { class: 'pe-gap' }),
    el('button', { class: 'pe-cropcancel', type: 'button', text: 'Cancel', onclick: () => exitCrop() }),
    el('button', { class: 'pe-cropapply', type: 'button', text: 'Apply', onclick: applyCrop })
  ])

  const sub = el('div', { class: 'pe-sub' }, [penbar, cropbar])

  /* bottom bar */
  const capInput = el('input', { class: 'pe-cap', type: 'text', placeholder: 'Add a caption…', autocomplete: 'off' })
  capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend() })
  const onceBtn = el('button', {
    class: 'pe-once', type: 'button', text: '1',
    'aria-label': 'Send as private photo', 'aria-pressed': 'false'
  })
  onceBtn.addEventListener('click', () => {
    privatePhoto = !privatePhoto
    onceBtn.classList.toggle('on', privatePhoto)
    onceBtn.setAttribute('aria-pressed', String(privatePhoto))
  })
  const sendBtn = el('button', { class: 'pe-send', type: 'button', 'aria-label': 'Send photo', html: IC.send, onclick: doSend })
  const bottom = el('div', { class: 'pe-bottom' }, [capInput, onceBtn, sendBtn])

  /* Multi-photo thumbnail strip above the caption bar — tap to switch.
   * Only mounted for a batch; single photos keep the exact old layout. */
  const thumbs = states.map((s, i) => el('button', {
    class: 'pe-thumb' + (i === 0 ? ' on' : ''), type: 'button',
    'aria-label': `Photo ${i + 1} of ${states.length}`,
    onclick: () => selectPhoto(i)
  }, [el('img', { src: imgs[i].src, alt: '' })]))
  const strip = states.length > 1 ? el('div', { class: 'pe-strip' }, thumbs) : null

  function selectPhoto (i) {
    if (settled || i === cur || !states[i]) return
    if (cropMode) exitCrop()
    closePanels()
    states[cur].caption = capInput.value
    cur = i
    base = states[i].base
    strokes = states[i].strokes
    layers = states[i].layers
    capInput.value = states[i].caption
    selected = null
    updateTrash()
    thumbs.forEach((t, j) => t.classList.toggle('on', j === i))
    repaint()
  }

  const back = el('div', { class: 'pe-back', role: 'dialog', 'aria-label': 'Edit photo' }, [top, stage, sub, strip, bottom])

  /* ------------------------------------------------------------ tools */
  function closePanels () {
    if (stickerOpen) toggleStickers(false)
    textUI.style.display = 'none'
    textTarget = null
    if (tool === 'pencil') { tool = null; penbar.style.display = 'none' }
    setRing(null)
  }

  cropBtn.addEventListener('click', () => { cropMode ? exitCrop() : enterCrop() })
  stickerBtn.addEventListener('click', () => {
    if (cropMode) exitCrop()
    const open = !stickerOpen
    closePanels()
    toggleStickers(open)
  })
  textBtn.addEventListener('click', () => {
    if (cropMode) exitCrop()
    openTextUI(null)
  })
  pencilBtn.addEventListener('click', () => {
    if (cropMode) exitCrop()
    const on = tool !== 'pencil'
    closePanels()
    tool = on ? 'pencil' : null
    penbar.style.display = on ? 'flex' : 'none'
    setRing(on ? 'pencil' : null)
    selected = null
    updateTrash()
    repaint()
  })

  /* ------------------------------------------------------------- crop */
  function enterCrop () {
    closePanels()
    cropMode = true
    pendingRot = 0
    selected = null
    updateTrash()
    const { w, h } = effSize()
    cropRect = { x: 0, y: 0, w, h }
    cropBox.style.display = ''
    cropbar.style.display = 'flex'
    setRing('crop')
    repaint()
    // Opens on Original every time — the shape is a choice, never a leftover
    // from the last photo someone cropped.
    setCropRatio(null)
  }

  /**
   * The biggest rect of `ratio` that fits, centred. Centred rather than
   * top-left because the subject of a photo is almost never in the corner, and
   * a preset that lops off someone's head is a preset nobody presses twice.
   * `null` restores the full frame.
   */
  function fitRatio (ratio) {
    const { w: EW, h: EH } = effSize()
    if (!ratio) return { x: 0, y: 0, w: EW, h: EH }
    let w = EW
    let h = w / ratio
    if (h > EH) { h = EH; w = h * ratio }
    return { x: (EW - w) / 2, y: (EH - h) / 2, w, h }
  }

  function setCropRatio (ratio) {
    cropRatio = ratio
    cropRect = fitRatio(ratio)
    for (const b of cropbar.querySelectorAll('.pe-ratio')) {
      const mine = CROP_RATIOS.find((r) => r.label === b.dataset.ratio)
      b.classList.toggle('on', mine ? mine.value === ratio : false)
    }
    syncCropUI()
  }

  function exitCrop () {
    cropMode = false
    pendingRot = 0
    cropBox.style.display = 'none'
    cropbar.style.display = 'none'
    setRing(null)
    repaint()
  }

  function syncCropUI () {
    if (!cropRect) return
    cropBox.style.left = `${view.ox + cropRect.x * view.scale}px`
    cropBox.style.top = `${view.oy + cropRect.y * view.scale}px`
    cropBox.style.width = `${cropRect.w * view.scale}px`
    cropBox.style.height = `${cropRect.h * view.scale}px`
  }

  let cropDrag = null
  cropBox.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try { cropBox.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    cropDrag = { id: e.pointerId, corner: e.target.dataset?.c || null, x: e.clientX, y: e.clientY, rect: { ...cropRect } }
  })
  cropBox.addEventListener('pointermove', (e) => {
    if (!cropDrag || e.pointerId !== cropDrag.id) return
    const dx = (e.clientX - cropDrag.x) / view.scale
    const dy = (e.clientY - cropDrag.y) / view.scale
    const r0 = cropDrag.rect
    const { w: EW, h: EH } = effSize()
    const min = Math.min(MIN_CROP_PX, EW, EH)
    if (!cropDrag.corner) {
      cropRect = {
        x: clamp(r0.x + dx, 0, EW - r0.w),
        y: clamp(r0.y + dy, 0, EH - r0.h),
        w: r0.w,
        h: r0.h
      }
    } else {
      let x1 = r0.x
      let y1 = r0.y
      let x2 = r0.x + r0.w
      let y2 = r0.y + r0.h
      if (cropDrag.corner.includes('l')) x1 = clamp(r0.x + dx, 0, x2 - min)
      if (cropDrag.corner.includes('r')) x2 = clamp(r0.x + r0.w + dx, x1 + min, EW)
      if (cropDrag.corner.includes('t')) y1 = clamp(r0.y + dy, 0, y2 - min)
      if (cropDrag.corner.includes('b')) y2 = clamp(r0.y + r0.h + dy, y1 + min, EH)
      if (cropRatio) {
        /* A locked shape has to STAY that shape while a corner is dragged.
         * Width leads and height follows, anchored to the corner opposite the
         * one under the finger — so the box grows away from where you are
         * pulling rather than sliding out from under it. If the derived height
         * would leave the image, height leads instead and width follows. */
        let w = x2 - x1
        let h = w / cropRatio
        const top = cropDrag.corner.includes('t')
        const left = cropDrag.corner.includes('l')
        if (h > EH) { h = EH; w = h * cropRatio }
        if (left) x1 = x2 - w; else x2 = x1 + w
        if (top) y1 = y2 - h; else y2 = y1 + h
        // Pushed past an edge: pull the whole box back in rather than distort.
        if (x1 < 0) { x2 -= x1; x1 = 0 }
        if (y1 < 0) { y2 -= y1; y1 = 0 }
        if (x2 > EW) { x1 -= x2 - EW; x2 = EW }
        if (y2 > EH) { y1 -= y2 - EH; y2 = EH }
      }
      cropRect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    }
    syncCropUI()
  })
  const cropLift = () => { cropDrag = null }
  cropBox.addEventListener('pointerup', cropLift)
  cropBox.addEventListener('pointercancel', cropLift)

  /** Map a point through the pending 90°-step rotation (W,H = pre-rotation). */
  function mapXY (p, rot, W, H) {
    if (rot === 90) return { x: H - p.y, y: p.x }
    if (rot === 180) return { x: W - p.x, y: H - p.y }
    if (rot === 270) return { x: p.y, y: W - p.x }
    return { x: p.x, y: p.y }
  }

  function applyCrop () {
    const W = base.width
    const H = base.height
    const rot = pendingRot
    let src = base
    if (rot) {
      src = document.createElement('canvas')
      src.width = rot % 180 ? H : W
      src.height = rot % 180 ? W : H
      const c = src.getContext('2d')
      if (rot === 90) { c.translate(src.width, 0); c.rotate(Math.PI / 2) } else if (rot === 180) { c.translate(src.width, src.height); c.rotate(Math.PI) } else { c.translate(0, src.height); c.rotate(-Math.PI / 2) }
      c.drawImage(base, 0, 0)
    }
    const r = {
      x: Math.round(clamp(cropRect.x, 0, src.width - 1)),
      y: Math.round(clamp(cropRect.y, 0, src.height - 1))
    }
    r.w = Math.max(1, Math.round(Math.min(cropRect.w, src.width - r.x)))
    r.h = Math.max(1, Math.round(Math.min(cropRect.h, src.height - r.y)))
    const out = document.createElement('canvas')
    out.width = r.w
    out.height = r.h
    out.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    // Strokes and layers ride along: rotate, then shift into crop space.
    for (const s of strokes) {
      s.pts = s.pts.map((p) => {
        const q = mapXY(p, rot, W, H)
        return { x: q.x - r.x, y: q.y - r.y }
      })
    }
    for (const l of layers) {
      const q = mapXY(l, rot, W, H)
      l.x = q.x - r.x
      l.y = q.y - r.y
    }
    base = out
    states[cur].base = out
    states[cur].baseEdited = true
    exitCrop()
  }

  /* ------------------------------------------- canvas gestures (layers/pen) */
  function hitLayer (p) {
    const pad = 8 / view.scale
    for (let i = layers.length - 1; i >= 0; i--) {
      const b = layerBox(layers[i])
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
        return layers[i]
      }
    }
    return null
  }

  const pointers = new Map()
  let gesture = null   // {kind:'draw'|'drag'|'pinch', ...}

  canvas.addEventListener('pointerdown', (e) => {
    if (cropMode) return                       // the crop box owns its own gestures
    e.preventDefault()
    try { canvas.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2 && selected && gesture?.kind === 'drag') {
      // Second finger while holding a layer → pinch scale.
      const [a, b] = [...pointers.values()]
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), start: selected.scale }
      return
    }
    if (pointers.size > 1) return
    const p = toImage(e)
    if (tool === 'pencil') {
      const stroke = { color: penColor, width: penWidth / view.scale, pts: [p] }
      strokes.push(stroke)
      gesture = { kind: 'draw', stroke }
      repaint()
      return
    }
    const hit = hitLayer(p)
    selected = hit
    updateTrash()
    gesture = hit ? { kind: 'drag', layer: hit, sx: e.clientX, sy: e.clientY, moved: false } : null
    repaint()
  })

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return
    const prev = pointers.get(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (gesture?.kind === 'pinch' && pointers.size === 2 && selected) {
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (gesture.dist > 0 && dist > 0) {
        selected.scale = clamp(gesture.start * (dist / gesture.dist), MIN_LAYER_SCALE, MAX_LAYER_SCALE)
        repaint()
      }
      return
    }
    if (gesture?.kind === 'draw') {
      gesture.stroke.pts.push(toImage(e))
      repaint()
      return
    }
    if (gesture?.kind === 'drag') {
      gesture.layer.x += (e.clientX - prev.x) / view.scale
      gesture.layer.y += (e.clientY - prev.y) / view.scale
      if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > TAP_SLOP_PX) gesture.moved = true
      repaint()
    }
  })

  const lift = (e) => {
    pointers.delete(e.pointerId)
    if (pointers.size === 0) {
      // Tapping (not dragging) an existing text layer re-opens editing.
      if (gesture?.kind === 'drag' && !gesture.moved && gesture.layer.type === 'text') {
        openTextUI(gesture.layer)
      }
      gesture = null
    }
  }
  canvas.addEventListener('pointerup', lift)
  canvas.addEventListener('pointercancel', lift)

  canvas.addEventListener('wheel', (e) => {
    if (!selected || cropMode) return
    e.preventDefault()
    selected.scale = clamp(
      selected.scale * Math.exp(-e.deltaY * WHEEL_SENSITIVITY),
      MIN_LAYER_SCALE, MAX_LAYER_SCALE)
    repaint()
  }, { passive: false })

  /* ------------------------------------------------------ export & close */
  /** Flatten one photo state to a bounded JPEG data URL (null on failure). */
  function flattenState (s, maxEdge, quality) {
    const scale = Math.min(1, maxEdge / Math.max(s.base.width, s.base.height))
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(s.base.width * scale))
    out.height = Math.max(1, Math.round(s.base.height * scale))
    const c = out.getContext('2d')
    c.imageSmoothingQuality = 'high'
    c.setTransform(scale, 0, 0, scale, 0, 0)
    c.drawImage(s.base, 0, 0)
    drawStrokes(c, s.strokes)
    drawLayers(c, s.layers)
    try { return out.toDataURL('image/jpeg', quality) } catch { return null }  // tainted/OOM
  }

  function doSend () {
    if (settled) return
    if (cropMode) exitCrop()
    selected = null
    states[cur].caption = capInput.value
    const preset = hd ? PHOTO_HD : PHOTO_STD
    const photos = []
    for (const s of states) {
      const url = flattenState(s, preset.edge, preset.q)
      if (url) photos.push({ dataURL: url, caption: s.caption.trim() })
    }
    if (!photos.length) { finish(null); return }
    // dataURL/caption mirror photos[0] so single-photo callers keep working.
    finish({ photos, dataURL: photos[0].dataURL, caption: photos[0].caption, privatePhoto })
  }

  /** X (and ESC): a dirty editor always asks — never a silent discard. */
  function requestClose () {
    if (!dirty()) { finish(null); return }
    if (back.querySelector('.pe-confirm')) return
    const sheet = el('div', { class: 'pe-confirm' }, [
      el('div', { class: 'pe-csheet' }, [
        el('div', { class: 'pe-ctitle', text: states.length > 1 ? 'Discard these photos?' : 'Discard this photo?' }),
        el('button', { class: 'pe-cbtn pe-cdanger', type: 'button', text: 'Discard', onclick: () => finish(null) }),
        el('button', { class: 'pe-cbtn', type: 'button', text: 'Keep editing', onclick: () => sheet.remove() })
      ])
    ])
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove() })
    back.appendChild(sheet)
  }
  xBtn.addEventListener('click', requestClose)

  function onKey (e) {
    if (e.key !== 'Escape') return
    if (textUI.style.display !== 'none') { commitText(); return }
    if (stickerOpen) { toggleStickers(false); return }
    if (cropMode) { exitCrop(); return }
    requestClose()
  }

  function onResize () { resizeCanvas() }

  function finish (value) {
    if (settled) return
    settled = true
    if (activeCancel === cancel) activeCancel = null
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    back.remove()
    resolve(value)
  }
  const cancel = () => finish(null)
  activeCancel = cancel

  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  document.body.appendChild(back)
  resizeCanvas()
}
